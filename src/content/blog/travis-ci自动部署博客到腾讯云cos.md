---
author: Fan Jingbo
pubDatetime: 2019-04-05T03:00:00Z
title: travis-ci自动部署博客到腾讯云COS
postSlug: travis-ci_to_cos
draft: false
tags:
  - CI
  - 静态博客
  - Hugo
ogImage: ""
description: 我的博客使用的是hugo，博客一直放在腾讯云COS上，只要域名备案就能使用，加上CDN速度也不错。但是使用腾讯云COS更新博客，需要登录腾讯云控制台，手动把本地hugo生成的文件上传到COS上，十分痛苦并且一点也不geek。与之形成鲜明对比的就是netlify，部署十分方便，只要把hugo文件夹设置成github repo，仓库一更新，网站就会自动部署。再搭配上[forestry.io](https://forestry.io/)的hugo cms，博客更新就可以完全放在云上。因此我就想该如何解放双手，将上传过程简化。持续集成服务（Continuous Integration, CI）就是一个好的选择。
---

我的博客使用的是 hugo，博客一直放在腾讯云 COS 上，只要域名备案就能使用，加上 CDN 速度也不错。但是使用腾讯云 COS 更新博客，需要登录腾讯云控制台，手动把本地 hugo 生成的文件上传到 COS 上，十分痛苦并且一点也不 geek。与之形成鲜明对比的就是 netlify，部署十分方便，只要把 hugo 文件夹设置成 github repo，仓库一更新，网站就会自动部署。再搭配上[forestry.io](https://forestry.io/)的 hugo cms，博客更新就可以完全放在云上。因此我就想该如何解放双手，将上传过程简化。持续集成服务（Continuous Integration, CI）就是一个好的选择。

# Travis CI

因为之前看到别人 github 的 repo 里面有.travis.yml 文件，对于 Travis CI 有一定了解，因此我决定使用这个持续集成服务。在简单看了文档之后，我发现配置十分智能，直接使用 github 账号登录，然后就可以绑定对应的 repo。之后就可以在对应 repo 里面加入.travis.yml 文件，在这个文件里面就可以加入脚本等内容，Travis CI 就会根据这个配置文件进行对应的构建和部署。

举个例子：

```yaml
language: python
python:
  - "2.6"
  - "2.7"
  - "3.3"
  - "3.4"
  - "3.5"
  - "3.5-dev" # 3.5 development branch
  - "3.6"
  - "3.6-dev" # 3.6 development branch
# command to install dependencies
install:
  - pip install -r requirements.txt
# command to run tests
script:
  - pytest
```

可以看到，配置文件中可以设置语言和版本，安装依赖并且运行脚本，相当的自由。我们的构建环境需要 Go 和 Python 两个环境（需要 hugo 生成静态文件，需要 Python 上传静态文件到腾讯 COS），Travis CI 是可以使用两种语言环境的，如下：

    matrix:
      include:
        - language: go
          ...
        - language: python
          ...

但是在尝试的过程中遇到了两个问题，一个是 golang 和 hugo 在 Travis CI 中的构建过程太慢

![](/assets/go_slow.png)

另一个问题就很严重了，Travis CI 不支持两种语言环境先后构建，只支持的是多语言同时构建。这样就没法满足我的要求。由于我更熟悉 Python，所以选择了 Python 这一种语言环境进行构建。

那么问题来了，如何在不引入 Go 环境的情况下安装 Hugo 呢？其实很简单，Hugo 是有 deb 包的，安装很方便。

```bash
wget https://github.com/gohugoio/hugo/releases/download/v0.54.0/hugo_0.54.0_Linux-64bit.deb
sudo dpkg -i hugo*.deb
```

# 使用 Python 脚本上传文件到 COS

接下来就是利用腾讯云提供的 Python SDK 上传 Hugo 生成的网站静态文件。脚本写起来很简单，先把 COS 中的文件全部删除，然后再将所有静态文件全部上传。

需要注意的是，由于脚本中需要使用腾讯云的 tokens，这些 tokens 肯定不能用明文存放在 repo 里。我们可以把 tokens 放在 Travis 提供的环境变量中。

脚本如下：

```Python
from qcloud_cos import CosConfig
from qcloud_cos import CosS3Client
import os
import sys
import logging

logging.basicConfig(level=logging.INFO, stream=sys.stdout)

secret_id  = os.environ['SECRET_ID']
secret_key = os.environ['SECRET_KEY']
region = os.environ['REGION']
bucket = os.environ['BUCKET']
token = None
scheme = 'https'

config = CosConfig(Region=region, SecretId=secret_id, SecretKey=secret_key, Token=token, Scheme=scheme)

client = CosS3Client(config)

response = client.list_objects(
    Bucket=bucket
)

if 'Contents' in response:
    for metadata in response['Contents']:
        response = client.delete_object(
            Bucket=bucket,
            Key=metadata['Key']
        )

os.chdir('public')

for root, _, files in os.walk('.'):
    for file in files:
        object = os.path.join(root, file)

        with open(object, 'rb') as fp:
            response = client.put_object(
                Bucket=bucket,
                Body=fp,
                Key=object
            )
```

最终的.travis.yml 如下：

```yaml
language: python
python:
  - "3.6"
install:
  - wget https://github.com/gohugoio/hugo/releases/download/v0.54.0/hugo_0.54.0_Linux-64bit.deb
  - sudo dpkg -i hugo*.deb
  - pip install -r requirements.txt
script:
  - hugo
  - python upload_to_cos.py
```

至此，我们利用 Travis CI 提供的服务完成了 Hugo 静态博客的部署，更新博客只需要 commit 即可。
