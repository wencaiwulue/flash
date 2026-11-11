---
commit: 614bf48f749df56f79562e4c64f765875f8fd880
title: 外部功能开放与并行 DAG 恢复的实施顺序
date: 2026-11-10
retrospective: true
---

# 外部功能开放与并行 DAG 恢复的实施顺序

## 1. 先用拓扑样例定义恢复契约

在 `tests/sdkSessions.test.ts` 构造一个最小 JSONL：

```text
U1(uuid=u1)
A1(uuid=a1, message.id=msg-1, parentUuid=u1)
A2(uuid=a2, message.id=msg-1, parentUuid=u1)
R1(uuid=r1, parentUuid=a1, content 含 tool_result)
R2(uuid=r2, parentUuid=a2, content 含 tool_result)
U2(uuid=u2, parentUuid=r2)
```

再补三类数据：已存在 sibling、相同 timestamp 的记录、与主链 msgId 无关的孤立 assistant。要求恢复既不重复，也不吸收无关 group。

## 2. 实现纯恢复 helper

**创建：** `src/utils/sessionChainRecovery.ts`。

定义最小 `RecoverableTranscriptMessage`，再实现两个私有判断：`apiMessageId()` 只接受 assistant 的非空 `message.id`；`containsToolResult()` 只接受有 parentUuid 且 content 含 tool_result 的 user。

核心步骤：

```ts
const chainAssistants = chain.filter(message => apiMessageId(message))
const anchorByMsgId = new Map<string, T>()
for (const assistant of chainAssistants) {
  anchorByMsgId.set(apiMessageId(assistant)!, assistant) // 后者覆盖，保留最后 anchor
}
```

遍历 `messages.values()` 建 siblingsByMsgId 和 toolResultsByAssistant。随后用 processedGroups 去重，过滤 seen，分别 stable-sort，并把恢复数组写入 `inserts.set(anchor.uuid, recovered)`。最后顺序扫描原 chain，在 anchor 后拼接 inserts；`recoveredCount===0` 时原样返回。

helper 不导入 sessionStorage、sdkSessions、analytics 或 AppState。

## 3. 同时接入 CLI 与 SDK 主链构建

**修改：**

- `src/utils/sessionStorage.ts`
- `src/utils/sdkSessions.ts`

两处都在 parentUuid walk 完成后采用同一调用：

```ts
return recoverOrphanedParallelToolResults(byUuid, chain.reverse(), seen).chain
```

CLI 可继续保留自己的 analytics 和 session 状态，SDK 不需要依赖这些外部行为。不要只修 CLI resume，否则 SDK list/getMessages 仍会丢分支。

**验收：**

```bash
bun test tests/sdkSessions.test.ts
```

除恢复拓扑外，还要检查原分页、limit/offset、sidechain 过滤和缺 parent 行为不被改变。

## 4. 开放精确的 external feature 集

**修改：** `scripts/build.ts`，只加入：

```ts
features: [
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'VOICE_MODE',
  'BRIDGE_MODE',
  'ULTRAPLAN',
  'FILE_PERSISTENCE',
  'KAIROS_BRIEF',
],
```

**修改：** `src/commands.ts` 与 `src/commands/ultraplan.tsx`。

从 `INTERNAL_ONLY_COMMANDS` 删除 ultraplan，将注册放入普通 `COMMANDS`；命令改为：

```ts
availability: ['claude-ai'],
isEnabled: () => true,
load: () => Promise.resolve({ call }),
```

不要把 `USER_TYPE === 'ant'` 条件换成对所有 internal 命令都返回 true。

**验收：** `tests/enabledFeatures.test.ts` 与 `tests/fixtures/verify-enabled-features.ts` 应构建测试 fixture，并逐项检查七个 feature、ultraplan 命令和未开放功能边界：

```bash
bun test tests/enabledFeatures.test.ts
bun test tests/sdkSessions.test.ts
bun run typecheck
bun test
```

回滚时先恢复 feature 集与命令注册，再移除两个 call site，最后删除 helper；不要通过复制一份 SDK 专用恢复算法来保留修复。
