---
commit: 982ab108e16a0919269629256555d7ef9efea707
title: Buddy 与 Fork Subagent 的实施顺序
date: 2026-11-10
retrospective: true
---

# Buddy 与 Fork Subagent 的实施顺序

## 1. 实现可注入的 companion observer

**文件：** `src/buddy/companionObserver.ts`。

先实现 latestUserText（最多 4000 字符）和 parseCompanionObserverResponse：从首个 `{` 到最后 `}` 解析，字段按 40/300/500 截断，非法 JSON 返回 undefined。

`fireCompanionObserver()` 依次检查 context、inFlight、muted、stored+空文本。roll 的 seed 只取 accountUuid/userID/anon；首次 prompt 要求模型保留骨骼并生成 name/personality/reaction，后续 prompt 只生成 reaction。

run/cacheSafeParams/getConfig/saveConfig/now 均可注入。首次保存必须同时有 name 和 personality，reaction trim 后非空才回调；catch 只记录 debug，finally 复位 inFlight。

## 2. 实现 Buddy 命令与 REPL 接入

**文件：** `src/commands/buddy/index.ts`、`src/screens/REPL.tsx`。

status 使用 getCompanion 和 RARITY_STARS；mute/unmute 通过 saveGlobalConfig 更新 companionMuted；未知 action 返回 usage。REPL 在 BUDDY feature 下触发观察者，side-question 不进入主查询消息流。

**测试：** `tests/buddyFork.test.ts` 覆盖首次孵化、muted、并发、空反应、非法 JSON 和配置持久化。

## 3. 实现 Fork prompt 命令

**文件：** `src/commands/fork/index.ts`。

isEnabled 使用 isForkSubagentEnabled。args trim 为空返回 usage；非空返回 prompt 文本，明确要求：

```text
Use the Agent tool without a subagent_type to fork the current conversation as a background worker.
```

随后拼接完整 directive，不选择 named agent，不截断用户任务。

## 4. 接入 feature 并验收

`scripts/build.ts` 分别添加 `BUDDY` 和 `FORK_SUBAGENT`，feature fixture 同时检查 buddy/fork 命令与外部 REPL wiring。

```bash
bun test tests/buddyFork.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除 REPL 观察者，再回滚命令与 feature；不要让模型改写确定性骨骼、让 inFlight 永久停留，或通过递归 Agent 调用实现 /fork。
