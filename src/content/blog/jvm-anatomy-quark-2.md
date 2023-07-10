---
author: Fan Jingbo
pubDatetime: 2022-11-06T13:00:00Z
title: "【JVM Anatomy Quark】 #2-透明大页"
postSlug: jvm-anatomy-quark-2-transparent-huge-pages
tags:
  - Java
ogImage: ""
description: 什么是大页？什么是透明大页？他们又是做什么的？
---

## 问题

什么是大页？什么是透明大页？他们又是做什么的？

## 理论

CPU 提供了实模式和保护模式，分别对应使用物理内存和虚拟内存。目前，所有常见的操作系统都会默认使用保护模式，也就是虚拟内存来运行程序。只有一些非常老的操作系统，会使用实模式运行程序，因为当时 CPU 也只支持实模式。在实模式下，进程会直接映射到物理内存，在保护模式下，每个进程会单独使用一个自己的内存空间，也就是虚拟内存空间。比如说，两个进程可以在 0x424242 的虚拟内存地址存储不同的数据，因为它们背后指向了不同的物理内存。所以说，当一个程序需要访问内存时，虚拟内存需要被转换为物理内存。

这个转换是通过操作系统提供的页表实现的，然后硬件会遍历页表来找到对应的物理内存位置。如果这个转换是以 page 为粒度的话还是比较简单的。但是实际上会更复杂，每次内存访问都要做一次转换。因此，就有了一种缓存机制帮忙加速这种转换，这个缓存叫做 TLB。TLB 通常又小又快，至少是跟 L1 cache 一样快。多数场景下，TLB 会经常 miss，然后会继续遍历页表。

由于 TLB 不能变得更大，我们又想让内存地址转换变快，还有一种方法就是增大页的大小。大多数硬件的页大小是 4K，可以使用 2M/4M/1G 的页大小。这样页表映射到同样的总内存需要的页表项会变少，转换过程中遍历就会变快。

在 Linux 中，有两种可以让页表变大的方法：

- hugetlbfs：从系统内存分出来一部分给虚拟文件系统，然后让应用通过 mmap 来访问。这种方式需要系统配置和应用修改才能使用。开启之后，分出来的内存是不能被普通进程使用的。因此需要权衡

- 透明大页（Transparent Huge Pages, THP）：这种方式程序不需要做任何修改，是尝试透明的提供大页内存的使用给应用。理想情况下是这样的。下面我们会介绍如果程序知道 THP 开启后会有哪些好处。并且实际上是有一些缺点的，首先是内存开销，因为小内存的分配也会占用一整个 page；然后就是时间开销，因为有时候 THP 需要整理内存来分配 page。好的部分则是，有一个折衷方案：应用可以通过 madvise 系统调用来让操作系统知道什么时候使用 THP。

接下来看 JVM 中和 THP 相关的选项：

需要注意的是，JVM 中对于大页除了 huge page 还有 large page 的命名方式。使用下面的命令打印出来相关 JVM 参数：

```shell

java -XX:+PrintFlagsFinal

```

其中 huge page 相关的有：

```

bool UseHugeTLBFS    = false    {product} {default}

bool UseTransparentHugePages    = false    {product} {default}

```

large page 相关的有：

```

size_t LargePageHeapSizeThreshold    = 134217728    {product} {default}

size_t LargePageSizeInBytes    = 0    {product} {default}

bool UseLargePages    = false    {pd product} {default}

bool UseLargePagesIndividualAllocation    = false    {pd product} {default}

```

LargePageHeapSizeThreshold：仅当堆内存大于对应值时才开启 large page。

LargePageSizeInBytes：large page 可以使用的上限大小，默认为 0，含义是可以使用环境默认 large page 大小作为上限。

UseLargePages：决定是否开启 large page，对于 Linux 而言，默认会使用 hugetlbfs 而不是 THP，这可能是因为历史原因，因为 hugetlbfs 出来的更早。

UseHugeTLBFS：决定是否 mmap 堆内存到 hugetlbfs 中，这需要单独设置。

UseTransparentHugePages：决定是否使用 THP。这是个很方便的选项，因为 Java 堆内存通常是又大又连续的，使用 THP 通常来说是比较好的。

·[某些应用程序]([https://bugs.openjdk.java.net/browse/JDK-8024838](https://bugs.openjdk.java.net/browse/JDK-8024838 "https://bugs.openjdk.java.net/browse/JDK-8024838"))确实会受到启用大页面的影响。（有时候开发者会手动内存管理来避免 GC，结果却遇到 THP 碎片整理导致更高的延迟，这很滑稽）我的直觉是，THP 在短暂运行的应用程序中表现比较差，因为与较短的应用程序时间相比，碎片整理成本是相对占比更大的。

## 实验

接下来做一些实验来展示大页有哪些好处。首先是分配并随机读取 byte 数组：

```java

public class ByteArrayTouch {

    @Param(...)

    int size;

    byte[] mem;

    @Setup

    public void setup() {

        mem = new byte[size];

    }

    @Benchmark

    public byte test() {

        return mem[ThreadLocalRandom.current().nextInt(size)];

    }

}

```

因为测试的读取的速度，因此这个实验受 cpu cache 的影响很大。当数组大小大于 L3 cache 时，程序就不得不读取内存，这时性能会有一个直线的下降。

测试用的机器 cpu 是 12700，通过`lscpu`命令查看 L3 cache 大小为 25MB。相比原作者大了 3 倍，因此选择堆内存为 3GB，数组大小为 300KB，3000KB，3MB，30MB，300MB。

通过一下方式设置 hugetlbfs 和 THP：

```

# 首先通过grep Hugepagesize /proc/meminfo查看大页的大小，为2MB,这里设置代表总大小为6000MB

sudo sysctl -w vm.nr_hugepages=3000

# 将THP设置为madvise,我的机器第一个值默认是always,第二个值默认就为madvise

echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled

echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/defrag

```

在我的 Linux 机器（Linux x86_64, i7-12700, JDK-17）上测试结果如下：

```

Benchmark               (size)  Mode  Cnt   Score   Error  Units

# Baseline

ByteArrayTouch.test       3000  avgt   15   2.727 ± 0.006  ns/op

ByteArrayTouch.test      30000  avgt   15   2.821 ± 0.227  ns/op

ByteArrayTouch.test    3000000  avgt   15   4.420 ± 0.346  ns/op

ByteArrayTouch.test   30000000  avgt   15  15.545 ± 2.087  ns/op

ByteArrayTouch.test  300000000  avgt   15  21.490 ± 0.875  ns/op

# -XX:+UseTransparentHugePages

ByteArrayTouch.test       3000  avgt   15   2.737 ± 0.007  ns/op

ByteArrayTouch.test      30000  avgt   15   2.779 ± 0.071  ns/op

ByteArrayTouch.test    3000000  avgt   15   4.239 ± 0.020  ns/op

ByteArrayTouch.test   30000000  avgt   15  15.008 ± 0.874  ns/op

ByteArrayTouch.test  300000000  avgt   15  20.544 ± 0.036  ns/op

# -XX:+UseHugeTLBFS

ByteArrayTouch.test       3000  avgt   15   2.729 ± 0.005  ns/op

ByteArrayTouch.test      30000  avgt   15   2.777 ± 0.062  ns/op

ByteArrayTouch.test    3000000  avgt   15   4.245 ± 0.035  ns/op

ByteArrayTouch.test   30000000  avgt   15  13.865 ± 1.505  ns/op

ByteArrayTouch.test  300000000  avgt   15  21.238 ± 0.673  ns/op

```

可以观察到以下几点：

1. 对于小数组，性能差别不大，因为 cache 和 TLB 压力都很小。

2. 对于大数组，差别开始变大，因为 L3 cache 是 24MB，所以从第四个 30MB 开始差别明显增大了。

3. 对于大数组，TLB miss 也开始占比变多，开启大页会比较有效。

> 但是从上面的横向对比可以看出，实际上开启大页的效果并没有很明显。并没有 L3 cache 的影响大。

4. THP 和 hugetlbfs 效果是相同的，因为他们都提供了相同的大页功能。

为了证明 TLB miss 的结论，可以通过`-prof perfnorm`选项来打开硬件计数功能。

> 这里我没有复现相似的结果，贴出来的是作者的结果。

```

Benchmark                                (size)  Mode  Cnt    Score    Error  Units

# Baseline

ByteArrayTouch.test                   100000000  avgt   15   33.575 ±  2.161  ns/op

ByteArrayTouch.test:cycles            100000000  avgt    3  123.207 ± 73.725   #/op

ByteArrayTouch.test:dTLB-load-misses  100000000  avgt    3    1.017 ±  0.244   #/op  // !!!

ByteArrayTouch.test:dTLB-loads        100000000  avgt    3   17.388 ±  1.195   #/op

# -XX:+UseTransparentHugePages

ByteArrayTouch.test                   100000000  avgt   15   28.730 ±  0.124  ns/op

ByteArrayTouch.test:cycles            100000000  avgt    3  105.249 ±  6.232   #/op

ByteArrayTouch.test:dTLB-load-misses  100000000  avgt    3   ≈ 10⁻³            #/op

ByteArrayTouch.test:dTLB-loads        100000000  avgt    3   17.488 ±  1.278   #/op

```

可以看到未开启大页时，dTLB load miss 平均是有一次，开启 THP 就几乎没有。

当然，THP 碎片整理打开时，分配和访问内存时候会付出相应的整理时间的损耗。为了避免在程序运行时出现由于整理出现的延迟，可以在 JVM 启动时开启`-XX:+AlwaysPreTouch`开关，来使所有的大页物理内存都被初始化。（不开启的时候，JVM 堆内存仅会在虚拟内存中分配；开启之后，堆内存会实际分配对应的物理内存，对应的内存初始化为 0）一般情况下，为大页开启 pre-touch 是一个好主意。

有趣的地方来了，开启`-XX:+UseTransparentHugePages`会使`-XX:+AlwaysPreTouch`变快，因为操作系统使用了大页，因此页的数量会更少，流式写（写零）会更快。开启 THP 下，进程结束后释放内存也更快，有时会快得吓人，直到并行释放补丁进入 Linux 发行版内核。

做一个实验，分配 30GB 堆内存查看需要的时间：

```

$ time java -Xms4T -Xmx4T -XX:-UseTransparentHugePages -XX:+AlwaysPreTouch

0.29s user 22.99s system 1187% cpu 1.960 total

$ time java -Xms4T -Xmx4T -XX:+UseTransparentHugePages -XX:+AlwaysPreTouch

0.08s user 19.27s system 1235% cpu 1.567 total

```

可以看出来开启 THP，pretouch 确实会快不少。

## 结论

大页是提高应用程序性能的简单技巧。 Linux 内核中的 THP 和 JVM 中的 THP 都很容易开启。 当应用程序有大量数据和大堆时， 尝试开启大页总是一个好主意。
