---
author: Fan Jingbo
pubDatetime: 2018-02-05T01:44:15+08:00
title: "[Leetcode] Heaters"
postSlug: leetcode_heaters
featured: true
draft: false
tags:
  - LeetCode
  - 算法
ogImage: ""
description: 有两个数组，一个数组代表house位置，另一个代表heater位置。这种类型题一般来说都是**固定一个数组，遍历另一个数组**。固定house，遍历heater明显不对。因为heater的相互位置没有考虑，结果一定偏大。以下图为例，两个数组分别为：[0, 3], [1, 2]，如果分别遍历1和2，则结果至少是2，实际应该是1.所以应该固定heater，遍历house。
---

## 一、题目描述

[链接][1]

## 二、题目分析

有两个数组，一个数组代表 house 位置，另一个代表 heater 位置。这种类型题一般来说都是**固定一个数组，遍历另一个数组**。固定 house，遍历 heater 明显不对。因为 heater 的相互位置没有考虑，结果一定偏大。以下图为例，两个数组分别为：[0, 3], [1, 2]，如果分别遍历 1 和 2，则结果至少是 2，实际应该是 1.所以应该固定 heater，遍历 house。

思路确定之后，解法就很明显了。解法一：对每个 house 位置，用二分法找到最近的 heater 位置，最后取位置的最大值即为解，因为用了二分法，所以 heater 数组需要先进行排序。解法二：把 house 和 heater 两个数组都进行排序，然后遍历 house，每次记住最近的 heater 位置，下次遍历时从记住的位置开始，最后取位置最大值为解。

## 三、代码

### 解法一：

```python
heaters.sort()
res = 0
for house in houses:
    start = 0
    end = len(heaters) - 1
    while start + 1 &lt; end:
        mid = start + (end - start) / 2
        if heaters[mid] > house:
            end = mid
        else:
            start = mid
    res = max(res, min(abs(house - heaters[start]), abs(heaters[end] - house)))
return res
```

### 解法二：

```python
houses.sort()
heaters.sort()
i, res = 0, 0
for house in houses:
    while i &lt; len(heaters) - 1 and heaters[i] + heaters[i + 1] &lt;= house * 2:
        i += 1
    res = max(res, abs(heaters[i] - house))
return res
```

[1]: https://leetcode.com/problems/heaters/description/
