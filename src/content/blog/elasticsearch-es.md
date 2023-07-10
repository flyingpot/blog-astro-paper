---
author: Fan Jingbo
pubDatetime: 2021-12-22T15:00:00Z
title: 【Elasticsearch源码解析】通信模块篇——ES中两个特殊的通信组件（握手和保活）
postSlug: elasticsearch-network4
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: 如果你仔细看ES源码的TcpTransport类构造函数，会发现其中除了有入方向和出方向的handler之外，还定义了两个特殊的类TransportHandshaker和TransportKeepAlive
---

## 一、前言

如果你仔细看 ES 源码的 TcpTransport 类构造函数，会发现其中除了有入方向和出方向的 handler 之外，还定义了两个特殊的类 TransportHandshaker 和 TransportKeepAlive：

```java
this.outboundHandler = new OutboundHandler(nodeName, version, features, statsTracker, threadPool, bigArrays);
this.handshaker = new TransportHandshaker(version, threadPool,
    (node, channel, requestId, v) -> outboundHandler.sendRequest(node, channel, requestId,
        TransportHandshaker.HANDSHAKE_ACTION_NAME, new TransportHandshaker.HandshakeRequest(version),
        TransportRequestOptions.EMPTY, v, false, true));
this.keepAlive = new TransportKeepAlive(threadPool, this.outboundHandler::sendBytes);
this.inboundHandler = new InboundHandler(threadPool, outboundHandler, namedWriteableRegistry, handshaker, keepAlive,
    requestHandlers, responseHandlers);
```

这两个类承担了很重要的节点间通信任务——握手和保活

## 二、握手

### 握手的作用

首先先分析一下 ES 节点间握手的作用，上一篇关于连接管理的文章提到过，节点之前初始化连接之后，节点会向另一个节点发出握手请求。所以其实握手很直接的作用就是，发送一个实际的连接确定是否两节点之间在应用层面上可以通信。换句话说就是，发送请求的节点要确认收到请求的节点是否理解。这个的前提肯定是发送的节点能收到响应，其次就是确认一下是否两个节点的 ES 版本是否兼容。

接下来分析一下相关代码。

### 源码分析

1. 发送请求

主要做了两件事（去掉部分代码）：

```java
    // TransportHandshaker.java
    void sendHandshake(long requestId, DiscoveryNode node, TcpChannel channel, TimeValue timeout, ActionListener<Version> listener) {
        // 在发送节点存储将来收到响应时的handler，根据requestId确认
        final HandshakeResponseHandler handler = new HandshakeResponseHandler(requestId, version, listener);
        pendingHandshakes.put(requestId, handler);

        // 将发送方version带入请求并发出
        final Version minCompatVersion = version.minimumCompatibilityVersion();
        handshakeRequestSender.sendRequest(node, channel, requestId, minCompatVersion);
    }

```

2. 接收请求并响应

```java
    // InboundHandler.java
    private <T extends TransportRequest> void handleRequest(TcpChannel channel, Header header, InboundMessage message) throws IOException {
        final String action = header.getActionName();
        final long requestId = header.getRequestId();
        final Version version = header.getVersion();
        // 当是握手请求时
        if (header.isHandshake()) {
            final StreamInput stream = namedWriteableStream(message.openOrGetStreamInput());
            final TransportChannel transportChannel = new TcpTransportChannel(outboundHandler, channel, action, requestId, version,
                header.getFeatures(), header.isCompressed(), header.isHandshake(), message.takeBreakerReleaseControl());
            try {
                // 响应，代码见下方
                handshaker.handleHandshake(transportChannel, requestId, stream);
            } catch (Exception e) {
                // 当响应失败，且版本匹配时，将异常报回发送节点
                if (Version.CURRENT.isCompatible(header.getVersion())) {
                    sendErrorResponse(action, transportChannel, e);
                } else {
                    logger.warn(new ParameterizedMessage(
                        "could not send error response to handshake received on [{}] using wire format version [{}], closing channel",
                        channel, header.getVersion()), e);
                    channel.close();
                }
            }
        }
    }
```

```java
    // TransportHandshaker.java
    void handleHandshake(TransportChannel channel, long requestId, StreamInput stream) throws IOException {
        HandshakeRequest handshakeRequest = new HandshakeRequest(stream);
        final int nextByte = stream.read();
        if (nextByte != -1) {
            throw new IllegalStateException("Handshake request not fully read for requestId [" + requestId + "], action ["
                + TransportHandshaker.HANDSHAKE_ACTION_NAME + "], available [" + stream.available() + "]; resetting");
        }
        // 将version响应给发送方
        channel.sendResponse(new HandshakeResponse(this.version));
    }
```

3. 发送方解析响应

根据 requestId 拿到第一步注册的 handler，处理响应

```java
    @Override
    public void handleResponse(HandshakeResponse response) {
        if (isDone.compareAndSet(false, true)) {
            Version version = response.responseVersion;
            // 判断version是否适配
            if (currentVersion.isCompatible(version) == false) {
                listener.onFailure(new IllegalStateException("Received message from unsupported version: [" + version
                    + "] minimal compatible version is: [" + currentVersion.minimumCompatibilityVersion() + "]"));
            } else {
                listener.onResponse(version);
            }
        }
    }
```

## 三、保活

### 保活的作用

握手之后，节点间就需要通过保活来保持连接。虽然 Netty 中有 SO_KEEPALIVE 开关来保持 TCP 的长连接，但是应用层面的保活还是必要的。毕竟 TCP 是传输层，并不能保证应用的连通性。

### 源码分析

1. 初始化

```java
    // TransportKeepAlive.java
    void registerNodeConnection(List<TcpChannel> nodeChannels, ConnectionProfile connectionProfile) {
        // 获取到ping的间隔
        TimeValue pingInterval = connectionProfile.getPingInterval();
        if (pingInterval.millis() < 0) {
            return;
        }

        // 获取到一个定时ping的工具类
        final ScheduledPing scheduledPing = pingIntervals.computeIfAbsent(pingInterval, ScheduledPing::new);
        scheduledPing.ensureStarted();

        // 每个channel都需要定时ping
        for (TcpChannel channel : nodeChannels) {
            scheduledPing.addChannel(channel);
            channel.addCloseListener(ActionListener.wrap(() -> scheduledPing.removeChannel(channel)));
        }
    }
```

2. 定时检查

```java
        // TransportKeepAlive.java
        @Override
        protected void doRunInLifecycle() {
            for (TcpChannel channel : channels) {
                if (needsKeepAlivePing(channel)) {
                    sendPing(channel);
                }
            }
            this.lastPingRelativeMillis = threadPool.relativeTimeInMillis();
        }

        // 先判断需不需要发送，根据发送方在上次ping请求之后是否有收到或发送过任何请求，如果没有再发送ping
        private boolean needsKeepAlivePing(TcpChannel channel) {
            TcpChannel.ChannelStats stats = channel.getChannelStats();
            long accessedDelta = stats.lastAccessedTime() - lastPingRelativeMillis;
            return accessedDelta <= 0;
        }
```

3. 发送 ping 请求

```java
    // TransportKeepAlive.java
    private void sendPing(TcpChannel channel) {
        // 发送ping请求，实际调用的是sendBytes，发送了PING_MESSAGE
        pingSender.apply(channel, PING_MESSAGE, new ActionListener<Void>() {

            @Override
            public void onResponse(Void v) {
                successfulPings.inc();
            }

            @Override
            public void onFailure(Exception e) {
                if (channel.isOpen()) {
                    logger.debug(() -> new ParameterizedMessage("[{}] failed to send transport ping", channel), e);
                    failedPings.inc();
                } else {
                    logger.trace(() -> new ParameterizedMessage("[{}] failed to send transport ping (channel closed)", channel), e);
                }
            }
        });
    }

    // 发送的内容已经静态初始化好了，实际上就是ES的字节形式加上-1的size
    static final int PING_DATA_SIZE = -1;

    private static final BytesReference PING_MESSAGE;

    static {
        try (BytesStreamOutput out = new BytesStreamOutput()) {
            out.writeByte((byte) 'E');
            out.writeByte((byte) 'S');
            out.writeInt(PING_DATA_SIZE);
            PING_MESSAGE = out.copyBytes();
        } catch (IOException e) {
            throw new AssertionError(e.getMessage(), e); // won't happen
        }
    }
```

4. 响应 ping 请求

```java
    void receiveKeepAlive(TcpChannel channel) {
		// 只有当节点是channel的server端时才返回ping请求，因为是client端开始的ping请求
        // 流程是这样的：client --ping--> server，server --ping--> client
        if (channel.isServerChannel()) {
            sendPing(channel);
        }
    }
```

## 四、两者的联系

在握手确认两个节点之间兼容之后，channel 注册到保活服务中去定时发送 ping 请求。我们看回连接管理器初始化 channel 完成后的代码：

```java
// 执行握手
executeHandshake(node, handshakeChannel, connectionProfile, ActionListener.wrap(version -> {
    final long connectionId = outboundConnectionCount.incrementAndGet();
    logger.debug("opened transport connection [{}] to [{}] using channels [{}]", connectionId, node, channels);
    NodeChannels nodeChannels = new NodeChannels(node, channels, connectionProfile, version);
    long relativeMillisTime = threadPool.relativeTimeInMillis();
    // 这里可以看到当任何一个channel close时，整个NodeChannels就会close，也就是两节点Connection断掉了，接下来就需要NodeConnectionsService去重试连接
    nodeChannels.channels.forEach(ch -> {
        // Mark the channel init time
        ch.getChannelStats().markAccessed(relativeMillisTime);
        ch.addCloseListener(ActionListener.wrap(nodeChannels::close));
    });
    // 所有channel注册到保活服务中
    keepAlive.registerNodeConnection(nodeChannels.channels, connectionProfile);
    nodeChannels.addCloseListener(new ChannelCloseLogger(node, connectionId, relativeMillisTime));
    // 这里是连接管理器connectToNode的回调，返回NodeChannels作为Connection给连接管理器
    listener.onResponse(nodeChannels);
}, e -> closeAndFail(e instanceof ConnectTransportException ?
    e : new ConnectTransportException(node, "general node connection failure", e))));
```
