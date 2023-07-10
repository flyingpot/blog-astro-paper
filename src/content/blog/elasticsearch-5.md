---
author: Fan Jingbo
pubDatetime: 2021-07-28T16:00:00Z
title: 【Elasticsearch源码解析】线程池篇——线程上下文ThreadContext
postSlug: elasticsearch-threadpool2
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: 上一篇文章讲了一下ES源码中线程池实现和具体的应用，本文会介绍一下ES中封装的线程上下文实现ThreadContext
---

### 一、前言

上一篇文章讲了一下 ES 源码中线程池实现和具体的应用，本文会介绍一下 ES 中封装的线程上下文实现 ThreadContext

### 二、ThreadLocal 是什么

JDK 自带一个线程上下文 ThreadLocal 的实现，有了 ThreadLocal，用户可以定义出来仅在同一个线程共享的参数。在一些场景（比如 Web 服务）中，同一个请求是由同一个线程处理的，可以在这个请求里面通过 ThreadLocal 共享参数，不需要把参数在方法之间互相传递，非常方便。比如 SpringMVC 中的 RequestContextHolder。

其实原理很简单，每一个 Thread 对象里面都会维护一个 ThreadLocal.ThreadLocalMap 对象，当调用 ThreadLocal 的 set 方法时，其实就是把 ThreadLocal 对象作为 key，set 的值作为 value 放到 ThreadLocalMap 中。同理，get 就是拿到 map 中的对应 value。

```java
ThreadLocal<String> requestId = new ThreadLocal<>();
requestId.set("test");
requestId.get("test");
```

但是，ThreadLocal 也有一些问题，比如我需要在当前线程中新起一个线程做异步操作，那么使用 ThreadLocal 无法把当前线程保存的参数共享给新线程。比如这个代码段：

```java
ThreadLocal<String> requestId = new ThreadLocal<>();
requestId.set("test");
new Thread((
        () -> System.out.println("In new thread, requestId is: " + requestId.get())
)).start();
System.out.println("In current thread, requestId is: " + requestId.get());
```

运行结果为：

> In new thread, requestId is: null
> In current thread, requestId is: test

但是这个问题也并非没有解决方法，阿里的[transmittable-thread-local](https://github.com/alibaba/transmittable-thread-local)就是为了解决这个问题的。使用了之后，上下文的共享不仅支持新线程，还支持线程池。官方示例如下：

```java
TransmittableThreadLocal<String> context = new TransmittableThreadLocal<>();

// =====================================================

// 在父线程中设置
context.set("value-set-in-parent");

Runnable task = new RunnableTask();
// 额外的处理，生成修饰了的对象ttlRunnable
Runnable ttlRunnable = TtlRunnable.get(task);
executorService.submit(ttlRunnable);

// =====================================================

// Task中可以读取，值是"value-set-in-parent"
String value = context.get();
```

### 三、ThreadContext 是如何实现的

其实 ES 里面已经默认实现了自带线程池共享的上下文类 ThreadContext，这个类跟 ThreadLocal 十分相似，内部也有一个类似 ThreadLocalMap 的内部类 ThreadContextStruct。对应关系可以参考下图：

![](/assets/thread-to-threadpool-1.png)

ThreadContext 非常灵活，它实现了以下三个实用的功能：

1. 线程上下文暂存
2. 线程上下文网络传输
3. 线程池上下文共享

首先看下上下文暂存，在 Netty 读取网络 IO 字节流之前，Netty 线程有着自己上下文信息，通过网络传输过来的上下文信息也要通过反序列化读取出来，这时候就需要暂存原来 Netty 的线程上下文信息，等待处理完请求之后再恢复。这里 ThreadContext 使用了 Try-With-Resource 的方式实现的，代码如下：

```java
/**
 * Removes the current context and resets a default context. The removed context can be
 * restored by closing the returned {@link StoredContext}.
 */
public StoredContext stashContext() {
    final ThreadContextStruct context = threadLocal.get();
    ...
    return () -> {
        threadLocal.set(context);
    };
}
```

然后是上下文共享，由于 ES 实现了自己的线程池，所以如果要保留当前线程的上下文到线程池中，需要做以下五件事：

1. 暂存当前线程上下文
2. 等待线程池中有空闲线程
3. 暂存线程池线程的上下文
4. 恢复线程池线程上下文开始执行
5. 执行完成后恢复线程池线程上下文

这几件事看起来很复杂，其实就是一个线程上下文切换的问题，实现起来也很简单：

```java
/**
 * Wraps a Runnable to preserve the thread context.
 */
private class ContextPreservingRunnable implements WrappedRunnable {
    private final Runnable in;
    private final ThreadContext.StoredContext ctx;

    private ContextPreservingRunnable(Runnable in) {
        ctx = newStoredContext(false); // 将任务放入线程池之前暂存当前线程上下文
        this.in = in;
    }

    @Override
    public void run() {
        try (ThreadContext.StoredContext ignore = stashContext()){ // 暂存线程池线程上下文
            ctx.restore(); // 恢复当前线程上下文
            in.run();
        } // 结束后再恢复线程池线程上下文
    }
}
```

最后看一下网络传输的部分，ES 节点之前涉及 TCP 通信，有时候需要用到上下文（比如增加一些请求级别的与安全相关的信息，opendistro security 插件就用到了很多），ES 就实现了 ThreadContext 的序列化和反序列化，使得线程上下文可以跨节点传输。

### 四、总结

讲到这里，ES 线程池相关的内容已经都多多少少涉及到了。线程池这个系列就暂时告一段落。
