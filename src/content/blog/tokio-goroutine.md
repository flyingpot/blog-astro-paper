---
author: Fan Jingbo
pubDatetime: 2022-09-04T16:00:00Z
title: Tokio和Goroutine到底谁更快？
postSlug: selenium
draft: false
tags:
  - Rust
  - Golang
  - Tokio
  - Goroutine
ogImage: ""
description: 最近看到reddit有这样一个对比[帖子](https://www.reddit.com/r/rust/comments/lg0a7b/benchmarking_tokio_tasks_and_goroutines/)，讲的是对比Go语言goroutine和Rust语言tokio runtime的性能。我最喜欢围观语言之间的性能之争了，就像器材党比较谁的器材更厉害一样。我内心的预期是这两种语言的并发性能应该是不相上下的，虽说Rust号称是跟C/C++性能差不多的系统级编程语言，并且没有GC损耗，但是Go语言的goroutine也是一大杀器，设计十分精妙，性能也很强。
---

最近看到 reddit 有这样一个对比[帖子](https://www.reddit.com/r/rust/comments/lg0a7b/benchmarking_tokio_tasks_and_goroutines/)，讲的是对比 Go 语言 goroutine 和 Rust 语言 tokio runtime 的性能。我最喜欢围观语言之间的性能之争了，就像器材党比较谁的器材更厉害一样。我内心的预期是这两种语言的并发性能应该是不相上下的，虽说 Rust 号称是跟 C/C++性能差不多的系统级编程语言，并且没有 GC 损耗，但是 Go 语言的 goroutine 也是一大杀器，设计十分精妙，性能也很强。

### 对比场景和代码

这个帖子的楼主写了一些基准代码来对比 goroutine 和 tokio 的性能，场景为并发跑 1000 个任务：从/dev/urandom 中读取 10 个字节，然后写入/dev/null 中。代码可以参考这个[代码仓库](https://github.com/flyingpot/tokio-goroutine-perf)。楼主在主贴里面写了这三种基准代码：

1. 使用 go 关键字（对应 goroutine.go）
2. 使用 Rust 标准库的 thread::spawn 创建线程（对应 thread.rs）
3. 使用 tokio 库的 async/await 异步任务，其中读写文件也用了 tokio 的非阻塞方法，如 tokio::fs（对应 tokio_unblock.rs）

在我的 Linux 机器上跑这三个任务的结果分别为：

```
goroutine results:
1.31314911s total, 1.313149ms avg per iteration
std thread results:
14.420476843s total, 14.420476ms avg per iteration
tokio unblock results:
9.862689069s total, 9.862689ms avg per iteration

```

可以看到 goroutine 的性能真的很强，比下面两种快了好几倍。楼主的结果没有我测试的差别那么大，但排名是一样的。因此发帖问这是不是正常的 Rust 和 Go 的性能差别。因为按理说 Tokio 和 Goroutine 都使用了相似的协程策略，不应该有成倍的性能差距。

在继续分析之前，先简单讲讲 Tokio 和 Goroutine 的原理。

### Tokio 和 Goroutine 的异步原理

如果你是个 Java 工程师，你应该会知道 Netty 编程有多复杂。定义 pipeline，各种回调，代码量又多又难理解。可以说是很不符合人类的理解习惯。而 Tokio 是一个 Rust 的异步 runtime，有了它就可以用实现底层异步，上层同步，从而用同步的方式写异步代码。这里举一个 tokio 官方的代码例子，这段代码实现了一个 tcp server，会将客户端发来的数据原封不动的发回去：

```rust
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use std::error::Error;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:8081").await?;

    loop {
        let (mut socket, _) = listener.accept().await?;

        tokio::spawn(async move {
            let mut buf = vec![0; 1024];

            loop {
                let n = socket
                    .read(&mut buf)
                    .await
                    .expect("failed to read data from socket");

                if n == 0 {
                    return;
                }

                socket
                    .write_all(&buf[0..n])
                    .await
                    .expect("failed to write data to socket");
            }
        });
    }
}
```

可以看到绑定端口和实际的复制逻辑都是放在 loop 循环里的，但是却不会影响新连接和新数据的处理，看上去是同步语句，会阻塞代码运行，实际却是通过 tokio 的后台协程运行的，实现异步的效果。其中 await 就是一个异步关键字，当调用阻塞方法时只需要加上 await 就能将其变为异步运行，非常好用。

对于 goroutine 来说，异步代码实际上更为简单，甚至连 await 都不需要加：

```go
pacakge main

import (
	"fmt"
	"net"
	"bufio"
)

func handleConnection(c net.Conn) {
	for {
		netData, _ := bufio.NewReader(c).ReadString('\n')
		c.Write([]byte(string(netData)))
	}
	c.Close()
}

func main() {
	l, _ := net.Listen("tcp", "127.0.0.1:8080")

	for {
		c, _ := l.Accept()
		go handleConnection(c)
	}
}
```

只要将需要异步执行的方法前面加上 go 关键字，就把管理权交给 goroutine，最终实现异步执行。

因此，使用 goroutine 或者 tokio，人们就能忽略掉复杂的实现细节，从而更加专注地实现业务逻辑。

### 继续分析

回到帖子，下面有老哥提出优化建议是使用 tokio 的 block_in_place 方法。这个方法实际上是为了会阻塞的任务准备的，使用这个方法会告诉 tokio 的 executor 将其他任务调度到其他线程中去，避免因为阻塞导致的线程饥饿问题。

实现在 tokio_block_in_place.rs 中，结果为：

```
tokio block in place results:
3.654930239s total, 3.65493ms avg per iteration
```

原帖中的结果是与 goroutine 跑出来的基本相同了，我这里跑出来还是有 2 ～ 3 倍的差距。

下面还有老哥评论说使用 tokio+同步的方式更快，因为/dev/urandom 和/dev/null 的读写根本不会阻塞。我一想确实，虽说调用了读和写，但是/dev/urandom 和/dev/null 可不同于一般的文件，属于特殊文件。man urandom 查看了一下文档，发现果然有说明：

```
When  read,  the  /dev/urandom device returns random bytes using a pseudorandom number generator seeded from the entropy pool.  Reads from this device do not block (i.e., the CPU is not yielded), but can incur an appreciable delay when requesting large amounts of data.
```

试一下同步的方法，直接使用标准库的 fs 就好，代码见 tokio_block.rs，结果如下：

```
tokio block results:
955.927534ms total, 955.927µs avg per iteration
```

可以看到比 goroutine 还要快一些。不过这个场景说实话没什么比较的意义，看看就好。

再回去分析下总体的结果：

1. goroutine：没啥好说的，既简单又快。
2. 标准库的 thread：最慢是因为主要耗时都在线程的创建上了，因为 thread 会使用系统线程，创建起来耗时很长。
3. tokio+异步读写：使用 tokio，比 thread 少了线程创建的开销，但是本来同步的操作使用异步接口导致多了很多不必要的上下文切换。
4. tokio+block_in_place：block_in_place 调用是同步运行的，不过还是存在将其他任务切换到其他线程的开销。
5. tokio+同步：同步任务使用同步调用，搭配上 tokio，达到了和 goroutine 类似的结果。

### 总结

这篇文章其实是标题党。性能比较是个复杂的事情，要考虑到很多问题，设立一个准确的场景再进行比较才有意义。就像这个帖子一样，楼主包括很多下面跟帖的人都没有意识到这个实验跟他们想象的场景根本就不一样，这种问题其实不容易发现。有时候你会发现性能差别很大，但是这种结果可能是受到了其他因素的影响，压根就跟测试对象没有关系。所以设计出合理的 benchmark 是很难的。

从这个实验也能看出来 Go 和 Rust 的不同之处，Go 语言就像是更新更强的 Java，很简单性能又好。不需要学非常多的知识就能写出性能不错的代码。Rust 就不一样，它是类似于 C++的系统语言，比较复杂，用法非常多，可自定义的地方也很多，要写出高性能的代码可能需要下更多功夫。
