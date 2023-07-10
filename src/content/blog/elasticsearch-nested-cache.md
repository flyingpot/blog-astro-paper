---
author: Fan Jingbo
pubDatetime: 2022-08-15T17:44:00Z
title: 深入理解Elasticsearch中的缓存——Nested Cache
postSlug: elasticsearch-cache-nested-cache
draft: false
tags:
  - Java
  - Elasticsearch
ogImage: ""
description: 上一篇文章讲了关于Page Cache的内容，这次讲一下ES中的另一种Cache——Nested Cache。这种缓存是用来加速对Nested类型数据的查询的。Nested类型的基本用处这里就不分析了，网上有很多讲解文章。要理解Nested Cache,首先要从Lucene开始讲起。
---

上一篇文章讲了关于 Page Cache 的内容，这次讲一下 ES 中的另一种 Cache——Nested Cache。这种缓存是用来加速对 Nested 类型数据的查询的。Nested 类型的基本用处这里就不分析了，网上有很多讲解文章。要理解 Nested Cache,首先要从 Lucene 开始讲起。

## Lucene 中的 Join

Lucene 提供了父子关系文档的两种 join 查询：根据子文档查询父文档和根据父文档查询子文档。对应到源码中正好是两个类，分别是：ToParentBlockJoinQuery 和 ToChildBlockJoinQuery。

首先看一下 ToParentBlockJoinQuery，这个类的注释写的非常清楚：这种查询需要写入时将父子关系文档写在一个区间内，并且子文档在前，父文档在后。这里举个简单的例子，班级和学生，是有父子关系的文档，一个班级对应着多个学生。如果要使用对应的 JoinQuery,写入的时候需要如下图进行写入，将作为子文档的学生写在一起，后面紧跟着作为父文档的班级。

![](/assets/nested-lucene-block.png)

接下来看 Query 中的关键方法 Scorer::iterator（这个方法返回的是查询返回文档的 iterator,方便我们分析出 Query 是如何找到结果的），然后看到 ParentApproximation 中的两个方法 nextDoc 和 advance：

```java
@Override
public int nextDoc() throws IOException {
  return advance(doc + 1);
}

@Override
public int advance(int target) throws IOException {
  if (target >= parentBits.length()) {
    return doc = NO_MORE_DOCS;
  }
  // 这里parentBits是一个父文档的BitSet,相当于子文档的位置都是0,父文档的位置都是1。parentBits.prevSetBit可以得到前一个1的docId,再加1就是对应的第一个子文档的docId
  final int firstChildTarget = target == 0 ? 0 : parentBits.prevSetBit(target - 1) + 1;
  int childDoc = childApproximation.docID();
  if (childDoc < firstChildTarget) {
    // 根据childApproximation拿到下一个docId（不一定是firstChildTarget这个区间的）
    childDoc = childApproximation.advance(firstChildTarget);
  }
  if (childDoc >= parentBits.length() - 1) {
    return doc = NO_MORE_DOCS;
  }
  // 根据子文档childDoc跳到下一个1对应的父文档，也就是childDoc对应的父文档
  return doc = parentBits.nextSetBit(childDoc + 1);
}
```

这里通过对于 parentBits 的 prevSetBit 和 nextSetBit 操作很巧妙的完成了 advance，这样 nextDoc 就可以拿到所有查询到的子文档对应的父文档集合。

再看下 ToChildBlockJoinQuery，同样找到 nextDoc 和 advance：

```java
@Override
public int nextDoc() throws IOException {
  while (true) {
    if (childDoc + 1 == parentDoc) {
      while (true) {
        // parentDoc是父文档查询的文档
        parentDoc = parentIt.nextDoc();
        validateParentDoc();
        if (parentDoc == 0) {
          parentDoc = parentIt.nextDoc();
          validateParentDoc();
        }
        if (parentDoc == NO_MORE_DOCS) {
          childDoc = NO_MORE_DOCS;
          return childDoc;
        }
        // 拿到parentDoc对应的第一个子文档
        childDoc = 1 + parentBits.prevSetBit(parentDoc - 1);
        if (childDoc == parentDoc) {
          continue;
        }
        if (childDoc < parentDoc) {
          if (doScores) {
            parentScore = parentScorer.score();
          }
          return childDoc;
        }
      }
    } else {
      // 在区间内通过++遍历
      childDoc++;
      return childDoc;
    }
  }
}
@Override
public int advance(int childTarget) throws IOException {
  if (childTarget >= parentDoc) {
    if (childTarget == NO_MORE_DOCS) {
      return childDoc = parentDoc = NO_MORE_DOCS;
    }
    parentDoc = parentIt.advance(childTarget + 1);
    validateParentDoc();
    if (parentDoc == NO_MORE_DOCS) {
      return childDoc = NO_MORE_DOCS;
    }
    while (true) {
      // 拿到parentDoc对应的第一个子文档
      final int firstChild = parentBits.prevSetBit(parentDoc - 1) + 1;
      if (firstChild != parentDoc) {
        childTarget = Math.max(childTarget, firstChild);
        break;
      }
      parentDoc = parentIt.nextDoc();
      validateParentDoc();
      if (parentDoc == NO_MORE_DOCS) {
        return childDoc = NO_MORE_DOCS;
      }
    }
    if (doScores) {
      parentScore = parentScorer.score();
    }
  }
  childDoc = childTarget;
  return childDoc;
}
```

和上面类似，只不过这次是根据父文档的结果集来找子文档。代码很清晰，这里就不赘述了。

这两种情况下都需要 parentBits 这个 BitSet 来完成查询操作，你大概也意识到了，这个 parentBits 其实就是本篇文章要讲的 Nested Cache.

## ES 的 nested 实现

回到 ES 代码，可以看到 Nested 类型查询类 NestedQueryBuilder 中调用了 ESToParentBlockJoinQuery（其实就是上面提到的 ToParentBlockJoinQuery 的一个代理类）。Nested Cache 从源码一路找下去，最开始的初始化是在 IndexService 中的构造函数这里：

```java
this.bitsetFilterCache = new BitsetFilterCache(indexSettings, new BitsetCacheListener(this));
this.warmer = new IndexWarmer(threadPool, indexFieldData, bitsetFilterCache.createListener(threadPool));
this.indexCache = new IndexCache(indexSettings, queryCache, bitsetFilterCache);
```

这里先看一下 Nested 类型是如何写入的，代码在 DocumentParser 类中：

```java
private static ParseContext nestedContext(ParseContext context, ObjectMapper mapper) {
    context = context.createNestedContext(mapper.fullPath());
    ParseContext.Document nestedDoc = context.doc();
    ParseContext.Document parentDoc = nestedDoc.getParent();
    // We need to add the uid or id to this nested Lucene document too,
    // If we do not do this then when a document gets deleted only the root Lucene document gets deleted and
    // not the nested Lucene documents! Besides the fact that we would have zombie Lucene documents, the ordering of
    // documents inside the Lucene index (document blocks) will be incorrect, as nested documents of different root
    // documents are then aligned with other root documents. This will lead tothe nested query, sorting, aggregations
    // and inner hits to fail or yield incorrect results.
    IndexableField idField = parentDoc.getField(IdFieldMapper.NAME);
    if (idField != null) {
        // We just need to store the id as indexed field, so that IndexWriter#deleteDocuments(term) can then
        // delete it when the root document is deleted too.
        // 在每一个子文档中都加上了父文档的id,来保证删除父文档时子文档也被同时删除
        nestedDoc.add(new Field(IdFieldMapper.NAME, idField.binaryValue(), IdFieldMapper.Defaults.NESTED_FIELD_TYPE));
    } else {
        throw new IllegalStateException("The root document of a nested document should have an _id field");
    }
    // the type of the nested doc starts with __, so we can identify that its a nested one in filters
    // note, we don't prefix it with the type of the doc since it allows us to execute a nested query
    // across types (for example, with similar nested objects)
    // 为每个子文档加了一个_type字段，以双下划线开头，这是为了区分开父子字段
    nestedDoc.add(new Field(TypeFieldMapper.NAME, mapper.nestedTypePathAsString(), TypeFieldMapper.Defaults.NESTED_FIELD_TYPE));
    return context;
}
```

现在已经写入了 Nested 类型，并且 Nested Cache 也已经初始化好了，接下来就到了预热 Cache 了，代码在 BitSetFilterCache.BitSetProducerWarmer::warmReader 中：

```java
@Override
public IndexWarmer.TerminationHandle warmReader(final IndexShard indexShard, final ElasticsearchDirectoryReader reader) {
    if (indexSettings.getIndex().equals(indexShard.indexSettings().getIndex()) == false) {
        // this is from a different index
        return TerminationHandle.NO_WAIT;
    }
    if (!loadRandomAccessFiltersEagerly) {
        return TerminationHandle.NO_WAIT;
    }
    boolean hasNested = false;
    final Set<Query> warmUp = new HashSet<>();
    final MapperService mapperService = indexShard.mapperService();
    DocumentMapper docMapper = mapperService.documentMapper();
    if (docMapper != null) {
        if (docMapper.hasNestedObjects()) {
            hasNested = true;
            // 如果父文档也是nested类型，相当于父文档还有父亲，就不能像下面一样用non-nested来过滤，需要使用上面增加的_type来过滤出父文档
            for (ObjectMapper objectMapper : docMapper.objectMappers().values()) {
                if (objectMapper.nested().isNested()) {
                    ObjectMapper parentObjectMapper = objectMapper.getParentObjectMapper(mapperService);
                    if (parentObjectMapper != null && parentObjectMapper.nested().isNested()) {
                        warmUp.add(parentObjectMapper.nestedTypeFilter());
                    }
                }
            }
        }
    }
    if (hasNested) {
    // 这里增加了一个non-nested的filter来过滤出来所有的父文档
        warmUp.add(Queries.newNonNestedFilter(indexSettings.getIndexVersionCreated()));
    }
    final CountDownLatch latch = new CountDownLatch(reader.leaves().size() * warmUp.size());
    for (final LeafReaderContext ctx : reader.leaves()) {
        for (final Query filterToWarm : warmUp) {
            executor.execute(() -> {
                try {
                    final long start = System.nanoTime();
                    // 通过上面拿到的filter来查询出结果，加载到cache中
                    getAndLoadIfNotPresent(filterToWarm, ctx);
                    if (indexShard.warmerService().logger().isTraceEnabled()) {
                        indexShard.warmerService().logger().trace("warmed bitset for [{}], took [{}]",
                            filterToWarm, TimeValue.timeValueNanos(System.nanoTime() - start));
                    }
                } catch (Exception e) {
                    indexShard.warmerService().logger().warn(() -> new ParameterizedMessage("failed to load " +
                        "bitset for [{}]", filterToWarm), e);
                } finally {
                    latch.countDown();
                }
            });
        }
    }
    return () -> latch.await();
}
```

再看下很重要的 Queries.newNonNestedFilter 实现：

```java
public static Query newNonNestedFilter(Version indexVersionCreated) {
    if (indexVersionCreated.onOrAfter(Version.V_6_1_0)) {
        // PRIMARY_TERM_NAME只有父文档才有
        return new DocValuesFieldExistsQuery(SeqNoFieldMapper.PRIMARY_TERM_NAME);
    } else {
        // 老版本通过MUST_NOT双下划线的条件过滤，也能得到父文档结果
        return new BooleanQuery.Builder()
            .add(new MatchAllDocsQuery(), Occur.FILTER)
            .add(newNestedFilter(), Occur.MUST_NOT)
            .build();
    }
}

public static Query newNestedFilter() {
    return new PrefixQuery(new Term(TypeFieldMapper.NAME, new BytesRef("__")));
}
```

在做 Nested 查询的时候，就可以找到 Cache 中的对应的父文档 BitSet，拿到 Lucene 中去使用，从而得到最终的结果。

## Nested Cache 加载时机

Nested Cache 并不是像大多数 Cache 一样，第一次调用查询的时候加载，而是在做 refresh 的时候就完成了加载。上面讲初始化的那里提到了，Nested Cache 初始化之后被放到了 IndexWarmer 对象中去。最终在这里做 refresh 时完成了预热：

```java
@Override
protected ElasticsearchDirectoryReader refreshIfNeeded(ElasticsearchDirectoryReader referenceToRefresh) throws IOException {
    // we simply run a blocking refresh on the internal reference manager and then steal it's reader
    // it's a save operation since we acquire the reader which incs it's reference but then down the road
    // steal it by calling incRef on the "stolen" reader
    internalReaderManager.maybeRefreshBlocking();
    final ElasticsearchDirectoryReader newReader = internalReaderManager.acquire();
    if (isWarmedUp == false || newReader != referenceToRefresh) {
        boolean success = false;
        try {
            // 这里refreshListener就是RefreshWarmerListener，accept实际执行的就是上面提到的warmReader
            refreshListener.accept(newReader, isWarmedUp ? referenceToRefresh : null);
            isWarmedUp = true;
            success = true;
        } finally {
            if (success == false) {
                internalReaderManager.release(newReader);
            }
        }
    }
    // nothing has changed - both ref managers share the same instance so we can use reference equality
    if (referenceToRefresh == newReader) {
        internalReaderManager.release(newReader);
        return null;
    } else {
        return newReader; // steal the reference
    }
}
```

## 参考链接

1. [Solr 子查询语法及原理](https://blog.csdn.net/gaojiabao1991/article/details/115939703)
2. [ElasticSearch-Nested 嵌套类型解密](https://www.shenyanchao.cn/blog/2019/01/10/elasticsearch-nested/)
