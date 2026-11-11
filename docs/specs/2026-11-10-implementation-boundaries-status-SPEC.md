---
commit: dab8405a36c2cb18c22b58235c8124265666b162
title: "Document remaining implementation boundaries"
date: 2026-11-10T21:01:21+08:00
status: implemented
kind: evidence-update
---

# Document remaining implementation boundaries

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 STATUS 尚未设独立的 Remaining implementation boundaries 小节，Next implementation order 也只有三项；下一步直接从模型、Cloud/remote 验证开始，尚未集中列出 stub、缺失协议与确定性测试缺口。

需要把仍未实现的系统与仅缺验证的项目分开写清，并重排后续工作，避免已有 Verified 项被误读为所有特性均已完成。本提交只更新状态文档，不实现这些边界中的任何功能。

## 目标与非目标

### 目标

- 逐项记录 HISTORY_SNIP、REVIEW_ARTIFACT、远程 canonical skills、MonitorMcpTask、KAIROS/Buddy/Fork 与私有 computer-use 的剩余边界。
- 列出 changed-file、cron、LSP 三类确定性生命周期测试缺口，并把实现和回归排在授权环境验证之前。

### 非目标

- 不修改产品代码、feature flag、测试或构建配置。
- 不宣称新增文档中的后续任务已经执行，也不把既有 live 记录扩展到未验证环境。

## 方案架构与数据流

本提交没有运行时架构变化。STATUS 以 Remaining implementation boundaries 保存静态能力边界，以 Next implementation order 保存工作先后；两部分都只描述规划和证据状态。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/STATUS.md`，符号 `## Remaining implementation boundaries` | 唯一变更文件；新增剩余边界清单并扩写后续实施顺序。 |

## 关键决策与工程取舍

- 把 Monitor 工具已验证的 local-shell 路径与不可用的 legacy MonitorMcpTask 后端并列说明，避免将整个 Monitor 能力误记为 stub。
- 把纯 env-less perpetual 保持在有条件项目的末位，同时保留已有 env-based bridge 提供连续性的限定。

### 备选方案与回溯分析

- 回溯性比较：只在能力表增加一行会丢失各 stub 和测试缺口的具体范围；把所有项目混写为未实现又会抹掉 local-shell Monitor 与 env-based continuity 的既有证据。

## 安全与协议边界

- diff 仅包含 Markdown 状态和计划文字，没有新增凭据、权限、网络入口或代码执行路径。

## 验收标准

- 新增边界清单准确区分未实现 stub、缺失外部协议、替代实现和验证缺口。
- 实施顺序由三项扩为五项，新增 HISTORY_SNIP/ReviewArtifact、changed-file/cron/LSP 回归及 reactive-compaction 模型验证，原有 Cloud 与 env-less 条件不变。

## 实现状态与剩余范围

- 状态：**implemented**
- 清单中的 HISTORY_SNIP、ReviewArtifact、远程 canonical skills 和其他私有后端在该 revision 仍是边界，而非本次交付物。
- changed-file、cron、LSP 回归以及授权环境中的模型、Cloud、remote 验证仍按文档顺序待办。
