---
commit: adaa8fffa7c7c536d782616f8f7e187de637a582
title: Env-less perpetual 的实施顺序
date: 2026-11-11
retrospective: true
---

# Env-less perpetual 的实施顺序

## 1. 实现带 TTL 的 pointer

**文件：** `src/bridge/envLessBridgePointer.ts`。

用 Zod 校验 sessionId、非负 lastSequenceNum、updatedAt。pathFor 按项目 sanitizePath 定位。write 使用 0600；read 同时 stat/read，超过四小时先 unlink 再返回 null；clear 只删除目标 pointer。

**测试：** 临时 config home 覆盖写入、正常读取、过期、损坏和清除。

## 2. 在 init 中选择创建或恢复

**文件：** `src/bridge/remoteBridgeCore.ts`。

perpetual 时先 readEnvLessBridgePointer(cwd)：有 sessionId 则跳过 createCodeSession并设置 initialSequenceNum；没有则创建并写 seq=0。随后统一 fetchRemoteCredentials 和 createV2ReplTransport。

rebuildTransport 保留当前 session，并传入当前 getLastSequenceNum。失败清理要区分新建与恢复：恢复 session 不因 transport 失败被误 archive。

## 3. 分离 temporary teardown 与 archive

teardown(final=false) 在 perpetual 中写 sessionId/lastSequenceNum 后直接收尾，不调用 archiveSession；archive(final=true) 才执行 drain、archiveSession 和 clearEnvLessBridgePointer。handle.archive 调 teardown(true)，registerCleanup 仍使用普通 teardown。

**验收 fixture：** `tests/fixtures/env-less-perpetual-check.ts` 用 mock axios/transport 验证：

- 两次 init 只有一次 create session；
- 第二次 initialSequenceNum=42；
- 第一次 teardown 没有 archive；
- 显式 archive 有 archive 请求且 pointer 为 null；
- close(401) 新增一次 /bridge，仍以 seq 42 重建。

```bash
bun test tests/envLessPerpetual.test.ts tests/perpetualBridge.test.ts
bun run typecheck
bun test
```

回滚时先恢复 initReplBridge 的 perpetual 分支，再回滚 teardown 与 pointer；不得把普通 teardown 当 archive，或在 401 重建时清零 sequence。
