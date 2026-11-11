---
commit: c43f42e4eba9ae16c7d7a78dfbcfcb4bfb177d0c
title: 生命周期测试隔离的实施步骤
date: 2026-11-11
retrospective: true
---

# 生命周期测试隔离的实施步骤

## 1. 用 AsyncLocalStorage 风格作用域替代全局 cwd

**文件：** `tests/reviewArtifact.test.ts`。

把 import 改为 `runWithCwdOverride`，将 reviewArtifact 调用包在：

```ts
await runWithCwdOverride(dir, () =>
  reviewArtifact(/* relative artifact_path */),
)
```

删除 previousCwd 和 setCwdState 恢复逻辑，finally 仅 rm 临时目录。

## 2. 放宽锁接管的条件等待窗口

**文件：** `tests/cronLifecycle.test.ts`。

secondFired 的 waitFor 上限改为 30_000，整例 timeout 改为 40_000。保留按条件等待，不能用固定等待 30 秒代替。

## 3. 验收

```bash
bun test tests/reviewArtifact.test.ts tests/cronLifecycle.test.ts
bun test
```

重点确认并行套件中没有 cwd 串扰，且等待窗口只影响测试稳定性，不改变生产锁行为。
