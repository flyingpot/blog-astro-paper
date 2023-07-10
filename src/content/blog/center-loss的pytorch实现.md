---
author: Fan Jingbo
pubDatetime: 2018-03-16T08:07:05+08:00
title: Center Loss的Pytorch实现
postSlug: center_loss_pytorch/
draft: false
tags:
  - 算法
  - Python
  - AI
ogImage: ""
description: Center Loss是2016年ECCV的一篇人脸识别[文章][1]中加入的新损失函数。原作者是使用Caffe实现的，有很多人实现了各种版本的Center Loss。但是我发现github上唯一的Pytorch版本并没有完全按照作者的方法来实现，我就打算修改一下。以下的思考都是在修改代码的过程中进行的
---

Center Loss 是 2016 年 ECCV 的一篇人脸识别[文章][1]中加入的新损失函数。原作者是使用 Caffe 实现的，有很多人实现了各种版本的 Center Loss。但是我发现 github 上唯一的 Pytorch 版本并没有完全按照作者的方法来实现，我就打算修改一下。以下的思考都是在修改代码的过程中进行的

## 一、Center Loss 的原理

要实现 Center Loss，必须知道 Center Loss 的原理。

Center Loss 一般是和 Softmax Loss 配合使用的，Softmax Loss 可以使类间距离变大，而 Center Loss 可以使类内距离更小，下面的图片能很形象地表现出 Center Loss 的作用。

![center_loss][image-1]
Center Loss 的流程大致如下：

1. 保存一个参数，这个参数存储的是 feature 的中心值，我们定义成 centers_param</p>
2. 前传过程中计算输入的特征值 features 与存储的参数之间的均方误差(MSE)

3. 反向传播时，feature 的梯度公式如下：
   ![derivative][image-2]
   中心值的梯度是由作者定义的，公式如下：

![center_loss_formula][image-3]
这样就会导致，Center Loss 层输入 feature 的梯度很容易求，直接自动求导即可，但是，中心值的参数就需要手动更新了。

> 注：作者定义的是变化而不是梯度，所以不需要乘学习率，但是需要乘以作者指定的一个系数。为了方便说明可以简化看作梯度）

## 二、Pytorch 中的 backward

那么到底该怎样手动更新呢？要搞清楚这点首先要了解 Pytorch 中的`backward`方法

我们看一下官方文档中`backward`的基本用法

![torch_autograd_backward][image-4]
从文档可以看出：

1. 当`variables`是标量时，不用指定`grad_variables`（事实上，此时`grad_variables`为 1），这种情况就是一般的`loss.backward()`这种用法。</p>
2. 当 variables 为非标量且`require_grad`为`True`时，需要指定`grad_variables`，文档中对`grad_variables`的解释为`“gradient of the differentiated function w.r.t. corresponding variables”`，其实意思就是损失函数相对与`variables`的梯度

因此`backward`可以实现两种情况，一种是傻瓜式的，给一个`loss`，`backward`可以把所有前层`require_grad=True`的梯度算出来；而另一种是从中间层开始往前算，这种就需要知道`grad_variables`了。原理和链式法则一模一样。

![back_propagation][image-5]

## 三、实现 Center Loss

到现在，解决方案已经呼之欲出了：进行两次`backward`即可。如图：

![backward][image-6]
Center Loss 层有两个变量，进行`loss.backward()`，两个变量都会求出对应的梯度。而`centers_param.backward(man_set_centers_grad)`，则可以直接把`man_set_centers_grad`赋值给`variable`的梯度，也就是存储中心值的梯度。那么我们连续进行以上两个`backward`，就可以实现想要的手动更新。不过需要注意的是，连续两次`backward`，会把两次梯度累加。所以在第一次`backward`后使用`zero_grad()`方法，把梯度置零即可。

> 我的代码：[https://github.com/flyingpot/center_loss_pytorch][2]

[1]: https://ydwen.github.io/papers/WenECCV16.pdf
[2]: https://github.com/flyingpot/center_loss_pytorch
[image-1]: /assets/center_loss.jpeg
[image-2]: /assets/derivative.png
[image-3]: /assets/center_loss_formula.png
[image-4]: /assets/torch_autograd_backward.png
[image-5]: /assets/back_propagation.png
[image-6]: /assets/backward.png
