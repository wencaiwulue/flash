---
commit: c43f42e4eba9ae16c7d7a78dfbcfcb4bfb177d0c
title: CI 生命周期测试的 cwd 与接管等待隔离
date: 2026-11-11
retrospective: true
---

# CI 生命周期测试的 cwd 与接管等待隔离

## 设计

该提交只修改测试，不调整生产逻辑。

ReviewArtifact 文件读取测试从全局 `getCwdState/setCwdState` 改为 `runWithCwdOverride(dir, callback)`，使 cwd 覆盖只存在于异步回调作用域，finally 只负责删除临时目录，避免并发测试共享和恢复全局 cwd。

cron 锁接管测试把 secondFired 等待上限从 12 秒提高到 30 秒、整体超时从 15 秒提高到 40 秒，为默认锁 probe 周期和 CI 调度延迟留出空间。它只缓解等待窗口，后续提交才进一步固定 owner 选择和 probe 间隔。

## 验收标准

1. ReviewArtifact 在 override 内读取相对路径，回调结束后 cwd 不泄漏到其他测试。
2. 临时目录仍在 finally 删除，测试失败不会依赖手工恢复全局状态。
3. 锁接管等待与整体超时具有明确上限，测试不依赖固定 sleep 代替条件等待。
4. `reviewArtifact.test.ts` 与 `cronLifecycle.test.ts` 可在同一全量套件中运行而互不污染。
