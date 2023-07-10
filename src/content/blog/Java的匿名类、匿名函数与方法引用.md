---
author: Fan Jingbo
pubDatetime: 2020-11-07T16:00:00Z
title: "Java的匿名类、匿名函数与方法引用"
postSlug: java-anonymous-class-lambda-method-reference
draft: false
tags:
  - Java
ogImage: ""
description: 从我接触Java伊始，就见过了很多匿名函数，最典型的是Java的多线程，写法如下：
---

### 一、前言

从我接触 Java 伊始，就见过了很多匿名函数，最典型的是 Java 的多线程，写法如下：

```java
new Thread(() -> {
    for (int i = 0; i < 100; i++) {
        System.out.println(i);
    }
}).start();
```

起初我十分不理解这是一种什么写法，经过查询也只知道这是一种叫 Lambda 函数的东西，看了很多文章之后也没能很好的理解。现在是终于搞懂了，所以写一篇总结来帮助我梳理一下相关知识。

### 二、匿名类与匿名函数

匿名类，顾名思义就是没有类名字的类。匿名函数相对应的就是没有名字的函数。因为没有名字，两者都适用于定义一个不需要被重用的类或者方法的场景。其实这两者是共通的。在我的理解里，匿名函数是对匿名内部类的进一步简化抽象。对于匿名类来说，一般都是需要实现多个方法时使用的。例子如下：

```java
interface Pet {
    String getName();
    String getAge();
}

class PetShop {
    static void sell (Pet pet) {
        System.out.println("Pet name is " + pet.getName()
                + "\nPet age is " + pet.getAge());
    }

    public static void main(String[] args) {
        PetShop.sell(new Pet() {
            @Override
            public String getName() {
                return "Ruby";
            }

            @Override
            public String getAge() {
                return "10";
            }
        });
    }
}
```

可以看到，在这个例子中，PetShop 这个类的 sell 方法会用到 Pet 接口的实现类，但是这个实现类只需要使用一次，不需要复用（因为这里面逻辑是出售）。在这种情况下就可以使用匿名类，在不定义类名的情况下实现两个方法即可。

但是在只需要实现接口一个方法的情况下，我们可以简化上面的使用方式，使用匿名函数，也就是 Lambda 表达式：

```java
interface Pet {
    String getName();
}

class PetShop {
    static void sell (Pet pet) {
        System.out.println("Pet name is " + pet.getName());
    }

    public static void main(String[] args) {
        PetShop.sell(() -> "Ruby");
    }
}
```

使用了 Lambda 表达式之后一下子少了很多行代码。Lambda 表达式分为两部分，用->分开，左边是方法的参数，右边是返回值。相比匿名类的实现方式，删除了接口信息和方法名。其实仔细想想就知道为什么这些东西都能删掉。接口信息在 sell 方法中有定义，方法调用也有，并且由于只有一种方法需要实现，所以根本不需要纠结，只需要把 Lambda 右边的返回值赋值给 pet.getName()就好了。

再用 Comparator 接口举个例子：

```java
List<Integer> integers = new ArrayList<>(Arrays.asList(5, 4, 3, 2, 1, 0));
Comparator<Integer> comparator1 = new Comparator<Integer>() {
    @Override
    public int compare(Integer o1, Integer o2) {
        return o1.compareTo(o2);
    }
};
Comparator<Integer> comparator2 = (o1, o2) -> o1 > o2 ? 1 : 0;
integers.sort(comparator1);
integers.sort(comparator2);
```

Comparator 中需要实现 compare 方法，而 sort 里面需要传入一个 Comparator 实例，最终实例的 compare 方法会被调用，来决定排序的规则。可以用匿名类和匿名函数两种方式来实现，这种情况下自然是 Lambda 表达式更简洁了。但是说实话对于不了解的人来说，Lambda 表达式还是有着一定的理解门槛的。

### 三、方法引用

匿名函数 Lambda 表达式其实仍然不是最简化的调用方法，因为我们可以发现参数有可能也可以省略，这就是所谓的方法引用，还是拿 Comparator 举例子：

```java
Comparator<Integer> comparator3 = Integer::compareTo;
integers.sort(comparator3);
```

可以看到，方法引用省去了参数，直接使用类::方法的形式实现匿名函数的效果。这里的方法可以是静态方法，也可以是实例方法（就如同这个例子一样，第一个参数是实例方法的调用者，第二个参数是实例函数的参数），甚至类也可以是一个实例，非常灵活。

对于具体参数如何调用的，可以参考以下三句话：

1. 成员方法的方法签名，前面会追加 this 的类型。
2. 静态方法的方法签名，因为没有 this, 不会追加任何东西。
3. 当 :: 前是一个实例时，这个实例会作为第一个参数给绑定到目标方法签名上。

但是对于一些不带参数的方法调用，方法引用也不太好用，比如文章刚开始的多线程例子就没法使用方法引用的方式表达。

### 四、总结

可以看出，匿名类、匿名函数与方法引用三者抽象程度越来越高，适用范围越来越小。经过这一番探究，现在再回头看文章第一部分的多线程代码就十分简单了：start()调用会调用 Lambda 表达式的右边部分（实际上是 run 方法），所以这个线程会打印 0-99 的数字。后续打算再写一篇关于 Thread 源码的分析，敬请期待。
