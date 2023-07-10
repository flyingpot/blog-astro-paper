---
author: Fan Jingbo
pubDatetime: 2021-04-14T16:00:00Z
title: 【Elasticsearch源码解析】通信模块篇——ES中对Transport请求的处理浅析
postSlug: elasticsearch-network2
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: 书接上文，本文继续讲解ES的通信模块。第一部分介绍了ES的总体通信模块组成，并详细介绍了ES的Rest通信模块部分。本文就来介绍ES的transport通信模块部分。
---

书接上文，本文继续讲解 ES 的通信模块。第一部分介绍了 ES 的总体通信模块组成，并详细介绍了 ES 的 Rest 通信模块部分。本文就来介绍 ES 的 transport 通信模块部分。

### 一、底层 Netty 部分

还是看 ES 的底层默认 Netty 实现部分，Netty4Transport 中实现了 transport 的初始化。这里与 Rest 部分差别如下：

| Rest                          | Transport              |
| ----------------------------- | ---------------------- |
| 要实现 TCP 层和 HTTP 层的处理 | 只要实现 TCP 层处理    |
| 只需要实现服务端              | 需要实现客户端和服务端 |

Rest 请求的处理，作为 ES 服务的入口，需要实现 HTTP 协议的服务端，而集群的内部请求既需要发送也要接受，所以需要实现服务端和客户端两部分。而在协议上为了省略 HTTP 协议解析的消耗，可以直接在 TCP 层上做，以提高通信效率。

与 Netty4HttpServerTransport 类似，协议层面的解析都是在这两个类中做的，而实际解析出来的对象是在父类中处理的。Netty4Transport 父类 TcpTransport 的构造函数：

```java
    public TcpTransport(Settings settings, Version version, ThreadPool threadPool, PageCacheRecycler pageCacheRecycler,
                        CircuitBreakerService circuitBreakerService, NamedWriteableRegistry namedWriteableRegistry,
                        NetworkService networkService) {
        this.settings = settings;
        this.profileSettings = getProfileSettings(settings);
        this.version = version;
        this.threadPool = threadPool;
        this.pageCacheRecycler = pageCacheRecycler;
        this.circuitBreakerService = circuitBreakerService;
        this.networkService = networkService;
        String nodeName = Node.NODE_NAME_SETTING.get(settings);
        BigArrays bigArrays = new BigArrays(pageCacheRecycler, circuitBreakerService, CircuitBreaker.IN_FLIGHT_REQUESTS);

        this.outboundHandler = new OutboundHandler(nodeName, version, statsTracker, threadPool, bigArrays);
        this.handshaker = new TransportHandshaker(version, threadPool,
            (node, channel, requestId, v) -> outboundHandler.sendRequest(node, channel, requestId,
                TransportHandshaker.HANDSHAKE_ACTION_NAME, new TransportHandshaker.HandshakeRequest(version),
                TransportRequestOptions.EMPTY, v, false, true));
        this.keepAlive = new TransportKeepAlive(threadPool, this.outboundHandler::sendBytes);
        this.inboundHandler = new InboundHandler(threadPool, outboundHandler, namedWriteableRegistry, handshaker, keepAlive,
            requestHandlers, responseHandlers);
    }
```

主要看最后的几行：入方向的 handler 是 inboundHandler，出方向的 handler 是 outboundHandler。还能看到 handshaker 和 keeplive，这两个分别做两节点之间的握手和 TCP 保活的，后续有机会再讲它们。

### 二、入方向

首先看下 inboundHandler，处理请求的方法是 inboundMessage：

```java
    void inboundMessage(TcpChannel channel, InboundMessage message) throws Exception {
        final long startTime = threadPool.relativeTimeInMillis();
        channel.getChannelStats().markAccessed(startTime);
        TransportLogger.logInboundMessage(channel, message);

        if (message.isPing()) {
            keepAlive.receiveKeepAlive(channel);
        } else {
            messageReceived(channel, message, startTime);
        }
    }
```

如图是核心方法 inboundMessage 的调用关系图：

![](/assets/2021-04-18-10-17-22.png)

client 和 server 两部分都注册了这个 handler，因为客户端和服务端都需要处理入方向的请求。

继续看 messageReceived 方法：

```java
    private void messageReceived(TcpChannel channel, InboundMessage message, long startTime) throws IOException {
		...
        final Header header = message.getHeader();
		if (header.isRequest()) {
			handleRequest(channel, header, message);
		} else {
			handler = responseHandlers.onResponseReceived(requestId, messageListener);
			if (handler != null) {
				handleResponse(remoteAddress, EMPTY_STREAM_INPUT, handler);
			}
		}
	}
```

这块代码我简化了很多，只留下了核心逻辑。根据传入的 header 判断消息是一个 request 还是 response，是 response 的话就调用发送请求时注册在 responseHandlers 中的 hander 处理，这里会跟一个 requestId 对应，是 request 的话就继续处理：

```java
    private <T extends TransportRequest> void handleRequest(TcpChannel channel, Header header, InboundMessage message) throws IOException {
        final String action = header.getActionName();
        final StreamInput stream = namedWriteableStream(message.openOrGetStreamInput());
        final RequestHandlerRegistry<T> reg = requestHandlers.getHandler(action);
        final T request = reg.newRequest(stream);
        request.remoteAddress(new TransportAddress(channel.getRemoteAddress()));
        final String executor = reg.getExecutor();
        handler.messageReceived(request, taskTransportChannel, task);
    }
```

这里同样简化，实际上的处理工作是从 requestHandlers 里面拿出来的。如果要实现一个新的 Transport 请求，需要预先注册相应的 requestHandler:

```java
    public <Request extends TransportRequest> void registerRequestHandler(String action, String executor,
                                                                          Writeable.Reader<Request> requestReader,
                                                                          TransportRequestHandler<Request> handler) {
        validateActionName(action);
        handler = interceptor.interceptHandler(action, executor, false, handler);
        RequestHandlerRegistry<Request> reg = new RequestHandlerRegistry<>(
            action, requestReader, taskManager, handler, executor, false, true);
        transport.registerRequestHandler(reg);
    }
```

- 参数 action 对应 handler 的名字
- 参数 executor 对应了线程的类型，执行时会从线程池中拿相应类型的线程来处理 request
- 参数 requestReader 对应请求的 reader，服务端根据 reader 来从网络 IO 流中反序列化出相应对象
- 参数 handler 对应实际的 handler，做实际的处理工作

列举起来不是很清晰，举个例子：

```java
        registerRequestHandler(
            HANDSHAKE_ACTION_NAME,
            ThreadPool.Names.SAME,
            HandshakeRequest::new,
            (request, channel, task) -> channel.sendResponse(
                new HandshakeResponse(localNode.getVersion(), Build.CURRENT.hash(), localNode, clusterName)));
```

这是一个握手 action 的注册方法，处理方法是返回 HandshakeResponse，包含了服务端节点的一些信息。根据这些内容，开发者就可以很简单地定义出自己的 action。实际上，ES 源码做了更细致地封装，根据具体需求来实现 TransportAction 的一些子类（定义在 org.elasticsearch.action.support 里面的包中）即可。

注意，handleRequest 时需要将 requestId 传回请求节点，以便请求节点能找到对应的 handler。

### 三、出方向

出方向这里就简单很多了，我们这次反方向来看。调用的入口是 TransportService 的 sendRequest，然后是 sendRequestInternal。比较重要的是这一行代码：

```java
final long requestId = responseHandlers.add(new Transport.ResponseContext<>(responseHandler, connection, action));
```

这里就可以和上文对应上了，在发送请求时注册了一个对应 requestId 的 responseHandler，然后在接收请求时拿出来 requestId 对应 handler。

然后就到了 OutboundHandler 类，这里其实除了 sendRequest 还有 sendResponse 方法。因为作为服务端的节点要发送 response 给客户端节点。这里其实就是简单的序列化操作。

### 四、总结

本文简单梳理了 transport 模块的定义，从 Netty 底层到出入两个方向的逻辑。Transport 部分还没有结束，下一篇打算介绍一下连接管理的内容。
