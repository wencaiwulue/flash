---
commit: adaa8fffa7c7c536d782616f8f7e187de637a582
title: Env-less perpetual session 与 SSE 游标恢复设计
date: 2026-11-11
retrospective: true
---

# Env-less perpetual session 与 SSE 游标恢复设计

## Pointer 持久化

`envLessBridgePointer.ts` 按项目 sanitizePath 保存 sessionId、lastSequenceNum、updatedAt，文件权限 0600。pointer 的 TTL 为四小时；读取时过期、缺失或 schema 非法都返回 null，过期文件同时删除。写入失败只记录 debug，不把内存 bridge 启动改写为持久化成功。

## 创建与恢复

`initEnvLessBridgeCore()` 在 perpetual 模式下先按 cwd 读 pointer：

- 有 pointer：跳过 POST /v1/code/sessions，复用 cse_*，并把 lastSequenceNum 作为 initialSequenceNum；
- 无 pointer：创建新 session，并以 seq=0 写 pointer。

随后 /bridge 换取新的 worker JWT 和 epoch。SSE 401 重建 transport 时仍使用同一 session，并从当前 getLastSequenceNum 恢复，避免重复消费事件。

`initReplBridge()` 不再把 env-less perpetual 回退到 env-based，而是传 perpetual 与原始 cwd；ReplBridgeHandle 新增可选 archive()。

## Teardown 与 archive

普通 teardown 在 perpetual 中只保存 sessionId 和最新 sequence，不调用 archive，允许下一进程恢复。显式 archive(final=true) 才执行 drain、结果写入和 archiveSession，并清除 pointer。

非 perpetual 保持原 teardown/archive 生命周期。新建 session 在凭据或 transport 初始化失败时仍可清理，恢复 session 不因一次重连失败被误归档。

## 验收标准

1. pointer 0600、schema、TTL、损坏读取和清理行为正确。
2. 同 cwd 两次 init 只创建一次 session，第二次复用 cse_* 和 sequence；普通 teardown 不发 archive。
3. SSE 401 触发新的 /bridge 凭据，并以最新 sequence 重建，不重放已消费游标。
4. 显式 archive 调用 archiveSession 并清 pointer，非 perpetual 行为不变。
5. `envLessPerpetual.test.ts` 与独立 fixture 覆盖同 ID 恢复、seq 42、401 重建和 archive 清理。
