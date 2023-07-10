---
author: Fan Jingbo
pubDatetime: 2018-02-28T03:39:05+08:00
title: Selenium踩坑记
postSlug: selenium
draft: false
tags:
  - Python
ogImage: ""
description: Selenium是一个浏览器自动化测试工具，支持所有主流的浏览器，并且有各种语言的接口，也就是说通过写代码就可以模拟各种浏览器操作。我主要是用Selenium写一个小脚本，实现某交易平台上的自动场外交易。
---

## 一、前言

Selenium 是一个浏览器自动化测试工具，支持所有主流的浏览器，并且有各种语言的接口，也就是说通过写代码就可以模拟各种浏览器操作。我主要是用 Selenium 写一个小脚本，实现某交易平台上的自动场外交易。

> Selenium 也有化学元素硒的意思

## 二、环境配置

配置 Selenium 需要三个组件，一个是 Selenium Client API，一个是 WebDriver，最后是浏览器。简单来说就是 API 控制 WebDriver，WebDriver 控制浏览器，来实现通过代码对浏览器进行操作，流程十分清晰。

首先是 Selenium，由于我只会 Python(哭)，所以我选择安装 Python 版本的 Selenium

```python
pip install selenium
```

虚拟环境配置就不再赘述了。

然后是 WebDriver，不同的浏览器对应的 WebDriver 也不同。我这次使用的是 Firefox，对应的 WebDriver 叫 geckodriver(https://github.com/mozilla/geckodriver/releases)，下载下来扔到环境变量里即可。

最后也是最简单的——浏览器，四大主流浏览器(Chrome, Edge, Firefox, Safari）全都支持，看你喜好选择。注意 WebDriver 和浏览器版本要对得上，都升到最新版本就行。

三个组件都装好了，测试一下，打开 Python 解释器，输入以下代码：

```python
from selenium import webdriver
driver = webdriver.Firefox()
driver.get("https://fanjingbo.com")
```

如果能弹出浏览器并成功加载网页，说明环境配置成功。

## 三、Selenium 实战

Selenium 基本上能实现任何对浏览器的操作，在这里只讨论一些常用方法。

1. driver.get

driver.get 方法能使浏览器跳转到相应的网址，并且默认是等所有元素加载完毕语句才结束

2. driver.refresh

driver.refresh 能刷新页面，一般用于多次获取某页面里的数据。这里有一个小技巧，现在的页面大多是局部刷新的，我们需要的数据并不需要刷新整个页面，用 refresh 方法既慢也没必要，所以有时候根据实际情况，可以通过多次调用 driver.get 方法来实现快速刷新。

2. driver.find_element_by\_\*\\\*

对浏览器进行操作一定少不了元素的定位，这个方法可以用各种方式来定位元素，比如 xpath，css selector 等等。定位完之后，可以用 click()来点击，send_keys()来填充表单

3. WebDriverWait

比如填充了登录表单，点击了登录按钮，这个时候我们不能对新页面进行操作，因为页面还没有加载完毕。有两种解决方法，一种是直接设置等待几秒钟，Selenium 有 implicitly_wait()方法，或者直接 time.sleep()也可以，但是这种方式存在问题：如果网络有问题，页面加载非常缓慢的话，这种方式就失效了。所以一般都采用第二种方法 WebDriverWait，例子如下：

```python
from selenium.webdriver.support.wait import WebDriverWait
from selenium.webdriver.support import expected_conditions as expected
from selenium.webdriver.common.by import By

wb = webdriver.Firefox()
wb.get('https://fanjingbo.com')
wait = WebDriverWait(wb, timeout=10)
wait.until(expected.visibility_of_element_located((By.XPATH, "---相应的xpath---")))
```

代码实现的就是对应 xpath 的元素出现之前一直等待。

有了上面这些基础，再去看看文档，就会发现 Selenium 其实很简单，复杂的是你需要用 css_selector、xpath 等定位元素，要在浏览器中不停调试。

## 四、小插曲

PhantomJS 是一个 WebKit 内核的无界面浏览器引擎。网络上各种 Selenium 爬虫教程都是基于 PhantomJS 做的，然而当我打算使用 PhantomJS 来配合 Selenium 时，却看到这样一个 warning

> Selenium support for PhantomJS has been deprecated, please use headless versions of Chrome or Firefox instead

我查了一下，Selenium 不再支持 PhantomJS 有两个原因：一个是 Firefox 和 Chrome 都有了自己的 headless 模式，PhantomJS 寿命将尽；另一个是 PhantomJS 的 driver 从 2014 年就停止更新了，很多新标准都无法支持。

笔者在写下此文时，虽然会有 warning，但 PhantomJS 仍被 Selenium 支持。但是以后 PhantomJS 肯定会被移除。心疼 PhantomJS。
