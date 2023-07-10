---
author: Fan Jingbo
pubDatetime: 2021-04-18T16:00:00Z
title: 【Elasticsearch源码解析】线程池篇——ES的线程池概述
postSlug: elasticsearch-threadpool1
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: 在Java中，线程池有着比较方便的实现类ThreadPoolExecutor，但是这个实现类并不是开箱即用的，在实际的业务中需要一定的知识基础才能发挥出线程池的好处。Elasticsearch中就封装了一系列更实用的线程池实现，本篇文章就结合ES源码来探索一下大神们是如何实现线程池的。
---

### 一、前言

在 Java 中，线程池有着比较方便的实现类 ThreadPoolExecutor，但是这个实现类并不是开箱即用的，在实际的业务中需要一定的知识基础才能发挥出线程池的好处。Elasticsearch 中就封装了一系列更实用的线程池实现，本篇文章就结合 ES 源码来探索一下大神们是如何实现线程池的。

### 二、基础知识

先回顾一下 Java 的线程池实现中任务调度的原理，有以下几个重要参数：当前线程数 current，核心线程数 core，最大线程数 max，存储等待任务的队列 queue，任务调度可以用以下流程图表示：

![](/assets/31bad766983e212431077ca8da92762050214.png)

可以参考一下 Java 线程池类 ThreadPoolExecutor 的构造函数：

```java
/**
 * Creates a new {@code ThreadPoolExecutor} with the given initial
 * parameters.
 *
 * @param corePoolSize the number of threads to keep in the pool, even
 *        if they are idle, unless {@code allowCoreThreadTimeOut} is set
 * @param maximumPoolSize the maximum number of threads to allow in the
 *        pool
 * @param keepAliveTime when the number of threads is greater than
 *        the core, this is the maximum time that excess idle threads
 *        will wait for new tasks before terminating.
 * @param unit the time unit for the {@code keepAliveTime} argument
 * @param workQueue the queue to use for holding tasks before they are
 *        executed.  This queue will hold only the {@code Runnable}
 *        tasks submitted by the {@code execute} method.
 * @param threadFactory the factory to use when the executor
 *        creates a new thread
 * @param handler the handler to use when execution is blocked
 *        because the thread bounds and queue capacities are reached
 * @throws IllegalArgumentException if one of the following holds:<br>
 *         {@code corePoolSize < 0}<br>
 *         {@code keepAliveTime < 0}<br>
 *         {@code maximumPoolSize <= 0}<br>
 *         {@code maximumPoolSize < corePoolSize}
 * @throws NullPointerException if {@code workQueue}
 *         or {@code threadFactory} or {@code handler} is null
 */
public ThreadPoolExecutor(int corePoolSize,
						  int maximumPoolSize,
						  long keepAliveTime,
						  TimeUnit unit,
						  BlockingQueue<Runnable> workQueue,
						  ThreadFactory threadFactory,
						  RejectedExecutionHandler handler) {
	if (corePoolSize < 0 ||
		maximumPoolSize <= 0 ||
		maximumPoolSize < corePoolSize ||
		keepAliveTime < 0)
		throw new IllegalArgumentException();
	if (workQueue == null || threadFactory == null || handler == null)
		throw new NullPointerException();
	this.corePoolSize = corePoolSize;
	this.maximumPoolSize = maximumPoolSize;
	this.workQueue = workQueue;
	this.keepAliveTime = unit.toNanos(keepAliveTime);
	this.threadFactory = threadFactory;
	this.handler = handler;
}
```

其中的 corePoolSize、maximumPoolSize 和 workQueue 上面介绍过了。其余几个参数含义如下：

keepAliveTime：当当前线程数大于核心线程数是，空闲线程等待新任务的时间，超过这个时间就会销毁该空闲线程
unit：keepAliveTime 的单位
threadFactory：线程池创建线程的工厂类，可以自定义线程的名字
handler：线程任务的拒绝 handler，只需要重写 RejectedExecutionHandler 接口的 rejectedExecution 类就可以自定义线程被拒绝后的逻辑

结合着这几个参数可以构建出适用场景不同的线程池模型。

### 三、Elasticsearch 线程池实现

ES 的线程池类是 ThreadPool，其中把不同的任务用不同的线程池分开。这样的好处一是隔离线程资源，避免当一种任务繁忙时影响到另一种任务的运行；二是可以为不同类型的任务分配不同类型的线程池，提高处理效率。

ES 预定义好了三种线程池：

1. newSinglePrioritizing：固定单线程的线程池，只在 MasterService 中用于更新集群元数据，其中的任务队列使用了优先级队列 PriorityBlockingQueue。队列中存入的内容 TieBreakingPrioritizedRunnable 包含优先级 priority 和插入顺序 insertionOrder，当线程从队列中拿任务时会调用队列的 poll 方法，队列会返回优先级最高且插入最早的任务：

```java
@Override
public int compareTo(PrioritizedRunnable pr) {
	int res = super.compareTo(pr); // 父类的调用为priority.compareTo(pr.priority)，先比较优先级
	if (res != 0 || !(pr instanceof TieBreakingPrioritizedRunnable)) {
		return res;
	}
	return insertionOrder < ((TieBreakingPrioritizedRunnable) pr).insertionOrder ? -1 : 1;
}
```

2. newScaling：线程可扩容的线程池，类似 Java 默认线程池，设定 corePoolSize 和 maximumPoolSize。但是具体逻辑与默认线程池差别很大，首先是队列上，继承了一个性能很好的无界队列 LinkedTransferQueue，但是重写了将任务写入队列的 offer 方法，代码如下：

```java
// check if there might be spare capacity in the thread
// pool executor
int left = executor.getMaximumPoolSize() - executor.getCorePoolSize();
if (left > 0) {
	// reject queuing the task to force the thread pool
	// executor to add a worker if it can; combined
	// with ForceQueuePolicy, this causes the thread
	// pool to always scale up to max pool size and we
	// only queue when there is no spare capacity
	return false;
} else {
	return super.offer(e);
}
```

由上文可以知道，默认线程池的逻辑是：如果队列写入失败，并且当前线程数小于最大线程数时，才会增加线程并执行传入的任务。重写这里的 offer 方法之后实际上将写入队列和增加线程的顺序颠倒过来了，传入一个新任务时，如果线程没有到最大线程，直接增加线程，直到线程达到最大线程，任务再写入队列。由于 newScaling 线程池的任务类型包含 FLUSH，REFRESH 这些 IO 密集型任务，这样处理的原因比较显而易见了————提前增大线程数量可以获得更高的吞吐量。

另一个不同点是拒绝策略，使用 newScaling 线程池的任务都是系统层级或者非 CPU 密集型的，如 GENERIC，MANAGEMENT，REFREASH，FLUSH 等，因此没有必要将任务拒绝，所以在拒绝策略的定义中，实际上将要被拒绝的任务重新放进队列中：

```java
static class ForceQueuePolicy implements XRejectedExecutionHandler {
	@Override
	public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
		try {
			// force queue policy should only be used with a scaling queue
			assert executor.getQueue() instanceof ExecutorScalingQueue;
			executor.getQueue().put(r);
		} catch (final InterruptedException e) {
			// a scaling queue never blocks so a put to it can never be interrupted
			throw new AssertionError(e);
		}
	}
	@Override
	public long rejected() {
		return 0;
	}
}
```

3. newFixed：线程数固定的线程池，corePoolSize 和 maximumPoolSize 值相同，因此线程池正常执行时线程数时固定的。使用这种线程池的任务都是 CPU 密集型的任务，如 WRITE 和 FORCE_MERGE 等。因为对于 CPU 密集型任务，过大的线程数由于线程切换的损耗会使得任务效率下降。newFixed 线程池队列分两种情况：

```java
BlockingQueue<Runnable> queue;
if (queueCapacity < 0) {
	queue = ConcurrentCollections.newBlockingQueue(); // 具体是LinkedTransferQueue
} else {
	queue = new SizeBlockingQueue<>(ConcurrentCollections.<Runnable>newBlockingQueue(), queueCapacity);
}
```

当 queueCapacity 小于 0 时，队列是 LinkedTransferQueue，为无界队列。当 queueCapacity 大于 0 时，队列是 SizeBlockingQueue，实际上是一个封装了的 LinkedTransferQueue，为其加上了容量，参考 offer 方法：

```java
@Override
public boolean offer(E e) {
	while (true) {
		final int current = size.get();
		if (current >= capacity()) {
			return false; // 当队列容量超过限制时，拒绝写入队列
		}
		if (size.compareAndSet(current, 1 + current)) {
			break;
		}
	}
	boolean offered = queue.offer(e);
	if (!offered) {
		size.decrementAndGet();
	}
	return offered;
}
```

在这种情况下就需要拒绝超过限额的请求，拒绝逻辑代码就不一样了，除了一些特殊任务的 isForceExecution()方法返回为 true 时会将该任务强行放入队列，其他情况下任务会被拒绝：

```java
public class EsAbortPolicy implements XRejectedExecutionHandler {
    private final CounterMetric rejected = new CounterMetric();
    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        if (r instanceof AbstractRunnable) {
            if (((AbstractRunnable) r).isForceExecution()) {
                BlockingQueue<Runnable> queue = executor.getQueue();
                if (!(queue instanceof SizeBlockingQueue)) {
                    throw new IllegalStateException("forced execution, but expected a size queue");
                }
                try {
                    ((SizeBlockingQueue) queue).forcePut(r); // 当任务的isForceExecution方法返回true时，强行写入队列
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("forced execution, but got interrupted", e);
                }
                return;
            }
        }
        rejected.inc();
        throw new EsRejectedExecutionException("rejected execution of " + r + " on " + executor, executor.isShutdown());
    }
    @Override
    public long rejected() {
        return rejected.count();
    }
}
```

另外，在 ES7.7.0 版本之前，还有一种专门给 SEARCH 任务使用的线程池 newAutoQueueFixed，它与 newFixed 线程池相似，只是队列大小是自适应的，本文不再赘述。

### 四、总结

可以看到，Elasticsearch 根据不同的任务类型精心设计了不同的线程池，并且根据任务的特性设置了不同的线程数和队列参数。相关代码清晰易读，非常值得学习。
