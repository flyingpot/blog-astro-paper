---
author: Fan Jingbo
pubDatetime: 2017-03-27T03:26:57+08:00
title: Python、$PATH和虚拟环境
postSlug: python_path
featured: true
draft: false
tags:
  - Python
ogImage: ""
description: 半年前我在运行一个Python程序的时候，发现运行程序报错，而且怎么也解决不了。当时我还不会用git，但即便会用也无计可施，因为我压根就没改过那段程序。依稀记得当时我情绪爆炸，对出现的问题根本没有头绪
---

![import_sys_carbon][image-1]

## 一

半年前我在运行一个 Python 程序的时候，发现运行程序报错，而且怎么也解决不了。当时我还不会用 git，但即便会用也无计可施，因为我压根就没改过那段程序。依稀记得当时我情绪爆炸，对出现的问题根本没有头绪。

我的大神室友知道我遇到了问题，在听我说明情况后，轻描淡写地坐下来，打出了一个指令

```bash
which python
```

然后他看了看输出，问我最近有没有装奇怪的东西，我一脸懵逼，但仔细一想确实装了 Anaconda（一个 Python 的科学计算环境）。但是那是一个星期前的事啊。大神不屑地瞟了我一眼，又问我：“你是不是最近重启过？”我一想确实，那天 mac 有点卡，实在受不了，所以不得已重启了一下。当我还在懵逼的时候，大神已经开始潇洒地敲打键盘，不一会儿就帮我调试好了。“哇！好棒！”我抱着电脑开始跑起自己的程序，无视掉了旁边准备装逼的大神。。。

## 二

半年过去，Python 我也用了不少，但是对于 Python 包的路径还有像是 virtualenv、conda 这样的虚拟环境原理还不是很明白，这两天研究了一下，再与当时大神的风骚操作相印证，自己也是明白了一些东西。

### 1. which 命令

具体的参数可以`man which`看，用处就是在环境变量$PATH 中找到命令对应的路径。所以`which python`输出的就是 Python 命令的路径

### 2. python 路径

系统安装的 python 解释器路径是`/usr/bin/python`，pyhton 包的路径是`/usr/lib/python/...`，可以这样验证：

```python
$ python
>>> import sys
>>> print(sys.path)
['', '/usr/lib/python36.zip', '/usr/lib/python3.6', '/usr/lib/python3.6/lib-dynload', '/usr/lib/python3.6/site-packages']
```

在`import`一个包的时候，python 解释器会按照这个 list 从前往后的顺序来寻找这个包，在前面找到就不会继续找了。

### 3. $PATH

PATH 这个环境变量可以用`echo $PATH`来输出查看，作用是记录可执行文件的存放路径。和 Python 导入模块一样，操作系统也是从前往后依次查找的。

Anaconda 会在一个新的地方安装 Python 环境，如`~/anaconda/bin/python`和`~/anaconda/lib/...`，然后在安装过程中会在`~/.bashrc`这个 bash 配置文件中加上\$PATH：`export PATH="/home/[username]/anaconda/bin:$PATH"`，这样重新打开 bash 后调用的 Python 和包就是 Anaconda 安装的版本了。这也是为什么我当时安装完之后运行 Python 没有发现异常，但是重启之后出错的原因。

### 4. 虚拟环境

创建虚拟环境的好处有很多，很重要的一个好处就是可以在不同的环境下跑不同的程序，从而解决包的冲突问题。其实虚拟环境的原理也很简单，就是在一个新路径下创建一个新的 Python 环境，每次进入虚拟环境，就会在$PATH 中加入那个路径，这样调用的就是该路径下的 Python 环境。这样的话，每个环境都对应自己的路径，冲突问题就被解决了。

#### 参考链接

1. [Python Ecosystem an Introduction][1]
2. [EnvironmentVariables][2]

[1]: http://mirnazim.org/writings/python-ecosystem-introduction/
[2]: https://help.ubuntu.com/community/EnvironmentVariables
[image-1]: /assets/import_sys_carbon.png
