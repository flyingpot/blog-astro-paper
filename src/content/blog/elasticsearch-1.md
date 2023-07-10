---
author: Fan Jingbo
pubDatetime: 2021-04-09T16:00:00Z
title: 【Elasticsearch源码解析】通信模块篇——ES中对REST请求的处理浅析
postSlug: elasticsearch-network1
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: 从本文开始，我打算开一个新坑，分模块来讲一讲ES的源码。本系列的目的主要是方便我自己对于ES源码的理解进行梳理和总结。当然，如果有人能读到我的解析并能从中获益就更好了。本系列文章会基于ES在github上的最新开源代码，版本是7.12.0
---

### 一、前言

从本文开始，我打算开一个新坑，分模块来讲一讲 ES 的源码。本系列的目的主要是方便我自己对于 ES 源码的理解进行梳理和总结。当然，如果有人能读到我的解析并能从中获益就更好了。本系列文章会基于 ES 在 github 上的最新开源代码，版本是 7.12.0。

### 二、Elasticsearch 的模块化

在开源项目索引网站 openhub 上可以查到，目前 ES 的源码行数有 200w 行。在 Java 代码世界里也算是一个庞然大物级别的项目（Spring 框架总代码量 138w 行）。ES 用 200w 行代码构建了一个带分布式的全文搜索引擎，具有很好的定制化能力，性能良好，并且开箱即用。

Elasticsearch 的模块化做的很不错，不同功能用不同的 service 或者 module 实现。基于完善的模块化，Elasticsearch 从源码中放开了对于模块的自定义能力，支持通过插件包的方式对于各模块进行定制化。可以定制的功能非常丰富，从底层的 search engine 到上层的配置，不需要改动 ES 的代码就能增加自定义功能。比如说，Amazon 开源的 Open Distro 项目就包括很多定制化插件，而 ES 官方的商业 X-Pack 版本也是由一系列的插件包组成的。

本文就从 ES 的通信模块开始，来详细讲解下 ES 源码是如何实现通信功能的。

### 三、网络模块初始化

ES 的网络请求分为两类：一个是客户端连接集群节点用的 Rest 请求，走 HTTP 协议，另一个是集群节点之间的 Transport 请求，走 TCP 协议。接下来看代码，直接从 ES 通信模块类 NetworkModule 看起：

```java

        /**
         * Creates a network module that custom networking classes can be plugged into.
         * @param settings The settings for the node
         */
        public NetworkModule(Settings settings, List<NetworkPlugin> plugins, ThreadPool threadPool,
                             BigArrays bigArrays,
                             PageCacheRecycler pageCacheRecycler,
                             CircuitBreakerService circuitBreakerService,
                             NamedWriteableRegistry namedWriteableRegistry,
                             NamedXContentRegistry xContentRegistry,
                             NetworkService networkService, HttpServerTransport.Dispatcher dispatcher,
                             ClusterSettings clusterSettings) {
            this.settings = settings;
            for (NetworkPlugin plugin : plugins) {
                Map<String, Supplier<HttpServerTransport>> httpTransportFactory = plugin.getHttpTransports(settings, threadPool, bigArrays,
                    pageCacheRecycler, circuitBreakerService, xContentRegistry, networkService, dispatcher, clusterSettings);
                for (Map.Entry<String, Supplier<HttpServerTransport>> entry : httpTransportFactory.entrySet()) {
                    // Rest请求handler注册
                    registerHttpTransport(entry.getKey(), entry.getValue());
                }
                Map<String, Supplier<Transport>> transportFactory = plugin.getTransports(settings, threadPool, pageCacheRecycler,
                    circuitBreakerService, namedWriteableRegistry, networkService);
                for (Map.Entry<String, Supplier<Transport>> entry : transportFactory.entrySet()) {
                    // Transport请求handler注册
                    registerTransport(entry.getKey(), entry.getValue());
                }
                List<TransportInterceptor> transportInterceptors = plugin.getTransportInterceptors(namedWriteableRegistry,
                    threadPool.getThreadContext());
                for (TransportInterceptor interceptor : transportInterceptors) {
                    registerTransportInterceptor(interceptor);
                }
            }
        }
```

其中遍历了实现 NetworkPlugin 的插件，并分别注册了 Rest 和 Transport 的 handler，实际使用时，取出来具体的 handler 来初始化。在 ES 代码中，以 Plugin 结尾的都是插件要实现的一些重要接口，需要实现哪种功能就去实现接口中定义的对应方法就好。其中 NetworkPlugin 中就定义了以下两个重要方法：

```java
    /**
     * Returns a map of {@link Transport} suppliers.
     * See {@link org.elasticsearch.common.network.NetworkModule#TRANSPORT_TYPE_KEY} to configure a specific implementation.
     */
    default Map<String, Supplier<Transport>> getTransports(Settings settings, ThreadPool threadPool, PageCacheRecycler pageCacheRecycler,
                                                           CircuitBreakerService circuitBreakerService,
                                                           NamedWriteableRegistry namedWriteableRegistry, NetworkService networkService) {
        return Collections.emptyMap();
    }

    /**
     * Returns a map of {@link HttpServerTransport} suppliers.
     * See {@link org.elasticsearch.common.network.NetworkModule#HTTP_TYPE_SETTING} to configure a specific implementation.
     */
    default Map<String, Supplier<HttpServerTransport>> getHttpTransports(Settings settings, ThreadPool threadPool, BigArrays bigArrays,
                                                                         PageCacheRecycler pageCacheRecycler,
                                                                         CircuitBreakerService circuitBreakerService,
                                                                         NamedXContentRegistry xContentRegistry,
                                                                         NetworkService networkService,
                                                                         HttpServerTransport.Dispatcher dispatcher,
                                                                         ClusterSettings clusterSettings) {
        return Collections.emptyMap();
    }
```

分别对应了 Rest 和 Transport 的 handler 实现。

在节点初始化时，会通过下面这个方法获取 Rest 接口的 handler（Transport 接口同理），依次读取 http.type 和 http.default.type 这两个配置。而 ES 默认的网络实现是通过 transport-netty4 插件实现的，在这个插件中，会设置 http.default.type 配置。当用户没有自制自己的网络模块时，就会使用默认的 netty 实现。如果用户需要自定义时，只需要在插件中设置自己的网络模块名字，然后修改 ES 的 http.type 配置就好。

```java
       public Supplier<HttpServerTransport> getHttpServerTransportSupplier() {
        final String name;
        if (HTTP_TYPE_SETTING.exists(settings)) {
            name = HTTP_TYPE_SETTING.get(settings);
        } else {
            name = HTTP_DEFAULT_TYPE_SETTING.get(settings);
        }
        final Supplier<HttpServerTransport> factory = transportHttpFactories.get(name);
        if (factory == null) {
            throw new IllegalStateException("Unsupported http.type [" + name + "]");
        }
        return factory;
    }
```

### 四、Rest 请求处理流程

接下来我们一步一步分析 ES 时如何处理 Rest 请求的.

首先从入口看起，在 transport-netty4 插件中通过 getHttpTransports 方法注册了 Netty4HttpServerTransport 类：

```java
    @Override
    public Map<String, Supplier<HttpServerTransport>> getHttpTransports(Settings settings, ThreadPool threadPool, BigArrays bigArrays,
                                                                        PageCacheRecycler pageCacheRecycler,
                                                                        CircuitBreakerService circuitBreakerService,
                                                                        NamedXContentRegistry xContentRegistry,
                                                                        NetworkService networkService,
                                                                        HttpServerTransport.Dispatcher dispatcher,
                                                                        ClusterSettings clusterSettings) {
        return Collections.singletonMap(NETTY_HTTP_TRANSPORT_NAME,
            () -> new Netty4HttpServerTransport(settings, networkService, bigArrays, threadPool, xContentRegistry, dispatcher,
                clusterSettings, getSharedGroupFactory(settings)));
    }
```

这其中做了 Netty 的初始化工作，然后在 pipeline 中增加了一个 handler，对应类是 Netty4HttpRequestHandler，这个类继承了 Netty 中的抽象类 SimpleChannelInboundHandler，只需要实现 channelRead0 这个抽象方法就能拿到从网络 IO 中反序列化出来的 HttpRequest 对象。

接下来就与 Netty 无关了，是 ES 对于请求的处理过程。在抽象类 AbstractHttpServerTransport 中做了 request 和 channel 的进一步包装，然后将请求分发给 RestController，在这个类中做了实际的 HTTP 请求 header 校验和最重要的部分——URL 匹配。URL 匹配使用了前缀树算法，查找方法如下：

```java
    /**
     * Returns an iterator of the objects stored in the {@code PathTrie}, using
     * all possible {@code TrieMatchingMode} modes. The {@code paramSupplier}
     * is called between each invocation of {@code next()} to supply a new map
     * of parameters.
     */
    public Iterator<T> retrieveAll(String path, Supplier<Map<String, String>> paramSupplier) {
        return new Iterator<>() {

            private int mode;

            @Override
            public boolean hasNext() {
                return mode < TrieMatchingMode.values().length;
            }

            @Override
            public T next() {
                if (hasNext() == false) {
                    throw new NoSuchElementException("called next() without validating hasNext()! no more modes available");
                }
                return retrieve(path, paramSupplier.get(), TrieMatchingMode.values()[mode++]);
            }
        };
    }
```

然后在 TrieMatchingMode 这个枚举类中定义了匹配的规则，每次遍历完后，mode 会自增，就会使用下一个规则，直到所有规则匹配完毕：

```java
    enum TrieMatchingMode {
        /*
         * Retrieve only explicitly mapped nodes, no wildcards are
         * matched.
         */
        EXPLICIT_NODES_ONLY,
        /*
         * Retrieve only explicitly mapped nodes, with wildcards
         * allowed as root nodes.
         */
        WILDCARD_ROOT_NODES_ALLOWED,
        /*
         * Retrieve only explicitly mapped nodes, with wildcards
         * allowed as leaf nodes.
         */
        WILDCARD_LEAF_NODES_ALLOWED,
        /*
         * Retrieve both explicitly mapped and wildcard nodes.
         */
        WILDCARD_NODES_ALLOWED
    }
```

其中每个 URL 都与具体的 RestAction 对应，当匹配上时，就会将请求分发给实际的 action 来处理。参考一下最简单的 RestCatAction：

```java
public class RestCatAction extends BaseRestHandler {

    private static final String CAT = "=^.^=";
    private static final String CAT_NL = CAT + "\n";
    private final String HELP;

    public RestCatAction(List<AbstractCatAction> catActions) {
        StringBuilder sb = new StringBuilder();
        sb.append(CAT_NL);
        for (AbstractCatAction catAction : catActions) {
            catAction.documentation(sb);
        }
        HELP = sb.toString();
    }

    @Override
    public List<Route> routes() {
        return List.of(new Route(GET, "/_cat"));
    }

    @Override
    public String getName() {
        return "cat_action";
    }

    @Override
    public RestChannelConsumer prepareRequest(final RestRequest request, final NodeClient client) throws IOException {
        return channel -> channel.sendResponse(new BytesRestResponse(RestStatus.OK, HELP));
    }

}
```

这个类实现了三个方法：

1. getName 只用在\_nodes/usage 接口中，只要返回一个名字就好
2. routes 定义了 action 对应的 Rest 请求方法和 URL
3. prepareRequest 定义了实际处理请求的内容，注意最后返回一个 consumer，实际执行是在 BaseRestHandler 中：

```java
    @Override
    public final void handleRequest(RestRequest request, RestChannel channel, NodeClient client) throws Exception {
        // prepare the request for execution; has the side effect of touching the request parameters
        final RestChannelConsumer action = prepareRequest(request, client);

        // validate unconsumed params, but we must exclude params used to format the response
        // use a sorted set so the unconsumed parameters appear in a reliable sorted order
        final SortedSet<String> unconsumedParams =
            request.unconsumedParams().stream().filter(p -> !responseParams().contains(p)).collect(Collectors.toCollection(TreeSet::new));

        // validate the non-response params
        if (!unconsumedParams.isEmpty()) {
            final Set<String> candidateParams = new HashSet<>();
            candidateParams.addAll(request.consumedParams());
            candidateParams.addAll(responseParams());
            throw new IllegalArgumentException(unrecognized(request, unconsumedParams, candidateParams, "parameter"));
        }

        if (request.hasContent() && request.isContentConsumed() == false) {
            throw new IllegalArgumentException("request [" + request.method() + " " + request.path() + "] does not support having a body");
        }

        usageCount.increment();
        // execute the action
        action.accept(channel);
    }
```

### 五、总结

本文介绍了 ES 的通信模块，并梳理了整个 Rest 请求的处理流程：从节点启动开始，Netty 接受到用户发送的 Rest 请求，解析并包装成对象，做 HTTP 相关校验，根据 HTTP 方法和 URL 匹配 RestAction，action 处理请求并返回。
文章的第二部分会梳理 Transport 请求的处理，敬请期待。
