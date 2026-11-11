---
commit: 1bc02bfb5271653be2dd2c2fcc498246cf111dc5
title: "Complete previous commit documentation"
date: 2026-11-11T11:08:23+08:00
status: implemented
kind: metadata-migration
---

# Complete previous commit documentation

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

直接父提交是 3fbabc2d43b99236cae4c232c6730bb6bc0a19ef，但实际待补对象是再前一提交 d472e5c963d799ffa51192e7358ecaba45de8c7a。父树已登记 2f55f19，INDEX Implemented 为 59，JSON 含 self 共 61 项，d472e5c 的 SPEC/PLAN 尚不存在。

提交标题中的 previous 不能解释为直接父 3fbabc2；本 diff 实际为 d472e5c 建文档。若按直接父填写 frontmatter，会同时错配身份和 d472e5c 所记录的 501672c 文档范围。

## 目标与非目标

### 目标

- 为 d472e5c 新建 SPEC/PLAN，准确保留 Complete previous commit documentation、2026-11-11T11:06:14+08:00 和 implemented。
- 登记 d472e5c 为 501672c 建立文档对的四路径、78 行新增和 1 行删除范围，并同步两个索引。

### 非目标

- 不为直接父 3fbabc2 或当前 1bc02bf 创建文档，也不改动 scripts/document-commits.ts。
- 不执行或声称执行生成 PLAN 所列 test、typecheck、build 与 CI 检查。

## 方案架构与数据流

d472e5c 的两个 Markdown 文件负责历史说明，INDEX 和 status JSON 负责发现；本提交没有运行时代码或生成器变更。

新历史项排在 2f55f19 后、self 前；self 的 changeId、implemented 状态和 self-SPEC/self-PLAN 路径均只顺移，不被改写为当前 SHA。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/INDEX.md` | Implemented 59→60，新增 d472e5c 行。 |
| 变更 | `docs/plans/d472e5c-PLAN.md` | d472e5c 的新建实施计划。 |
| 变更 | `docs/specs/d472e5c-SPEC.md` | 记录 d472e5c 身份和 501672c 范围。 |
| 变更 | `docs/status/index.json` | JSON 61→62 项，self 前插入 d472e5c。 |

## 关键决策与工程取舍

- SPEC 的 Actual scope 指向 501672c-SPEC、501672c-PLAN 与两个索引，而不是直接父 3fbabc2 的 2f55f19 文档组。
- INDEX Implemented 59→60，Partial 1、Unimplemented 0 不动；JSON 61→62 项，含 self 的 implemented 60→61。
- d472e5c 成为 JSON 第 61 项，self 成为第 62 项；当前提交自身没有新增 SHA 条目。

### 备选方案与回溯分析

- 若选择 3fbabc2 会把下一提交 1329f79 的对象提前并写错范围；只添加 d472e5c 文件而不加双索引，则 Implemented 60 与可发现入口无法同时成立。

## 安全与协议边界

- 四个路径均为文档元数据，没有生成器执行逻辑、依赖、凭据或权限边界变化。

## 验收标准

- 两个 frontmatter 均绑定 d472e5c 完整 SHA 和原提交时间，Actual scope 与 501672c 文档组一致。
- INDEX 行和 JSON 对象使用同一对 d472e5c 路径，位于 2f55f19 后且 self 仍居末位。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | 新 SPEC 固定 d472e5c 身份，并列出 501672c 文档对及 78 行新增、1 行删除。 | `docs/specs/d472e5c-SPEC.md`，符号 `commit: d472e5c963d799ffa51192e7358ecaba45de8c7a`，revision `commit` |
| diff-observed | 新 PLAN 含实现步骤、风险、验证序列和 implemented 完成状态。 | `docs/plans/d472e5c-PLAN.md`，符号 `## Completion status and remaining work`，revision `commit` |
| diff-observed | INDEX 汇总由 59 增至 60，并在 self 前加入 d472e5c。 | `docs/INDEX.md`，符号 `- Implemented: 60`，revision `commit` |
| diff-observed | 机器索引在 2f55f19 与 self 之间插入完整 d472e5c 对象。 | `docs/status/index.json`，符号 `"fullSha": "d472e5c963d799ffa51192e7358ecaba45de8c7a`，revision `commit` |
| not-recorded | diff 未附生成、测试、构建或 CI 输出；PLAN 的验证文字只是待办模板内容。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- 直接父 3fbabc2 和当前 1bc02bf 在此快照仍未建档；本提交仅闭合 d472e5c。
