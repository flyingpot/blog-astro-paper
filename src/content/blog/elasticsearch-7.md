---
author: Fan Jingbo
pubDatetime: 2021-12-06T16:00:00Z
title: 【Elasticsearch源码解析】通信模块篇——ES中对Transport连接是如何管理的
postSlug: elasticsearch-network3
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: 节点间的连接又是如何管理的呢？本文就通过源码梳理这一部分内容
---

通过上一篇文章，节点间通讯的数据流动已经搞清楚了：

1. 所有节点在启动时都注册上了所有 TransportAction 对应的 RequestHandler
2. 发送节点使用特定 action 向接收节点发送请求，发送前注册对应的 ResponseHandler，通过 requestId 作为 key 存储在发送节点内存中。requestId 通过网络发送给接收节点
3. 接收节点收到请求，通过 action 拿到对应的 RequestHandler 响应请求。requestId 通过网络发送回发送节点
4. 发送节点收到请求，通过 requestId 拿到 ResponseHandler 处理 response

那么，节点间的连接又是如何管理的呢？本文就通过源码梳理这一部分内容

## 一、ConnectionManager 连接管理器

发送请求时不会重新建立连接，而是会从连接管理器中拿到一个连接来使用：

```java
    /**
     * Returns either a real transport connection or a local node connection if we are using the local node optimization.
     * @throws NodeNotConnectedException if the given node is not connected
     */
    public Transport.Connection getConnection(DiscoveryNode node) {
        if (isLocalNode(node)) {
            return localNodeConnection;
        } else {
            return connectionManager.getConnection(node);
        }
    }
```

节点间通过 openConnection 和 connectToNode 来建立连接，区别是 openConnection 建立的连接不能通过 ConnectionManager 管理，需要发起连接的节点自己管理连接，而 connectToNode 方法建立的连接会通过 ConectionManager 管理。

建立连接会从两个类中发起（这里不考虑 7 版本前使用的 Discovery 模块类 ZenDiscovery），一个是 Coordinator：集群在选主过程中会建立连接，另一个是 NodeConnectionsService：这个的类目的就是保持节点间的连接，当节点连接断开时，会自动重试连接。

因此，节点间的连接可以认为是一直存在的，当需要 Transport 请求时，从 ConnectionManager 中拿到一个连接 Connection 使用就好。

## 二、Connection 和 NodeChannels

跟踪 TransportService 中的 sendRequest 代码，最终是通过远端节点对应的 Connection 实例来发送请求的：

```java
connection.sendRequest(requestId, action, request, options);
```

Connection 是一个接口，看下实现，发现可能是 TcpTransport 中的 NodeChannels。跟一下代码发现确实是（代码比较深，这里文字描述下）：

1. 在 ClusterConnectionManager 的 connectToNode 方法中注册了一个 listener 回调
2. 根据 ConnectionProfile 的配置初始化所有 channels，默认有 13 个连接，分别为以下几组
   | recovery | bulk | reg | state | ping |
   | --------- | ---- | --- | ----- | ---- |
   | 3 | 3 | 6 | 1 | 1 |
3. 确认所有连接之后，发送一个握手请求（ChannelConnectedListener）后完成连接初始化，调用 listener.onResponse(nodeChannels)完成回调
4. connectToNode 拿到 channels 将其注册到 map 中，方便连接重用

所以实际 sendRequest 调用的是 NodeChannels 的 sendRequest 方法，在序列化网络通信前，还判断了一下传入的 options 参数属于 channel 的哪一个类型，从连接池中选择对应类型的连接使用。

```java
public TcpChannel channel(TransportRequestOptions.Type type) {
    ConnectionProfile.ConnectionTypeHandle connectionTypeHandle = typeMapping.get(type);
    if (connectionTypeHandle == null) {
        throw new IllegalArgumentException("no type channel for [" + type + "]");
    }
    return connectionTypeHandle.getChannel(channels);
}
```
