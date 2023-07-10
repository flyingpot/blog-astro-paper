---
author: Fan Jingbo
pubDatetime: 2019-01-21T11:09:10+08:00
title: GPG牛刀小试
postSlug: gnupg
draft: false
tags:
  - 安全
ogImage: ""
description: GPG（或GnuPG）是自由软件基金会（Free Software Foundation）开发的程序，是基于商业加密软件PGP（Pretty Good Privacy）的作者（Phil Zimmermann）倡导提出的开放标准OpenPGP实现的，主要作用是加密，签名和生成非对称密钥对。
---

## 一、GPG 简介

GPG（或 GnuPG）是自由软件基金会（Free Software Foundation）开发的程序，是基于商业加密软件 PGP（Pretty Good Privacy）的作者（Phil Zimmermann）倡导提出的开放标准 OpenPGP 实现的，主要作用是加密，签名和生成非对称密钥对。

## 二、非对称加密与数字签名

要知道什么是非对称加密，就要先知道什么是对称加密。对称加密就是加密和解密使用相同的密钥，或者两个可以简单地相互推算的密钥。比如，经典的凯撒密码，就是将字母表进行移位映射加密，A 加密为 B，B 加密为 C，这样，反向移位就可以解密。然而，对称加密如果密钥泄露，安全就不复存在了。非对称加密就可以解决这个问题。

简单来说，非对称加密就是使用公钥加密传输，使用私钥解密。比如说 Alice 要向 Bob 传递信息，Bob 要先生成非对称密钥对，自己保留私钥，给 Alice 公钥。Alice 使用 Bob 的公钥加密信息，Bob 拿到加密信息后，使用自己的私钥解密查看信息。这就避免了因为密钥丢失导致的安全问题。

而数字签名，也是利用非对称加密技术的应用。首先，用 Bob 的私钥对文件加密（实际是文件的 hash 结果），加密的结果作为数字签名发送给 Alice。Alice 拿到数字签名和文件，使用 Bob 的公钥解密数字签名，将得到的结果与文件的 hash 结果作对比，如果一致，证明文件确实是 Bob 签署的。

## 三、GPG 上手

本来我写了一些常用命令，后来发现没啥意思，命令随便一查就能查到。我就写一些比较有趣的东西吧。

### 1.Keyring

在密码学中，keyring 存储的是 key，十分形象，key 的 ring。在 GPG 中，如下命令：

```bash
gpg --list-keys
```

可以列出在 keyring 中的所有 key。其实 keyring 可以看成一个通讯录，里面存储的 key 可以看做是一个个收件人的信息，消息的发送过程就可以类比成加密。

### 2.Fingerprint

由于公钥很长，所以使用 fingerprint 来指代对应的公钥，相当于公钥的 ID。不过很多时候，使用公钥生成时输入的姓名和邮箱也可以找到对应的公钥，只不过不是一一对应的关系。

### 3.公钥签名（Key Signing）和 Key Signing Party

在非对称加密中，公钥的有效性十分重要。还是拿 Alice 和 Bob 举例子，如果 Eve 将自己的公钥伪装成 Bob 的公钥发送给 Alice，那么 Alice 就会用 Eve 的公钥加密数据，Eve 就可以使用自己的私钥解密得到数据。

因此，如果利用数字签名技术，第三个人 Dave 可以使用他的私钥对 Bob 的公钥进行签名，表明他认可这个公钥的真实性，这样 Alice 就可以使用 Dave 的公钥验证出 Dave 对这个公钥进行了数字签名。这样 Dave 就类似于一个担保人，证明该公钥属于 Bob。

既然 Dave 可以签名，那么其他人也可以签名。可以认为签名的人越多，公钥越可信。密码学中，有一个概念是信任网络（Web of Trust）。它的提出者也是 PGP 的提出者 Phil Zimmermann 是这样说的：

> As time goes on, you will accumulate keys from other people that you may want to designate as trusted introducers. Everyone else will each choose their own trusted introducers. And everyone will gradually accumulate and distribute with their key a collection of certifying signatures from other people, with the expectation that anyone receiving it will trust at least one or two of the signatures. This will cause the emergence of **a decentralized fault-tolerant web of confidence for all public keys**.

既然公钥签名这么好，那么如何找到为你的公钥签名的人呢？这就不得不提到一个神奇的东西——Key Signing Party. 最开始我看到它是在 GPG 的官方文档里，我还以为是一种幽默的说法，没想到这个 party 是真实存在的。根据[维基百科][1]和[Ubuntu Wiki][2]，在这个 party 上，一群人手里拿着小本子，记录下其他人的公钥 fingerprint。然后回家之后，用自己的私钥为这些公钥签名，然后将这些签名后的公钥通过邮件发送给对应的接收人。甚至还有人开发了相关的[工具包][3]来做这些事。

![key_signing_party][image-1]

### 4.公钥分发

当你生成了自己的公钥，如何将公钥进行分发。当然，将公钥存在文件中传给别人是一个可选项：

```bash
gpg --armor --export you@example.com > mykey.asc
```

但是，有一个更方便的方法——上传到 key server：

```bash
gpg --keyserver pgp.mit.edu --send-keys [Fingerprint]
```

上传完成后，其他人就可以通过 fingerprint 来获取公钥：

```bash
gpg --keyserver pgp.mit.edu --recv-keys [Fingerprint]
```

签名后的公钥也可以上传到 key server 进行分发。

[1]: https://en.wikipedia.org/wiki/Key_signing_party
[2]: https://wiki.ubuntu.com/KeySigningParty
[3]: https://tracker.debian.org/pkg/signing-party
[image-1]: /assets/key_signing_party.jpeg
