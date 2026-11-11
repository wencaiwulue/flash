---
commit: a8c8b90fd2e7b5fa14ebb2bc6beff3f5c2904346
title: LSP 与 cron 生命周期修复的实施顺序
date: 2026-11-11
retrospective: true
---

# LSP 与 cron 生命周期修复的实施顺序

## 1. 给 LSP 关闭流程增加连接状态

**文件：** `src/services/lsp/LSPClient.ts`。

新增 connectionClosed=false，在 start 时复位，在 process exit 和 connection.onClose 时置 true。stop 只在 `connection && !connectionClosed` 时发送 shutdown/exit；forceKillTimer 仍保留。

`LSPServerInstance.ts` 的两处 maxRestarts 超限都在 throw 前设置 lastError 和 state='error'。

**验收：** `tests/fake-lsp-server.ts` 支持 initialize/echo/crash/延迟 shutdown；`tests/lspLifecycle.test.ts` 覆盖正常停止、crash restart、maxRestarts=0 和 25ms 超时 force kill：

```bash
bun test tests/lspLifecycle.test.ts
```

## 2. 注入 cron 时间并修复一次性任务竞态

**文件：** `src/utils/cronScheduler.ts`。

新增 `now?:()=>number`，用 nowFn 替代 missed-task 和 check 中的 Date.now。one-shot 删除在 removeCronTasks 成功后增加：

```ts
tasks = tasks.filter(task => task.id !== t.id)
```

内存删除发生在磁盘提交点之后、watcher reload 之前，避免重复 fire。

**验收：** `tests/cronLifecycle.test.ts` 用可变 current 推进 60 秒，检查 one-shot 只一次、nextFireTime 清空、recurring 重排、maxAgeMs=0/permanent 和 owner stop 后接管：

```bash
bun test tests/cronLifecycle.test.ts
```

## 3. 固定 changed-file 附件语义

`tests/changedFiles.test.ts` 使用真实临时文件和 FileReadTool：offset=1、limit=2 时，范围内修改产生 snippet，范围外修改不产生附件；删除文件同时从 readFileState 移除。

## 4. 全量回归

```bash
bun test tests/changedFiles.test.ts tests/cronLifecycle.test.ts tests/lspLifecycle.test.ts
bun run typecheck
bun test
```

回滚时先移除 now 注入与内存过滤，再回滚 LSP connectionClosed；不得通过延长固定 sleep、忽略 error 状态或向已退出进程发送 shutdown 来掩盖竞态。
