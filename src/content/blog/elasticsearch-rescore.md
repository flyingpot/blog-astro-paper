---
author: Fan Jingbo
pubDatetime: 2021-04-12T16:00:00Z
title: Elasticsearch插件开发——Rescore篇
postSlug: elasticsearch-plugin-rescore
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: 在ElasticSearch中，重打分是一个对指定数目的查询结果进行再次打分的一个过程。通常情况下，一个查询可能会匹配成千上万的结果，但用户很可能只对结果的前几页感兴趣。这种情况下就可以使用重打分功能来优化性能。但是，当前Elasticsearch中只默认实现了rescore_query功能，当我们需要自定义重打分过程时，默认的功能就不适用了。这时我们就需要通过Rescore插件的方式实现。
---

### 一、前言

在 ElasticSearch 中，重打分是一个对指定数目的查询结果进行再次打分的一个过程。通常情况下，一个查询可能会匹配成千上万的结果，但用户很可能只对结果的前几页感兴趣。这种情况下就可以使用重打分功能来优化性能。但是，当前 Elasticsearch 中只默认实现了 rescore_query 功能，当我们需要自定义重打分过程时，默认的功能就不适用了。这时我们就需要通过 Rescore 插件的方式实现。

本文通过分析 Elasticsearch 源码中自带的重打分插件用例来讲解如何开发 Rescore 插件。

### 二、插件入口

用例插件路径在 Elasticsearch 源码的 plugins/examples/rescore 路径下，可以看到除测试用例之外又有两个源码文件，其中 ExampleRescorePlugin 类定义了插件的入口

```java
public class ExampleRescorePlugin extends Plugin implements SearchPlugin {
    @Override
    public List<RescorerSpec<?>> getRescorers() {
        return singletonList(
                new RescorerSpec<>(ExampleRescoreBuilder.NAME, ExampleRescoreBuilder::new, ExampleRescoreBuilder::fromXContent));
    }
}
```

可以看到只需要重写 SearchPlugin 接口的 getRescore 方法就好。

### 三、重打分逻辑

然后我们来看核心类 ExampleRescoreBuilder 的实现：

1. 首先定义了两个实例变量 factor 和 factorField，这两个变量就作为我们自定义重打分的两个参数

```java
public class ExampleRescoreBuilder extends RescorerBuilder<ExampleRescoreBuilder> {
    public static final String NAME = "example"; // example作为自定义重打分的名字

    private final float factor;
    private final String factorField;

    public ExampleRescoreBuilder(float factor, @Nullable String factorField) {
        this.factor = factor;
        this.factorField = factorField;
    }
    ...
}
```

2. 然后是实际进行重打分的代码部分，如下：

```java
        @Override
        public TopDocs rescore(TopDocs topDocs, IndexSearcher searcher, RescoreContext rescoreContext) throws IOException {
            ExampleRescoreContext context = (ExampleRescoreContext) rescoreContext;
            int end = Math.min(topDocs.scoreDocs.length, rescoreContext.getWindowSize());
            // 自定义的第一部分逻辑，将重打分前的得分乘以factor参数
            for (int i = 0; i < end; i++) {
                topDocs.scoreDocs[i].score *= context.factor;
            }
            if (context.factorField != null) {
                /*
                 * Since this example looks up a single field value it should
                 * access them in docId order because that is the order in
                 * which they are stored on disk and we want reads to be
                 * forwards and close together if possible.
                 *
                 * If accessing multiple fields we'd be better off accessing
                 * them in (reader, field, docId) order because that is the
                 * order they are on disk.
                 */
                ScoreDoc[] sortedByDocId = new ScoreDoc[topDocs.scoreDocs.length];
                System.arraycopy(topDocs.scoreDocs, 0, sortedByDocId, 0, topDocs.scoreDocs.length);
                Arrays.sort(sortedByDocId, (a, b) -> a.doc - b.doc); // Safe because doc ids >= 0
                Iterator<LeafReaderContext> leaves = searcher.getIndexReader().leaves().iterator();
                LeafReaderContext leaf = null;
                SortedNumericDoubleValues data = null;
                int endDoc = 0;
                for (int i = 0; i < end; i++) {
                    if (topDocs.scoreDocs[i].doc >= endDoc) {
                        do {
                            leaf = leaves.next();
                            endDoc = leaf.docBase + leaf.reader().maxDoc();
                        } while (topDocs.scoreDocs[i].doc >= endDoc);
                        LeafFieldData fd = context.factorField.load(leaf);
                        if (false == (fd instanceof LeafNumericFieldData)) {
                            throw new IllegalArgumentException("[" + context.factorField.getFieldName() + "] is not a number");
                        }
                        // 拿到了factor_field参数对应字段的值
                        data = ((LeafNumericFieldData) fd).getDoubleValues();
                    }
                    if (false == data.advanceExact(topDocs.scoreDocs[i].doc - leaf.docBase)) {
                        throw new IllegalArgumentException("document [" + topDocs.scoreDocs[i].doc
                                + "] does not have the field [" + context.factorField.getFieldName() + "]");
                    }
                    if (data.docValueCount() > 1) {
                        throw new IllegalArgumentException("document [" + topDocs.scoreDocs[i].doc
                                + "] has more than one value for [" + context.factorField.getFieldName() + "]");
                    }
                    // 自定义的第二部分逻辑，将逻辑一之后的得分再乘以factor_field对应字段的值
                    topDocs.scoreDocs[i].score *= data.nextValue();
                }
            }
            // Sort by score descending, then docID ascending, just like lucene's QueryRescorer
            // 将最终返回的doc降序排列
            Arrays.sort(topDocs.scoreDocs, (a, b) -> {
                if (a.score > b.score) {
                    return -1;
                }
                if (a.score < b.score) {
                    return 1;
                }
                // Safe because doc ids >= 0
                return a.doc - b.doc;
            });
            return topDocs;
        }
```

代码的主要逻辑部分都用注释说明了。可以看到，这个自定义插件实现了两部分逻辑：

1. 将前 window_size 个得分乘以 factor（window_size 是父类定义的参数，可以在 rescore 时指定，实际作用就是指定重打分的文档数量）
2. 如果 factor_field 参数存在，那么将第一步重打分的文档得分再乘以 factor_field 对应字段的值

虽然逻辑有点冗长，但是代码是很清晰的。接下来是几个实际的例子：

- 写入

```
PUT test/_bulk?refresh
{"index":{"_id":1}}
{"test_field1":1, "test_field2": 3}
{"index":{"_id":2}}
{"test_field1":2, "test_field2": 2}
{"index":{"_id":3}}
{"test_field1":3, "test_field2": 1}
```

- 重打分查询

```
GET test/_search
{
  "query": {
    "match_all": {}
  },
  "rescore": {
    "example": {
      "factor": 3,
      "factor_field": "test_field2"
    },
    "window_size": 2
  }
}
```

- 结果

```
{
  "took" : 1,
  "timed_out" : false,
  "_shards" : {
    "total" : 1,
    "successful" : 1,
    "skipped" : 0,
    "failed" : 0
  },
  "hits" : {
    "total" : {
      "value" : 3,
      "relation" : "eq"
    },
    "max_score" : 9.0,
    "hits" : [
      {
        "_index" : "test",
        "_type" : "_doc",
        "_id" : "1",
        "_score" : 9.0,
        "_source" : {
          "test_field1" : 1,
          "test_field2" : 3
        }
      },
      {
        "_index" : "test",
        "_type" : "_doc",
        "_id" : "2",
        "_score" : 6.0,
        "_source" : {
          "test_field1" : 2,
          "test_field2" : 2
        }
      },
      {
        "_index" : "test",
        "_type" : "_doc",
        "_id" : "3",
        "_score" : 1.0,
        "_source" : {
          "test_field1" : 3,
          "test_field2" : 1
        }
      }
    ]
  }
}
```

可以看到查询时候指定的 rescore 名字是 example，就是在代码中指定的 NAME。前置查询是 match_all，我们的写入文档得分都是 1.0，match_all 的结果会按照文档的创建时间排序。重打分中指定了 factor 是 3，factor_field 是 test_field2，window_size 是 2。此时 rescore 只对前两个文档进行操作，先用初始得分乘以 3，再将得分乘以每个文档 test_field2 对应的值。文档 1 的结果是 1.0\*3\*3=9.0，文档 2 的结果是 1.0\*3\*2=6.0，文档 3 不参与重打分，结果仍是 1.0

### 四、总结

这个插件 demo 虽然代码量非常少，但却很好地实现了重打分的逻辑，很多代码也都可以在实际的重打分功能逻辑中复用，非常方便。
