---
author: Fan Jingbo
pubDatetime: 2022-10-31T01:00:00Z
title: "【JVM Anatomy Quark】 #1-循环中的锁粗化"
postSlug: jvm-anatomy-quark-1-lock-coarsening-for-loops
draft: false
tags:
  - Java
ogImage: ""
description: JVM Anatomy Quark是一系列关于JVM原理的文章集合，每一篇文章都不长，从不同的角度讲解JVM的底层原理。作者[Aleksey Shipilëv](https://shipilev.net/Aleksey_Shipilev_CV.pdf)是OpenJDK的著名开发者，开发过Shenandoah GC，现在任职于RedHat公司。
---

> [JVM Anatomy Quark](https://shipilev.net/jvm/anatomy-quarks/)是一系列关于 JVM 原理的文章集合，每一篇文章都不长，从不同的角度讲解 JVM 的底层原理。作者[Aleksey Shipilëv](https://shipilev.net/Aleksey_Shipilev_CV.pdf)是 OpenJDK 的著名开发者，开发过 Shenandoah GC，现在任职于 RedHat 公司。
> 对于这个系列文章，我不会仅仅做一比一的翻译，而是会加入很多自己的理解和分析，并且会将文章中涉及到的实验使用 JDK17 再跑一遍。
> 如无特殊说明，本系列文章运行环境为 MacBook Air (M1, 2020)，JDK 版本为 openjdk 17.0.5

## 问题

众所周知，JVM 会对代码进行锁粗化的优化（[lock coarsening optimizations](https://en.wikipedia.org/wiki/Java_performance#Escape_analysis_and_lock_coarsening)）来将相邻的加锁代码块合并，从而减少不必要的加锁。举个例子，锁粗化会将这样的代码：

```java
synchronized (obj) {
  // statements 1
}
synchronized (obj) {
  // statements 2
}
```

转换为：

```java
synchronized (obj) {
  // statements 1
  // statements 2
}
```

现在可以引申出来一个有趣的问题，循环中的锁能被优化吗，类似于将这样的代码：

```java
for (...) {
  synchronized (obj) {
    // something
  }
}
```

能被优化成这样吗：

```java
synchronized (this) {
  for (...) {
     // something
  }
}
```

理论上这应该是可以的。可以想象成是一种循环外提（[loop unswitching](https://en.wikipedia.org/wiki/Loop_unswitching)）优化在锁上的一种表现形式。但是，这种优化可能会将锁粗化过头，一个非常大的循环可能会一直持有锁，导致其他代码无法得到执行。

## 实验

接下来就是实验环节，毕竟 Talk is cheap。我们会使用[JMH](http://openjdk.java.net/projects/code-tools/jmh/)来进行性能测试，下面是示例代码的方法部分：

```java
@Benchmark
@Fork(jvmArgsPrepend = {"-XX:-UseBiasedLocking"})
@CompilerControl(CompilerControl.Mode.DONT_INLINE)
public void test() {
    for (int c = 0; c < 1000; c++) {
        synchronized (this) {
            x += 0x42;
        }
    }
}
```

有几个比较关键的设置：

1. 使用-XX:-UseBiasedLocking 选项来关闭偏向锁，来避免更长的 warmup 时间。因为偏向锁并不是立即启动的，而是会等待 5s（BiasedLockingStartupDelay 选项）

   > 这里作者使用的是 JDK9，BiasedLockingStartupDelay 设置在[JDK10](https://bugs.openjdk.org/browse/JDK-8181778)中就改成了 0，并且从链接中可以看到，原来的值是 4s，并不是作者说的 5s。另外，偏向锁已经在[JDK15](https://openjdk.org/jeps/374)中标记为废弃。

2. 关闭内联优化，方便在反汇编中找到对应的测试方法
3. 使用一个特殊数字 0x42，方便在反汇编中找到

我的运行结果是：

```
LockCoarsening.testWithoutBias  avgt    5  2415.129 ±  71.032  ns/op
```

单独这一个结果看不出什么东西。可以通过-prof perfasm 打印出来汇编代码的热区。

> 这里调试了很久，打印不出来任何结果（热区都是空的），所以暂时使用原文作者给出的结果

默认设置下，最热的指令就是`lock cmpxchg` (compare-and-sets)，其实就是轻量级锁。

```asm
 ↗  0x00007f455cc708c1: lea    0x20(%rsp),%rbx
 │          < blah-blah-blah, monitor enter >     ; <--- coarsened!
 │  0x00007f455cc70918: mov    (%rsp),%r10        ; load $this
 │  0x00007f455cc7091c: mov    0xc(%r10),%r11d    ; load $this.x
 │  0x00007f455cc70920: mov    %r11d,%r10d        ; ...hm...
 │  0x00007f455cc70923: add    $0x42,%r10d        ; ...hmmm...
 │  0x00007f455cc70927: mov    (%rsp),%r8         ; ...hmmmmm!...
 │  0x00007f455cc7092b: mov    %r10d,0xc(%r8)     ; LOL Hotspot, redundant store, killed two lines below
 │  0x00007f455cc7092f: add    $0x108,%r11d       ; add 0x108 = 0x42 * 4 <-- unrolled by 4
 │  0x00007f455cc70936: mov    %r11d,0xc(%r8)     ; store $this.x back
 │          < blah-blah-blah, monitor exit >      ; <--- coarsened!
 │  0x00007f455cc709c6: add    $0x4,%ebp          ; c += 4   <--- unrolled by 4
 │  0x00007f455cc709c9: cmp    $0x3e5,%ebp        ; c < 1000?
 ╰  0x00007f455cc709cf: jl     0x00007f455cc708c1
```

从 c+=4 和 add 0x108 (42 \* 4)可以看出来，代码是做了 4 次的循环展开[unrolled](https://en.wikipedia.org/wiki/Loop_unrolling)，类似以下的变化就是 3 次循环展开：

```java
for (i = 1; i <= 60; i++)
   a[i] = a[i] * b + c;

for (i = 1; i <= 58; i+=3)
{
  a[i] = a[i] * b + c;
  a[i+1] = a[i+1] * b + c;
  a[i+2] = a[i+2] * b + c;
}
```

并且锁也相应粗化了四倍。为了验证是否是由循环展开导致的锁粗化，我们手动设置循环展开系数为 1（-XX:LoopUnrollLimit=1），即不做循环展开。结果对比如下：

```
LockCoarsening.testUnrollOne    avgt    5  9509.592 ± 10.030  ns/op
LockCoarsening.testWithoutBias  avgt    5  2415.129 ±  71.032  ns/op
```

查看热区结果：

```asm
 ↗  0x00007f964d0893d2: lea    0x20(%rsp),%rbx
 │          < blah-blah-blah, monitor enter >
 │  0x00007f964d089429: mov    (%rsp),%r10        ; load $this
 │  0x00007f964d08942d: addl   $0x42,0xc(%r10)    ; $this.x += 0x42
 │          < blah-blah-blah, monitor exit >
 │  0x00007f964d0894be: inc    %ebp               ; c++
 │  0x00007f964d0894c0: cmp    $0x3e8,%ebp        ; c < 1000?
 ╰  0x00007f964d0894c6: jl     0x00007f964d0893d2 ;
```

可以看出来，不做循环展开后性能差了 4 倍，锁粗化相应也失效了，每一次循环都要走一遍加锁流程。

上面的两个实验都关闭了偏向锁，实际对于这种没有线程竞争的场景，偏向锁应该是最快的，加上偏向锁再做一次测试：

```
LockCoarsening.testWithBias     avgt    5   236.754 ±  1.495  ns/op
```

比不加偏向锁快了 10 倍左右。

## 结论

虽然锁粗化不适用于整个循环，但另一个优化——循环展开可以帮助展开循环，使得一次循环执行更多内容，从而实现了锁粗化，性能也能得到提升。
