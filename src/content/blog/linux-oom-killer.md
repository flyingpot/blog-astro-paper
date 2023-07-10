---
author: Fan Jingbo
pubDatetime: 2020-11-28T16:00:00Z
title: 对于Linux中oom-killer的简单探究
postSlug: oom-killer
featured: true
draft: false
tags:
  - Linux
ogImage: ""
description: 最近在对Elasticsearch集群进行压力测试的时候发现，当我不停的对集群进行创建索引操作时，集群的master节点总会莫名其妙的挂掉。表现是ES进程退出，并且JVM没有生成相应的dump文件。我陷入了疑惑，后来经过别人指点我才知道原来进程是被Linux中的oom-killer杀掉了。由于之前没有了解过，所以我花了一段时间了解了一下oom-killer的机制，还顺带看了一些Linux源码。
---

最近在对 Elasticsearch 集群进行压力测试的时候发现，当我不停的对集群进行创建索引操作时，集群的 master 节点总会莫名其妙的挂掉。表现是 ES 进程退出，并且 JVM 没有生成相应的 dump 文件。我陷入了疑惑，后来经过别人指点我才知道原来进程是被 Linux 中的 oom-killer 杀掉了。由于之前没有了解过，所以我花了一段时间了解了一下 oom-killer 的机制，还顺带看了一些 Linux 源码。

### 一、虚拟内存与写时复制（Copy-On-Write）

虚拟内存（Virtual Memory）是一种计算机内存管理技术，用来作为程序与物理内存的桥梁。页（Page）是虚拟内存的最小单位，页表（Page Table）储存着虚拟内存到物理内存的映射。有了虚拟内存，程序就只需要感知抽象出来的一整块虚拟内存，而具体在读写时要使用哪一块物理内存则不需要程序关心。并且通常情况下虚拟内存对应的物理内存都是分散分布的。

基于虚拟内存，程序在申请内存时可以实现仅申请虚拟内存，并且直到写入时才申请物理内存。这里使用了写时复制的技术，直接引用 Wiki 的原文：

> The copy-on-write technique can be extended to support efficient [memory allocation](https://en.wikipedia.org/wiki/Memory_allocation "Linux kernel") by having a page of [physical memory](https://en.wikipedia.org/wiki/Physical_memory "Physical memory") filled with zeros. When the memory is allocated, all the pages returned refer to the page of zeros and are all marked copy-on-write. This way, physical memory is not allocated for the process until data is written, allowing processes to reserve more virtual memory than physical memory and use memory sparsely, at the risk of running out of virtual address space. The combined algorithm is similar to [demand paging](https://en.wikipedia.org/wiki/Demand_paging).[\[3\]](https://en.wikipedia.org/wiki/Copy-on-write#cite_note-Linux-3)

也就是说，申请内存（如 malloc）时，只申请虚拟内存，并且仅仅申请一个全是 0 的物理页，所有虚拟页都指向这一个物理页，并且虚拟页都被标记成 Copy-On-Write。仅仅在写入这段内存时才会分配实际的物理内存。

这里实际也解答了这个[链接](http://fallincode.com/blog/2020/01/malloc%E6%9C%80%E5%A4%9A%E8%83%BD%E5%88%86%E9%85%8D%E5%A4%9A%E5%B0%91%E5%86%85%E5%AD%98/)里面关于分配虚拟内存时物理内存会多占用一个页的问题。

### 二、内存分配参数 vm.overcommit_memory

为了最大化内存利用率，Linux 支持过度申请，也就是所谓的 overcommit。Linux 内核通过 overcommit_memory 这个参数决定对待申请内存的策略，包含三个值，[内核文档](https://www.kernel.org/doc/Documentation/vm/overcommit-accounting)说明如下：

    0	-	Heuristic overcommit handling. Obvious overcommits of
    		address space are refused. Used for a typical system. It
    		ensures a seriously wild allocation fails while allowing
    		overcommit to reduce swap usage.  root is allowed to
    		allocate slightly more memory in this mode. This is the
    		default.

    1	-	Always overcommit. Appropriate for some scientific
    		applications. Classic example is code using sparse arrays
    		and just relying on the virtual memory consisting almost
    		entirely of zero pages.

    2	-	Don't overcommit. The total address space commit
    		for the system is not permitted to exceed swap + a
    		configurable amount (default is 50%) of physical RAM.
    		Depending on the amount you use, in most situations
    		this means a process will not be killed while accessing
    		pages but will receive errors on memory allocation as
    		appropriate.

    		Useful for applications that want to guarantee their
    		memory allocations will be available in the future
    		without having to initialize every page.

大概意思是：当值为 0 时会使用一种启发式的处理方式，明显超出限度的内存申请会被拒绝；当值为 1 时总是允许 overcommit；当值为 2 时不允许 overcommit，但实际上还是有个计算标准来决定是否拒绝内存申请。

说实话这些说明看起来很模糊，让人理解不能，但是当我找到相对应的内核源码时，我很轻松地就搞懂了这里面的逻辑，实际上很简单，我会用注释的方式说明。

代码如下：

```c
    /*
     * Check that a process has enough memory to allocate a new virtual
     * mapping. 0 means there is enough memory for the allocation to
     * succeed and -ENOMEM implies there is not.
     *
     * We currently support three overcommit policies, which are set via the
     * vm.overcommit_memory sysctl.  See Documentation/vm/overcommit-accounting.rst
     *
     * Strict overcommit modes added 2002 Feb 26 by Alan Cox.
     * Additional code 2002 Jul 20 by Robert Love.
     *
     * cap_sys_admin is 1 if the process has admin privileges, 0 otherwise.
     *
     * Note this is a helper function intended to be used by LSMs which
     * wish to use this logic.
     */
    int __vm_enough_memory(struct mm_struct *mm, long pages, int cap_sys_admin)
    {
    	long allowed;

    	vm_acct_memory(pages); // 此处应该是申请内存逻辑

    	/*
    	 * Sometimes we want to use more memory than we have
    	 */
    	if (sysctl_overcommit_memory == OVERCOMMIT_ALWAYS) // OVERCOMMIT_ALWAYS对应上面的1
    		return 0; // 当逻辑是OVERCOMMIT_ALWAYS，总是返回0，也就是成功申请

    	if (sysctl_overcommit_memory == OVERCOMMIT_GUESS) { // OVERCOMMIT_GUESS对应上面的0
    		if (pages > totalram_pages() + total_swap_pages)
    			goto error; // 这里就是上面说的明显超出限度的内存申请，其实就是总内存加上swap内存
    		return 0;
    	}

    	allowed = vm_commit_limit(); // 这里实际上通过复杂一些的方式计算出来了一个限额，对应了NEVER的情况
    	/*
    	 * Reserve some for root
    	 */
    	if (!cap_sys_admin)
    		allowed -= sysctl_admin_reserve_kbytes >> (PAGE_SHIFT - 10);

    	/*
    	 * Don't let a single process grow so big a user can't recover
    	 */
    	if (mm) {
    		long reserve = sysctl_user_reserve_kbytes >> (PAGE_SHIFT - 10);

    		allowed -= min_t(long, mm->total_vm / 32, reserve);
    	}

    	if (percpu_counter_read_positive(&vm_committed_as) < allowed)
    		return 0;
    error:
    	vm_unacct_memory(pages); // 0和2的情况如果超出了相应的限度会到这里来，逻辑应该是释放申请的内存

    	return -ENOMEM;
    }
```

实际上能看出来是否触发 oom killer 跟这个参数根本没有关系，修改这个参数只会影响一个进程能否申请到内存的逻辑。值为 1 条件最宽松，值为 0 条件次之，值为 2 最严格，仅此而已。我之前被网上的一些信息误导了，让我以为这个参数与 oom killer 的执行逻辑有关，直到我读了一下代码才明白其中缘由。

那么是什么来决定是否触发 oom killer？这就涉及到另一个内核参数了。

### 二、Linux OOM 处理逻辑参数 vm.panic_on_oom

当实际物理内存不足时，会进入以下逻辑进行处理（oom_kill.c）：

```c
    /**
     * out_of_memory - kill the "best" process when we run out of memory
     * @oc: pointer to struct oom_control
     *
     * If we run out of memory, we have the choice between either
     * killing a random task (bad), letting the system crash (worse)
     * OR try to be smart about which process to kill. Note that we
     * don't have to be perfect here, we just have to be good.
     */
    bool out_of_memory(struct oom_control *oc)
    {
    	unsigned long freed = 0;

    	if (oom_killer_disabled)
    		return false;

    	if (!is_memcg_oom(oc)) {
    		blocking_notifier_call_chain(&oom_notify_list, 0, &freed);
    		if (freed > 0)
    			/* Got some memory back in the last second. */
    			return true;
    	}

    	/*
    	 * If current has a pending SIGKILL or is exiting, then automatically
    	 * select it.  The goal is to allow it to allocate so that it may
    	 * quickly exit and free its memory.
    	 */
    	if (task_will_free_mem(current)) {
    		mark_oom_victim(current);
    		wake_oom_reaper(current);
    		return true;
    	}

    	/*
    	 * The OOM killer does not compensate for IO-less reclaim.
    	 * pagefault_out_of_memory lost its gfp context so we have to
    	 * make sure exclude 0 mask - all other users should have at least
    	 * ___GFP_DIRECT_RECLAIM to get here. But mem_cgroup_oom() has to
    	 * invoke the OOM killer even if it is a GFP_NOFS allocation.
    	 */
    	if (oc->gfp_mask && !(oc->gfp_mask & __GFP_FS) && !is_memcg_oom(oc))
    		return true;

    	/*
    	 * Check if there were limitations on the allocation (only relevant for
    	 * NUMA and memcg) that may require different handling.
    	 */
    	oc->constraint = constrained_alloc(oc);
    	if (oc->constraint != CONSTRAINT_MEMORY_POLICY)
    		oc->nodemask = NULL;
    	check_panic_on_oom(oc);

    	if (!is_memcg_oom(oc) && sysctl_oom_kill_allocating_task &&
    	    current->mm && !oom_unkillable_task(current) &&
    	    oom_cpuset_eligible(current, oc) &&
    	    current->signal->oom_score_adj != OOM_SCORE_ADJ_MIN) {
    		get_task_struct(current);
    		oc->chosen = current;
    		oom_kill_process(oc, "Out of memory (oom_kill_allocating_task)");
    		return true;
    	}

    	select_bad_process(oc);
    	/* Found nothing?!?! */
    	if (!oc->chosen) {
    		dump_header(oc, NULL);
    		pr_warn("Out of memory and no killable processes...\n");
    		/*
    		 * If we got here due to an actual allocation at the
    		 * system level, we cannot survive this and will enter
    		 * an endless loop in the allocator. Bail out now.
    		 */
    		if (!is_sysrq_oom(oc) && !is_memcg_oom(oc))
    			panic("System is deadlocked on memory\n");
    	}
    	if (oc->chosen && oc->chosen != (void *)-1UL)
    		oom_kill_process(oc, !is_memcg_oom(oc) ? "Out of memory" :
    				 "Memory cgroup out of memory");
    	return !!oc->chosen;
    }
```

这个方法注释写的很有意思：实际上当物理内存不足要发生时，对于操作系统来说没什么选择，要么随机杀进程(bad)，要么让系统崩溃(worse)，要么通过一种更聪明的方式杀进程释放出内存。在这时没有完美的(perfect)选择，只有好的(good)选择。的确，在一般情况下，杀进程确实要比让系统崩溃更好，这也是一种无奈的办法了。

当然，操作系统不会帮用户决定这种重要的事情，可以通过修改内核参数 vm.panic_on_oom 的方式更改逻辑。

还是看一下[内核文档](https://www.kernel.org/doc/Documentation/sysctl/vm.txt)：

    panic_on_oom

    This enables or disables panic on out-of-memory feature.
    If this is set to 0, the kernel will kill some rogue process,
    called oom_killer.  Usually, oom_killer can kill rogue processes and
    system will survive.

    If this is set to 1, the kernel panics when out-of-memory happens.
    However, if a process limits using nodes by mempolicy/cpusets,
    and those nodes become memory exhaustion status, one process
    may be killed by oom-killer. No panic occurs in this case.
    Because other nodes' memory may be free. This means system total status
    may be not fatal yet.

    If this is set to 2, the kernel panics compulsorily even on the
    above-mentioned. Even oom happens under memory cgroup, the whole
    system panics.

    The default value is 0.

当值为 0 时，oom killer 是开启状态，值为 1 时，只是在一些情况下使用 oom killer，值为 2 不使用 oom killer，也就是说系统总是会触发 kernal panic。

还是看下源码：

```c
    /*
     * Determines whether the kernel must panic because of the panic_on_oom sysctl.
     */
    static void check_panic_on_oom(struct oom_control *oc) // 这个函数正常返回之后会触发oom killer
    {
    	if (likely(!sysctl_panic_on_oom))
    		return; // 0的时候直接返回，触发oom killer
    	if (sysctl_panic_on_oom != 2) {
    		/*
    		 * panic_on_oom == 1 only affects CONSTRAINT_NONE, the kernel
    		 * does not panic for cpuset, mempolicy, or memcg allocation
    		 * failures.
    		 */
    		if (oc->constraint != CONSTRAINT_NONE)
    			return; // 1的时候，在一定条件下触发oom killer
    	}
    	/* Do not panic for oom kills triggered by sysrq */
    	if (is_sysrq_oom(oc))
    		return;
    	dump_header(oc, NULL);
    	panic("Out of memory: %s panic_on_oom is enabled\n",
    		sysctl_panic_on_oom == 2 ? "compulsory" : "system-wide"); // 这里触发了kernel panic
    }
```

### 三、oom killer 如何决定杀哪个进程

继续看源码：

```c
    /*
     * Simple selection loop. We choose the process with the highest number of
     * 'points'. In case scan was aborted, oc->chosen is set to -1.
     */
    static void select_bad_process(struct oom_control *oc)
    {
    	oc->chosen_points = LONG_MIN;

    	if (is_memcg_oom(oc))
    		mem_cgroup_scan_tasks(oc->memcg, oom_evaluate_task, oc);
    	else {
    		struct task_struct *p;

    		rcu_read_lock();
    		for_each_process(p)
    			if (oom_evaluate_task(p, oc))
    				break; // 遍历进程，调用oom_evaluate_task函数，返回非0时跳出，说明选择到了要杀的进程
    		rcu_read_unlock();
    }

    static int oom_evaluate_task(struct task_struct *task, void *arg)
    {
    	struct oom_control *oc = arg;
    	long points;

    	if (oom_unkillable_task(task))
    		goto next;

    	/* p may not have freeable memory in nodemask */
    	if (!is_memcg_oom(oc) && !oom_cpuset_eligible(task, oc))
    		goto next;

    	/*
    	 * This task already has access to memory reserves and is being killed.
    	 * Don't allow any other task to have access to the reserves unless
    	 * the task has MMF_OOM_SKIP because chances that it would release
    	 * any memory is quite low.
    	 */
    	if (!is_sysrq_oom(oc) && tsk_is_oom_victim(task)) {
    		if (test_bit(MMF_OOM_SKIP, &task->signal->oom_mm->flags))
    			goto next;
    		goto abort;
    	}

    	/*
    	 * If task is allocating a lot of memory and has been marked to be
    	 * killed first if it triggers an oom, then select it.
    	 */
    	if (oom_task_origin(task)) {
    		points = LONG_MAX;
    		goto select;
    	}

    	points = oom_badness(task, oc->totalpages); // 通过oom_badness算出分数，存一个最大的
    	if (points == LONG_MIN || points < oc->chosen_points)
    		goto next;

    select: // 有更大的分数进入这个逻辑
    	if (oc->chosen)
    		put_task_struct(oc->chosen);
    	get_task_struct(task);
    	oc->chosen = task;
    	oc->chosen_points = points;
    next: // 跳过这次循环
    	return 0;
    abort: // 跳出逻辑
    	if (oc->chosen)
    		put_task_struct(oc->chosen);
    	oc->chosen = (void *)-1UL;
    	return 1;
    }

    /**
     * oom_badness - heuristic function to determine which candidate task to kill
     * @p: task struct of which task we should calculate
     * @totalpages: total present RAM allowed for page allocation
     *
     * The heuristic for determining which task to kill is made to be as simple and
     * predictable as possible.  The goal is to return the highest value for the
     * task consuming the most memory to avoid subsequent oom failures.
     */
    long oom_badness(struct task_struct *p, unsigned long totalpages)
    {
    	long points;
    	long adj;

    	if (oom_unkillable_task(p))
    		return LONG_MIN;

    	p = find_lock_task_mm(p);
    	if (!p)
    		return LONG_MIN;

    	/*
    	 * Do not even consider tasks which are explicitly marked oom
    	 * unkillable or have been already oom reaped or the are in
    	 * the middle of vfork
    	 */
    	adj = (long)p->signal->oom_score_adj;
    	if (adj == OOM_SCORE_ADJ_MIN ||
    			test_bit(MMF_OOM_SKIP, &p->mm->flags) ||
    			in_vfork(p)) {
    		task_unlock(p);
    		return LONG_MIN;
    	}

    	/*
    	 * The baseline for the badness score is the proportion of RAM that each
    	 * task's rss, pagetable and swap space use.
    	 */
    	points = get_mm_rss(p->mm) + get_mm_counter(p->mm, MM_SWAPENTS) +
    		mm_pgtables_bytes(p->mm) / PAGE_SIZE;
    	task_unlock(p);

    	/* Normalize to oom_score_adj units */
    	adj *= totalpages / 1000;
    	points += adj;

    	return points;
    }
```

可以看出来计算了 rss, pagetable and swap 这三部分的空间占用作为比例计算分数，oom_score_adj 作为权重影响分数，具体的数值可以通过/proc/<pid>/oom_score_adj 文件来修改。也就是说当这个值保持默认的情况下，oom killer 实际杀掉的进程时内存占用最多的那个进程。
这其实是很符合逻辑的，当 oom 要发生时，肯定是杀掉内存占用最多的进程是最有效率的。否则可能需要多次触发 oom killer 才能解决 oom 的问题。如果要保护一个进程不被 oom killer 杀掉，其实最好的方法只能是增加内存了，因为即使修改了 oom_score_adj 参数，当单独这个进程需要的内存就超过总内存大小时，无论怎么触发 oom killer 都是无济于事的。

### 四、总结

这次主要有两点体会：一是把 oom killer 的逻辑梳理清晰的感觉还是很爽的，在这个过程中我通过读 Linux 内核源码的方式理解了很多内容。很多时候人都会因为畏难情绪而避免读源码，遇到问题喜欢用查资料的方式解决。实际上对于这类问题，看源码的方式也很有效率，并且能避免很多误解。二是体会到了 Linux 源码写的很不错，注释丰富，结构清晰，就连我这样对内核基本一窍不通的人也能理解很多内容，以后有机会多读下 Linux 源码。
