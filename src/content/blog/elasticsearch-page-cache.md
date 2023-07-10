---
author: Fan Jingbo
pubDatetime: 2022-07-31T16:00:00Z
title: 深入理解Elasticsearch中的缓存——Page Cache
postSlug: elasticsearch-cache-page-cache
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: ES有一篇[官方博客](https://www.elastic.co/cn/blog/elasticsearch-caching-deep-dive-boosting-query-speed-one-cache-at-a-time)，这篇博客深入探讨了ES的几种缓存机制，但是基本都是概念性的介绍。有时在ES的实际使用中，仍然搞不清楚缓存的原理。本文就基于ES的缓存机制，深入到源码中探究其底层原理。
---

ES 有一篇[官方博客](https://www.elastic.co/cn/blog/elasticsearch-caching-deep-dive-boosting-query-speed-one-cache-at-a-time)，这篇博客深入探讨了 ES 的几种缓存机制，但是基本都是概念性的介绍。有时在 ES 的实际使用中，仍然搞不清楚缓存的原理。本文就基于 ES 的缓存机制，深入到源码中探究其底层原理。

## 页缓存 Page Cache

页缓存是 Linux 操作系统提供的磁盘在内存中的缓存。当使用系统调用 read 时，内核会先检查要读取的内容是否在页缓存中存在，存在则直接返回，不存在才会触发中断来读磁盘。这些都比较清晰，没什么好分析的。不过 Elasticsearch 使用了 mmap 和 read 两种方式来读取不同的索引文件，这个值得分析一下（关于 mmap 和 read 的区别，可以参考我之前翻译的[文章](https://fanjingbo.com/post/linux-io/)）。

> 如果你查看生产环境集群的操作系统内存占用，会发现可用内存极少，页缓存都被占满了。这个就是页缓存的作用，尽可能的加载索引文件，来加速查询。这也是 ES 比较吃内存大小的原因。

### Lucene 的逻辑

我们先来看 Lucene，Lucene 的读取过程使用 Directory.openInput 来打开文件流。Directory 有多种实现，其中 mmap 在 Lucene 中对应的是 MmapDirectory，read 在 Lucene 中对应的是 NIOFSDirectory。

其实 Lucene 在大多数情况下都使用的是 mmap 读取索引文件的。代码如下：

```java
public static FSDirectory open(Path path, LockFactory lockFactory) throws IOException {
  if (Constants.JRE_IS_64BIT && MMapDirectory.UNMAP_SUPPORTED) {
    return new MMapDirectory(path, lockFactory);
  } else {
    return new NIOFSDirectory(path, lockFactory);
  }
}
```

其中 JRE_IS_64BIT 代表 JVM 是否为 64 位，UNMAP_SUPPORTED 代表是否能加载 Unsafe 类的 invokeCleaner 方法（当关闭 mmap 文件流时调用这个方法清除 mmap 对应的直接内存，来实现 unmap 的效果）。正常情况下这两个值都会是 true，因此可以认为 Lucene 默认使用 mmap 读取索引文件。

### Elasticsearch 的逻辑

再来看下 ES 的逻辑，ES 默认使用了一个 HybridDirectory 的实现类，这个类使用了代理模式，被代理的就是 MmapDirectory，父类是 NIOFSDirectory。当以下方法返回 true 时使用 mmap，返回 false 时使用 read：

```java
boolean useDelegate(String name) {
    String extension = FileSwitchDirectory.getExtension(name);
    switch(extension) {
        // Norms, doc values and term dictionaries are typically performance-sensitive and hot in the page
        // cache, so we use mmap, which provides better performance.
        case "nvd":
        case "dvd":
        case "tim":
        // We want to open the terms index and KD-tree index off-heap to save memory, but this only performs
        // well if using mmap.
        case "tip":
        // dim files only apply up to lucene 8.x indices. It can be removed once we are in lucene 10
        case "dim":
        case "kdd":
        case "kdi":
        // Compound files are tricky because they store all the information for the segment. Benchmarks
        // suggested that not mapping them hurts performance.
        case "cfs":
        // MMapDirectory has special logic to read long[] arrays in little-endian order that helps speed
        // up the decoding of postings. The same logic applies to positions (.pos) of offsets (.pay) but we
        // are not mmaping them as queries that leverage positions are more costly and the decoding of postings
        // tends to be less a bottleneck.
        case "doc":
            return true;
        // Other files are either less performance-sensitive (e.g. stored field index, norms metadata)
        // or are large and have a random access pattern and mmap leads to page cache trashing
        // (e.g. stored fields and term vectors).
        default:
            return false;
    }
}
```

可以看到上面定义文件后缀都使用 mmap，其他情况下使用 read。

关于 mmap 和 read 的性能比较，这个 stackoverflow[高赞回答](https://stackoverflow.com/questions/45972/mmap-vs-reading-blocks)讲的很清晰。mmap 与 read 相比的优势在于：少了一次内存从内核空间到用户空间的拷贝，对于需要常驻内存的文件和随机读取场景更适用；而反过来 read 的优势在于，调用开销少，不需要构建内存映射的页表等操作（包括 unmap），对于少量顺序读取或者读取完就丢弃的场景更适用。

实际上 ES 的使用逻辑是符合这个结论的，对于 nvd、dvd、tim 等索引文件，由于查询频率很高，因此使用 mmap 常驻内存，对于 fdx、fdm、nvm 等索引元数据文件，读完需要的内容就可以丢弃，则应该使用 read 来读，另外一种上面没有提到的场景是 fdt 文件，由于存放原始数据，磁盘占用较大，全部使用 mmap 加载到内存中会导致页缓存抖动，真正需要常驻内存的索引文件会被换出页缓存，会导致性能劣化，因此也需要使用 read。

### 写入场景

上面提到的都是读取场景，MmapDirectory 代码的第一段注释是这么写的：

```
File-based Directory implementation that uses mmap for reading, and FSDirectory.FSIndexOutput for writing.
```

FSIndexOutput 实际上就会使用 write 而不是 mmap 来进行写入操作。我之前一直很好奇为什么写入不使用 mmap。

其实原因很简单：假设使用 mmap 来写入，首先要指定好索引文件做映射，需要知道索引的大小，但是在实际写入之前，是没办法知道写入文件大小的（Lucene 一般都是通过 try-with-resources 打开一个 IndexOutput，然后开始写入）。使用 mmap 很难完成这样的操作，而 write 调用则不受这个限制。

> 实际上 Lucene 的 write 是带 buffer 的，类似于 fwrite，因此也不会触发过多的中断。mmap 和 fwrite 相比，一个是预先映射好内存空间，另一个是一个 buffer 一个 buffer 写入 Page Cache。对于已知大小的大文件写入，mmap 应该会更快一些，但是 Lucene 的 segment 是比较小的，从性能上讲，mmap 也没有优势。

## 总结

以上是关于页缓存的 ES 原理分析，下一篇会讨论 ES 查询相关的 cache。
