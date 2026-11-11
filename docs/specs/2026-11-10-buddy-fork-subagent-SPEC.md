---
commit: 982ab108e16a0919269629256555d7ef9efea707
title: Buddy companion 与 Fork Subagent 设计
date: 2026-11-10
retrospective: true
---

# Buddy companion 与 Fork Subagent 设计

## Buddy 状态与观察者

Buddy 将确定性“骨骼”和模型生成内容分开：`roll()` 根据 accountUuid/userID/anon 产生固定 rarity、species 等属性；首次观察者只让模型补 name、personality、reaction，不能改变骨骼。保存时记录 name、personality、hatchedAt。

`fireCompanionObserver()` 在 context 缺失、已有 inFlight 或 companionMuted 时直接返回。已有 companion 且最新用户文本为空时不触发。inFlight 在 finally 复位，避免并发重复孵化或反应。

模型返回文本取首个 `{` 到最后 `}` 解析 JSON，并分别限制 name 40、personality 300、reaction 500 字符。首次只有 name 与 personality 同时存在才保存；reaction 非空才调用 onReaction。解析或模型失败只记录 debug，不阻断主会话。

`/buddy` 的 status 展示 companion 和 rarity stars，mute/unmute 更新 companionMuted，非法参数返回 usage。

## Fork 命令

`/fork <directive>` 不是直接创建递归 agent，而是生成给主模型的指令：使用不带 subagent_type 的 Agent tool，把当前会话 fork 成后台 worker，并完整传递用户 directive。空参数返回 usage，非空参数禁止替换成 named agent。

`isForkSubagentEnabled` 同时约束命令入口；构建分别添加 `BUDDY` 和 `FORK_SUBAGENT`，REPL 接入观察者但保持主查询与 side-question 生命周期分离。

## 验收标准

1. 无 context、muted、并发调用和空用户文本均按规则跳过，inFlight 在成功与失败后都复位。
2. 骨骼只由稳定 seed 决定；JSON 提取、长度限制、首次保存条件和 reaction 回调节行为正确。
3. `/buddy` status/mute/unmute/非法参数行为正确，观察者异常不阻断会话。
4. `/fork` 空参数返回 usage，非空 prompt 指定无 subagent_type 的后台 Agent 并保留完整 directive。
5. `buddyFork.test.ts` 覆盖配置持久化、观察者、命令和 worktree notice；feature-profile 覆盖两个 feature。
