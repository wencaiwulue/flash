---
commit: 614bf48f749df56f79562e4c64f765875f8fd880
title: 外部功能开放与并行会话 DAG 恢复设计
date: 2026-11-10
retrospective: true
---

# 外部功能开放与并行会话 DAG 恢复设计

## 范围

该提交包含两个独立变化：开放一组 external 功能，以及修复 CLI/SDK 读取 session 时遗漏并行 assistant/tool-result 分支的问题。两者没有共享运行时状态，分别验收。

## 1. 外部功能开放

`scripts/build.ts` 的 `features` 从空数组改为：

```text
AGENT_TRIGGERS
AGENT_TRIGGERS_REMOTE
VOICE_MODE
BRIDGE_MODE
ULTRAPLAN
FILE_PERSISTENCE
KAIROS_BRIEF
```

`ultraplan` 同时从 `INTERNAL_ONLY_COMMANDS` 移到普通命令列表，命令声明改为 `availability:['claude-ai']`、`isEnabled:()=>true`。因此开放不仅是 bundle 保留代码，也包括命令注册和可用性判断；其他 internal-only 命令仍留在原列表。

## 2. 为什么单 parent 链不完整

session transcript 用 `parentUuid` 表示主链，但同一 API message id 可以对应多个 assistant content-block sibling，tool_result 又分别指向产生它的 assistant UUID。沿最后一条消息的 parentUuid 反向走，只能得到其中一支，其余 sibling 和 tool result 会成为“不可达但仍存在”的分支。

`sessionChainRecovery.ts` 把恢复逻辑做成纯函数：

```ts
recoverOrphanedParallelToolResults(messages, chain, seen)
  → { chain: recoveredChain, recoveredCount }
```

CLI `sessionStorage.ts` 和 SDK `sdkSessions.ts` 都在 reverse 主链后调用同一函数，避免两套恢复规则漂移。

## 3. 恢复算法

1. 从主链 assistant 中读取非空 `message.id`，每个 sibling group 以**最后一条在主链上的 assistant**作为插入 anchor。
2. 遍历全部 transcript messages，按 API message id 聚合 assistant siblings，按 `parentUuid` 聚合包含 tool_result 的 user 消息。
3. 对每个主链 msgId 只处理一次，筛选 `seen` 中没有的 siblings 和 group 内所有 assistant 对应的 tool results。
4. 分别按 timestamp 排序；timestamp 相同或缺失时保持 JSONL 原有顺序。
5. 将恢复项插到该 group 的 anchor 后，使 sibling 连续，且恢复 tool result 跟随对应 tool_use。
6. 没有恢复项时返回原 chain 和 0；没有主链 assistant 时直接返回。

主链之外的孤立 sibling group 不会被无故引入：只有主链出现同一 API message id 时，才恢复该 group 的缺失成员。

## 示例

```text
主链：U → A1 → U-next
全量：A1、A2（同一 msgId），R1(parent=A1)，R2(parent=A2)
```

恢复后在 A1（若它是该 group 的最后主链成员）之后插入 A2、R1、R2，再连接 U-next。`seen` 防止已存在消息重复插入，anchor 防止把分支追加到 session 末尾。

## 验收标准

1. 构建只开放列出的七个 feature；ultraplan 不再属于 internal-only，availability 和 isEnabled 与命令注册一致。
2. 单个 API message id 的多个 assistant 和各自 tool results 被恢复到同一连续区段。
3. 已存在消息不重复，恢复项顺序稳定，anchor 为该 group 最后的主链成员。
4. 无 assistant、无孤儿、缺 timestamp、相同 timestamp 和无关孤立 group 都有确定行为。
5. CLI 与 SDK 两条读取路径调用同一个纯 helper，helper 不访问 analytics 或 CLI session state。
6. `enabledFeatures.test.ts` 验证构建/命令边界，`sdkSessions.test.ts` 验证上述 DAG 拓扑与分页行为。
