---
author: Fan Jingbo
pubDatetime: 2019-03-11T16:00:00Z
title: CTF从零单排（一）—— collision (pwnable.kr)
postSlug: ctf1
draft: false
tags:
  - CTF
ogImage: ""
description: 最近突然对CTF产生了兴趣，感觉能从中学到很多东西。并且我发现很多关于CTF的解法文章对我这样的小白很不友好，因此我打算新开一坑，从零基础的角度详细地记录一下CTF的题解。
---

# 一、前言

最近突然对 CTF 产生了兴趣，感觉能从中学到很多东西。并且我发现很多关于 CTF 的解法文章对我这样的小白很不友好，因此我打算新开一坑，从零基础的角度详细地记录一下 CTF 的题解。

# 二、题目及分析

今天做的题目是 pwnable.kr 里面的第二题——collision（第一题比较简单，就直接跳过了）。先是用 ssh 连到一个提供的主机上，发现目录下有三个文件。
![](/assets/ls-l.png)
col.c 的代码如下：

```c
#include <stdio.h>
#include <string.h>
unsigned long hashcode = 0x21DD09EC;
unsigned long check_password(const char* p){
        int* ip = (int*)p;
        int i;
        int res=0;
        for(i=0; i<5; i++){
                res += ip[i];
        }
        return res;
}

int main(int argc, char* argv[]){
        if(argc<2){
                printf("usage : %s [passcode]\n", argv[0]);
                return 0;
        }
        if(strlen(argv[1]) != 20){
                printf("passcode length should be 20 bytes\n");
                return 0;
        }

        if(hashcode == check_password( argv[1] )){
                system("/bin/cat flag");
                return 0;
        }
        else
                printf("wrong passcode.\n");
        return 0;
}
```

我们可以看到最后是调用 cat 命令读取 flag 文件。而我们的当前用户如下图所示： ![](/assets/id.png)

那么到底为什么用户不能直接读取 flag 文件而通过 col 这个可执行文件就能读取呢？

# 三、文件系统权限

回忆一下文件系统权限：第一位是文件类型，一般常见的就两种，-代表普通文件，d 代表目录。其实还有很多别的类型，通过以下命令可以看到：

```bash
info ls "What information is listed"
```

后面一共九位，可以被分为三组，代表文件拥有者权限，群组权限和其他用户权限。每一组按顺序分别代表读(Read)，写(Write)和执行(Execute)。对于读和写比较简单，r 或 w 代表可读或可写，-代表不可读(写)。执行位除了 x(可执行)和-(不可执行)外，还有其他可能，常见的就是 s。s 代表 x 被激活，另外只可能出现在前两组里面，分别被称为 setuid 和 setgid。当可执行文件被设置 setuid 或 setgid 时，可执行文件拥有的权限是可执行文件的文件拥有者或群组权限，而不是当前的用户或者群组所拥有的权限。

说起来挺绕口，但其实很好理解，拿这道题举例子来串联上面的所有知识：当前用户属于 col 群组，而 col 可执行文件的群组权限是 x，也属于 col 群组，所以当前用户可以执行 col 文件，而又因为 col 的 setuid 被激活，执行 col 文件相当于 col_pwn 这个用户执行 col 文件，而 flag 文件又是属于 col_pwn 用户的，所以运行 col 文件可以读取 flag 文件的内容。

# 四、字节序

接下来看看题目要我们做什么，我们只需要让`check_password(argv[1])`等于`hashcode`即可。而在`check_password`函数中有强制类型转换，这就牵扯到了字节序的问题。

字节序有几个很容易让人疑惑的地方，但是经过总结，我认为只要理解了下面这段话，所有疑惑都会迎刃而解：

> 字节序只影响占用多个字节的对象，并且只有在以下三种情况需要注意字节序：（1）不同字节序的机器传递数据时（2）阅读和检查机器级程序或查看数据在内存中的存储方式时（3）编写规避正常类型系统的程序时（如强制类型转换）

而实际上前两种情况我们基本不用考虑，最常见的就是第三种情况。

下面是两个常见的问题，看看是不是能用这句话轻松解决：

1. 字节序对于数组是怎么影响的？[示例 1](https://stackoverflow.com/questions/26455843/how-are-array-values-stored-in-little-endian-vs-big-endian-architecture)

数组每个元素的顺序是与字节序无关的，`array[1]`永远在`array[0]`一个`sizeof(*array)`之后的位置。如果数组中的元素含有多个字节，那么这个元素在内存中的存储方式会受到字节序的影响。

1. 字节序对于指针是怎么影响的，指针指向的是最高有效位(MSB)还是最低有效位(LSB)？[示例 2](https://stackoverflow.com/questions/11985399/does-a-pointer-point-to-the-lsb-or-msb)

与数组相似，取地址永远取的是低地址，对于占用多个字节的变量指针来说，小端字节序指针指向的是最低有效位，大端字节序指针指向的是最高有效位。

接下来我们举一个强制类型转换的例子对字节序进行说明：

```c
#include<stdio.h>
int main() {
	char *a = "1234";
	int *b = (int *)a;
	printf("%#010x\n", *b);
}
```

在这个例子中，变量`a`是一个字符串指针，每一个`char`对应一个字节，共有四个字节，`a`指向的地址是`1`对应的地址。将“1234”这个字符串对照 ASCII 表可以转化成十六进制表示 0x31323334.

`a`经过强制类型转换变成了整型指针`b`，同样整型也是 4 个字节，这时计算机是怎么读取整型数取决于字节序。读取过程是这样的：首先找到地址，对应 0x31 这个值，接下来如果是大端字节序，那么向高地址读取 4 个字节，对应 0x31323334，如果是小端字节序，那么向低地址读取 4 个字节，对应 0x34333231.

在我的电脑上运行如上代码，结果为 0x34333231，说明电脑是小端字节序。Python 中查看字节序的方法如下：

```python
import sys
print(sys.byteorder)
```

# 四、解题思路

现在回到题目中，输入一个 20 个字节长的字符串，做整型的强制类型转换，每 4 个字节变为一个整型数，将 5 个整型数累加得到指定值 0x21DD09EC。一个最简单的想法是，将原来的数 0x21DD09EC 与 4 个零值累加。

```shell
python -c "print '\x00\x00\x00\x00'*4 + '\xec\x09\xdd\x21'"
```

使用上面的单行脚本可以生成`col`的标准输入`argv[1]`

![](/assets/python-c.png)

因此：

```shell
./col `python -c "print '\x00\x00\x00\x00'*4 + '\xec\x09\xdd\x21'"`
```

注意由于是小端字节序，0x21DD09EC 要写成 0xEC09DD21。上面的符号\`代表命令替换，使用括起来命令的标准输出作为替换。

但是我们会发现出现了错误提示"passcode length should be 20 bytes"。原因在于 0x00 代表了 null，并且作为字符串的结束符使用，因此读入的字符串会被截断，出现错误输出。

那既然 0x00 不行，那我们就用 0x01 代替，则：

```python
>>> hex(0x21DD09EC-0x01010101*4)
'0x1dd905e8'
```

```shell
./col `python -c "print '\x01\x01\x01\x01'*4 + '\xe8\x05\xd9\x1d'"`
```

大功告成，成功拿到 flag。

#### 参考链接

1. [ File Permissions and Attributes ](https://wiki.archlinux.org/index.php/File_permissions_and_attributes)
2. [Setuid](https://en.wikipedia.org/wiki/Setuid)
3. [深入理解计算机系统](https://book.douban.com/subject/1896753/)
4. [What does \` (backquote/backtick) mean in commands?](https://unix.stackexchange.com/questions/27428/what-does-backquote-backtick-mean-in-commands)
