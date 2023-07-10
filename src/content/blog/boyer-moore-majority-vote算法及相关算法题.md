---
author: Fan Jingbo
pubDatetime: 2017-11-24T04:35:46.000+00:00
title: Boyer-Moore Majority Vote算法及相关算法题
postSlug: boyer_moore_majority_vote
draft: false
tags:
  - 算法
ogImage: ""
description: Boyer-Moore Majority Vote算法（以下简称BMMV算法）是用来在一系列元素中查找主要元素的算法，具有O(n)的时间复杂度和O(1)的空间复杂度。该算法在1981年由Robert S. Boyer和J Strother Moore提出。
---

## 一、算法简介

Boyer-Moore Majority Vote 算法（以下简称 BMMV 算法）是用来在一系列元素中查找主要元素的算法，具有 O(n)的时间复杂度和 O(1)的空间复杂度。该算法在 1981 年由 Robert S. Boyer 和 J Strother Moore 提出。

> Tips: Robert S. Boyer 和 J Strother Moore 两人在 1977 年提出了 Boyer-Moore 字符串搜索算法，也是一个很经典的算法

## 二、问题描述

### 1. Leetcode 169 (Majority Element)

> 给定含有 n 个元素的数组，寻找其主元素（出现超过 n/2 下界次的元素）

#### **题解：**

本题有多种解法，排序，哈希表都可以 AC。先说一下比较巧妙的排序法。

```python
class Solution:
  def majorityElement(self, nums):
      return sorted(nums)[len(nums)//2]
```

主要原理就是，只要主元素存在，数组索引为 len(nums)//2 处的值一定是主元素（对于奇数长度的数组，中位数一定是主元素；对于偶数长度的数组，中间的两个数一定都是主元素）。

哈希表的方法见下文。

下面是 BMMV 算法的实现代码：

```python
class Solution:
  def majorityElement(self, nums):
      count = 0
      candidate = None

      for num in nums:
          if count == 0:
              candidate = num
          count += (1 if num == candidate else -1)

      return candidate
```

可以看出，BMMV 算法思想很简单，初始化 count 为 0，每当 count 为 0 时，candidate 为数组中下一个数，遍历数组，如果数等于 candidate，则 count 加一，否则减一，最后返回 candidate 即为主元素

### 2. Leetcode 229 (Majority Element II)

> 给定含有 n 个元素的数组，寻找所有出现超过 n/3 下界次的元素

#### **题解：**

> Tips: 最多存在两个所求元素

BMMV 算法代码如下

```python
class Solution:
    def majorityElement(self, nums):
        if not nums:
            return []
        count1, count2, candidate1, candidate2 = 0, 0, None, None
        for n in nums:
            if n == candidate1:
                count1 += 1
            elif n == candidate2:
                count2 += 1
            elif count1 == 0:
                candidate1, count1 = n, 1
            elif count2 == 0:
                candidate2, count2 = n, 1
            else:
                count1, count2 = count1 - 1, count2 - 1
        return [n for n in (candidate1, candidate2)
                        if nums.count(n) > len(nums) // 3]
```

类似上一题，由于最多两个元素，所以设两个 count 和 candidate，遍历数组，最后验证两个 candidate 是否满足题意

本题依旧可以用哈希表求解，代码如下：

```python
class Solution:
    def majorityElement(self, nums):
        count = collections.Counter(nums)
        return [key for (key, value) in count.items() if value > len(nums) // 3]
```

## 三、总结

BMMV 算法可以看做是主元素相关问题的特解，而如果主元素个数要求变到 n/k 的话，使用 BMMV 算法无法写出一个通解。这时哈希表可以作为一种通解。

### P.S.

Lintcode 类似题的主元素个数的下界分别为 n/2、n/3、n/k，并且加上了条件'There is only one majority number in the array'，这么一改题目立马变得很 low，因为只要找到数组中出现最多的元素就可以了，代码如下：

```python
class Solution:
    def majorityElement(self, nums):
        counts = collections.Counter(nums)
        return max(counts.keys(), key=counts.get)
```

#### 参考链接

1\.[Majority Voting Algorithm](https://gregable.com/2013/10/majority-vote-algorithm-find-majority.html)

2\.[Boyer–Moore majority vote algorithm (Wiki)](https://en.wikipedia.org/wiki/Boyer%E2%80%93Moore_majority_vote_algorithm)
