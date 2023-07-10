---
author: Fan Jingbo
pubDatetime: 2019-01-13T14:39:57+08:00
title: "[Leetcode] Add Two Numbers"
postSlug: leetcode_add_two_numbers
draft: false
tags: ["LeetCode", "算法"]
ogImage: ""
description: 题目很容易理解，将两个用链表表示的数相加，结果也用链表表示，三个链表都是倒序(reverse order)表示的。其实倒序算是简化了题目，如果不倒序实现相加，由于要考虑进位的问题，需要先将链表翻转。
---

## 一、题目描述

[链接][1]

## 二、题目分析

题目很容易理解，将两个用链表表示的数相加，结果也用链表表示，三个链表都是倒序(reverse order)表示的。其实倒序算是简化了题目，如果不倒序实现相加，由于要考虑进位的问题，需要先将链表翻转。
这道题有两种解法：一个是在遍历过程中实现按位的加法；还有一种就比较取巧了，先遍历两个链表，拿到对应的数字，然后相加，再将结果生成链表。
解法一要注意考虑进位的情况和链表节点为空的情况，进位只可能是 0 或 1，通过整除 10 计算(注：在 Python3 中//表示整除，在 Python2 中/表示整除)，其中一个链表节点为空时就只计算另一个链表的对应节点和进位的和。解法一另外还有一种写法，就是只考虑节点存在的情况。
解法二比较简单，需要注意的是要做两次字符串翻转，得到两个链表代表的倒序数字后要翻转一次才能做加法，做完加法的数字要翻转回来成倒序存到链表里。

## 三、代码

### 解法一：

```python
#第一种写法
head = ListNode(0)
L = head
flag = 0
while l1 or l2:
    if not l1:
        L.next = ListNode((l2.val + flag) % 10)
        flag = (l2.val + flag) // 10
        l2 = l2.next
    elif not l2:
        L.next = ListNode((l1.val + flag) % 10)
        flag = (l1.val + flag) // 10
        l1 = l1.next
    else:
        L.next = ListNode((l1.val + l2.val + flag) % 10)
        flag = (l1.val + l2.val + flag) // 10
        l1 = l1.next
        l2 = l2.next
    L = L.next
if flag:
    L.next = ListNode(1)
return head.next

#第二种写法
head = ListNode(0)
L = head
flag = 0
while l1 or l2:
    sum = flag
    if l1:
        sum += l1.val
        l1 = l1.next
    if l2:
        sum += l2.val
        l2 = l2.next
    if sum >= 10:
        flag = 1
        L.next = ListNode(sum%10)
    else:
        flag = 0
        L.next = ListNode(sum)
    L = L.next
if flag:
    L.next = ListNode(1)
return head.next
```

### 解法二：

```python
def getnum(L):
    result = ''
    while L:
        result += str(L.val)
        L = L.next
    return int(result[::-1])
n1, n2 = getnum(l1), getnum(l2)
sum = n1 + n2
head = ListNode(0)
L = head
for i in str(sum)[::-1]:
    L.next = ListNode(int(i))
    L = L.next
return head.next
```

[1]: https://leetcode.com/problems/add-two-numbers/
