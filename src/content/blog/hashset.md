---
author: Fan Jingbo
pubDatetime: 2020-08-26T16:00:00Z
title: 由缓存穿透想到的——HashSet和布隆过滤器
postSlug: bloomfilter
draft: false
tags:
  - Java
  - 缓存
ogImage: ""
description: 设想一种高并发场景，后台服务在查询数据库（如Mysql）之前先查缓存（如Redis）。如果缓存失效，大量无法在数据库中查询到结果的请求（如数据库中没有的ID查询）没有在Redis中查到内容，就会“穿透”我们的缓存服务，直接打到数据库上。这就有可能导致数据库因为压力过大而挂掉。
---

## 一、缓存穿透

设想一种高并发场景，后台服务在查询数据库（如 Mysql）之前先查缓存（如 Redis）。如果缓存失效，大量无法在数据库中查询到结果的请求（如数据库中没有的 ID 查询）没有在 Redis 中查到内容，就会“穿透”我们的缓存服务，直接打到数据库上。这就有可能导致数据库因为压力过大而挂掉。

> 这里要注意，缓存穿透与缓存击穿是不同的，击穿主要指大量请求查询某一个 key 的时候，这个 key 在缓存中是失效状态。这些查询就会“击穿”缓存。还有一个概念叫缓存雪崩，指的就是很多 key 都在缓存中失效了（或者干脆缓存服务挂掉了），导致数据库被打挂的情况。
> 可以这样理解，从穿透到击穿再到雪崩，是一个严重程度逐步递进的过程。

针对缓存穿透的问题，有两个解决方法：一个是缓存空值，也就是将值为 null 写入缓存；另一个就是加入一个过滤器，这个过滤器的作用是识别 key 是否在数据库中存在，如果存在则继续进入缓存——数据库查询，如果不存在则直接返回结果。

这种过滤器方法实际上可以用 HashSet 来实现。

## 二、HashSet 的原理

### 1.基本原理

在 Java 语言中，HashSet 是一个数据结构实现类，实现了 Set（集合）接口。这个数据结构主要特点就是无序并且唯一。对于缓存穿透的场景，只需要将数据库中的所有 key 写入 HashSet（add 方法），然后就可以通过 contains 方法查到 key 是否存在，从而实现这个过滤器。

### 2.源码分析

那么 HashSet 是如何实现 add 过程的去重和 contains 方法的呢？这时候就需要看代码了。可以发现 HashSet 实际上是复用了 HashMap 的方法（定义了一个空对象 PRESENT 填充到 value 中，十分巧妙）：

```java
    private transient HashMap<E,Object> map;

    // Dummy value to associate with an Object in the backing Map
    private static final Object PRESENT = new Object();

    /**
     * Constructs a new, empty set; the backing <tt>HashMap</tt> instance has
     * default initial capacity (16) and load factor (0.75).
     */
    public HashSet() {
        map = new HashMap<>();
    }
    public boolean add(E e) {
        return map.put(e, PRESENT)==null;
    }
    public boolean contains(Object o) {
        return map.containsKey(o);
    }
```

那么就看一下 HashMap 的 put 和 containsKey 方法是如何实现的：

```java
	public V put(K key, V value) {
        return putVal(hash(key), key, value, false, true);
    }

    static final int hash(Object key) {
        int h;
        // 与hashCode()的结果做异或的目的是为了增加低位的扰动，减小碰撞
        return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
    }

    final V putVal(int hash, K key, V value, boolean onlyIfAbsent,
                   boolean evict) {
        Node<K,V>[] tab; Node<K,V> p; int n, i;
        if ((tab = table) == null || (n = tab.length) == 0)
            // 扩容逻辑
            n = (tab = resize()).length;
        // (n-1) & hash等于hash % n,这里是找到写入的值落在哪个桶里
        if ((p = tab[i = (n - 1) & hash]) == null)
            // 如果桶是空的，直接写入
            tab[i] = newNode(hash, key, value, null);
        else {
            Node<K,V> e; K k;
            // 第一个节点冲突，退出
            if (p.hash == hash &&
                ((k = p.key) == key || (key != null && key.equals(k))))
                e = p;
            // 节点是树节点（当前是红黑树而不是链表），走树的相关逻辑
            else if (p instanceof TreeNode)
                e = ((TreeNode<K,V>)p).putTreeVal(this, tab, hash, key, value);
            // 其他情况（链表，且第一个节点不是）
            else {
                // 遍历链表
                for (int binCount = 0; ; ++binCount) {
                    // 插入链表最后
                    if ((e = p.next) == null) {
                        p.next = newNode(hash, key, value, null);
                        if (binCount >= TREEIFY_THRESHOLD - 1) // -1 for 1st
                            // 链表长度超过阈值，转红黑树
                            treeifyBin(tab, hash);
                        break;
                    }
                    // 在链表中间发现冲突
                    if (e.hash == hash &&
                        ((k = e.key) == key || (key != null && key.equals(k))))
                        break;
                    p = e;
                }
            }
            // 找到重复key值，开始替换value逻辑
            if (e != null) { // existing mapping for key
                V oldValue = e.value;
                if (!onlyIfAbsent || oldValue == null)
                    e.value = value;
                afterNodeAccess(e);
                return oldValue;
            }
        }
        ++modCount;
        if (++size > threshold)
            resize();
        afterNodeInsertion(evict);
        return null;
    }

    // constainsKey方法与上面的逻辑类似
    public boolean containsKey(Object key) {
        return getNode(hash(key), key) != null;
    }

    final Node<K,V> getNode(int hash, Object key) {
        Node<K,V>[] tab; Node<K,V> first, e; int n; K k;
        if ((tab = table) != null && (n = tab.length) > 0 &&
            (first = tab[(n - 1) & hash]) != null) {
            if (first.hash == hash && // always check first node
                ((k = first.key) == key || (key != null && key.equals(k))))
                return first;
            if ((e = first.next) != null) {
                if (first instanceof TreeNode)
                    return ((TreeNode<K,V>)first).getTreeNode(hash, key);
                do {
                    if (e.hash == hash &&
                        ((k = e.key) == key || (key != null && key.equals(k))))
                        return e;
                } while ((e = e.next) != null);
            }
        }
        return null;
    }
```

可以看到 HashMap 是数组加链表（红黑树）的结构，首先调用对象的 hashCode 方法落桶，然后在冲突的情况下进行遍历（在红黑树中查询），用 equals 方法去重。

### 3.equals 和 hashCode

其实通过上面的总结可以看出来，hashCode 相同是 equals 相同的充分不必要条件，也就是说 hashCode 相同不一定 equals 相同。这样子设计的目的是通过 hashCode 这种 O(1)复杂度的简单操作预先做一个分桶操作，这时候有碰撞的情况下再进行复杂度较高的 equals 操作，从而达到减小复杂度的目的。

这也是为什么如果自己重写一个类的 equals 方法，一定要重写 hashCode 方法的原因，因为不重写 hashCode 方法的话，就会出现 equals 相同而 hashCode 不同的情况，用在 HashSet 或者 HashMap 中就会出现问题。

### 4.时间复杂度

分桶的时间复杂度是 O(1)，但是无论是链表遍历（O(n)）还是红黑树查找(O(logn))的复杂度都是更高的。回到缓存穿透的问题上，我们需要实现一个过滤器来确认一个值是否存在，能否只用 O(1)的时间复杂度来实现呢？实际上是可以的，这其实就是布隆过滤器

## 三、布隆过滤器

布隆过滤器（Bloom Filter）的用处与 HashSet 类似，都是可以用来检索一个元素是否在一个集合中存在。它的时间和空间复杂度都是很低的。很多设计都是一种 trade-off，布隆过滤器也不例外，它的准确度其实不是 100%。但是布隆过滤器巧妙就巧妙在了它用了很小的代价实现了很好的时间和空间复杂度。

基于上面对于 HashSet 的讨论，其实我们能知道要实现好的时间复杂度剔除掉链表和红黑树的部分就好，只保留 O(1)的分桶操作。这种情况下逻辑是能满足过滤器要求的：不发生碰撞（分到一个桶里）的一定不在集合中存在。这样一来我们就可以通过这个过滤器过滤掉很多不在数据库中的查询。而且根据过滤器原理可以知道，碰撞率越低，过滤效果越好。

那么现在的问题就是如何减少空间复杂度和碰撞率了。布隆过滤器很巧妙的使用了位图和多次 hash 的方式解决了这两个问题。

引用一下维基百科的原理解释：

> 当一个元素被加入集合时，通过 K 个散列函数将这个元素映射成一个位数组中的 K 个点，把它们置为 1。检索时，我们只要看看这些点是不是都是 1 就（大约）知道集合中有没有它了：如果这些点有任何一个 0，则被检元素一定不在；如果都是 1，则被检元素很可能在。

这个解释非常清晰明确，我也不需要过多解释了。
