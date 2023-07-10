---
author: Fan Jingbo
pubDatetime: 2020-08-15T16:00:00Z
title: CTF从零单排（二）—— bof (pwnable.kr)
postSlug: ctf2
draft: false
tags:
  - CTF
ogImage: ""
description: 查看题目给出的信息，一个C代码文件和一个可执行文件，C代码文件如下：
---

# 一、题目分析

查看题目给出的信息，一个 C 代码文件和一个可执行文件，C 代码文件如下：

    #include <stdio.h>
    #include <string.h>
    #include <stdlib.h>
    void func(int key){
    	char overflowme[32];
    	printf("overflow me : ");
    	gets(overflowme);	// smash me!
    	if(key == 0xcafebabe){
    		system("/bin/sh");
    	}
    	else{
    		printf("Nah..\n");
    	}
    }
    int main(int argc, char* argv[]){
    	func(0xdeadbeef);
    	return 0;
    }

可以看出这道题考的是栈溢出，从标准输入读取的数据覆盖掉 func 传入的参数值即可提权。关键问题就是如何构造这个数据。

## 二、题解

使用 gdb 对可执行文件 bof 进行分析：

首先使用 start 开始执行，方便之后使用地址打断点

然后使用 disas func 查看 func 函数的汇编代码

找到 get 函数调用后的比较语句并打断点

使用 c（continue）继续执行代码

输入 AAAAAA，使用 x /40xw $esp 查看栈数据。A 用 16 进制表示是 41，可以看到第一个 A 到 deadbeef 相差 52 个字节。因此我们只需要构造 52 个 A 加上 cafebabe 即可。

使用 Python 的 pwn 库：

成功拿到 flag

由此可见，C 代码中使用 gets 有多危险，使用 gcc 编译时也会提示 gets 的危险性。

## 三、遗留问题

虽然题目参考着其他人的题解做了出来，但是目前还是有两个问题我还没想明白，在这里记录一下：

1. 发现如果使用 gcc 默认编译选项编译出来的可执行文件（可能与 64 位有关），deadbeef 参数在低地址，标准输入参数在高地址，不符合栈帧是从高地址向低地址生长（申请）的原则，很奇怪
2. 为什么 0xdeadbeef 写入栈中的时候没有按照小端原则？

   问题已解决，因为 0xdeadbeef 是 int 类型，占据了 4 个字节，所以无所谓大端小端，在内存中就是以 0xdeadbeef 形式保存的
