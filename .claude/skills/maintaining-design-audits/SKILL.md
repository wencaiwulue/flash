---
name: maintaining-design-audits
description: Use when committing or reviewing changes that affect design specs, audit findings, coverage, subsystem ownership, upstream behavior, or the choice between incremental and full design audits in flash.
---

# Maintaining Design Audits

## Overview

以审查基线和 Finding ID 连接代码、spec、coverage、PR 与验证证据。原始发现不可删除或为降低统计而改写；整改只追加状态与证据，默认增量审计而非全量重审。

## 提交前快速判定

| 变更 | 必做联动 |
|---|---|
| 缺陷修复 | 源码与测试；主责 spec；PR 中的 Finding ID、验证和证据边界；整改台账 |
| 行为/架构变化 | 先按上游三层证据更新 spec/plan；受影响 batch 与相邻契约 |
| 新增/移动文件 | 唯一 coverage 主责；新子系统同步 manifest、coverage、INDEX 和审计矩阵 |
| 仅修文档 | spec、链接与 `bun scripts/check-design-docs.ts`；对应整改台账 |
| main 少量新增提交 | 合入后按变更文件 → coverage 主责 → 相邻契约做增量审查 |
| 与审计范围无关 | 正常代码与测试，不强行修改审计报告 |

`docs/status/design-docs-completeness-audit/` 不存在时，不为无关变更创建审计产物。

## PR 联动契约

每个整改 PR 必须写明：

```markdown
## 关联审计发现
- Finding ID: B3-auth-01
- 主责 spec: auth
- 关联 spec: settings（无则写“无”）

## 修改与验证
- 变更的契约、源码、spec 或 coverage：
- 测试场景与不变量：
- 实际命令和退出码：
- mock/offline/live 证据边界：
- 依赖与可观察验收条件：

## 审计联动
- 整改台账状态与 PR 链接：
```

一个 PR 可整改同一子系统或契约的一组发现，不为每个发现机械创建 PR。新发现使用所属 spec 的下一个两位数 ID，并保持统一 14 列登记格式。

## 整改台账与状态

在总报告追加台账，不删除原始发现、证据或历史统计：

```markdown
| Finding ID | 主责 spec | PR | 状态 | 验证证据 |
|---|---|---|---|---|
| B3-auth-01 | auth | #17 | verified | 修复测试、test/typecheck/build 退出 0 |
```

- `open`：未整改。
- `in-review`：已有 PR，仍待合并或验证。
- `verified`：修复和验证完成；不等于 spec 已获用户批准。
- `blocked`：记录环境、依赖或证据阻塞。

`draft → approved` 只有在正文整改且用户审阅后才能执行，并同步 frontmatter、manifest、coverage 与 INDEX。不得为“状态好看”降低发现计数。

## 增量还是完整审计

**默认增量：** main 少量提交、单个子系统、局部缺陷修复、新增少量文件、上游小幅变化。沿“变更文件 → coverage 主责 → 直接调用方/下游 → 对应 batch → 必要的横向矩阵”审查，并重算实际登记行和统计。context/memory 是否复审由真实调用关系决定，不按文件名猜测。

**完整审计仅在以下情况：** 核心 context/query/session/memory 模型大改；上游大版本广泛变化；coverage/模块边界大规模重组；多个 spec 明显漂移；长期增量未做跨域对账；或约定的定期全面复审。

## 验证

- 结构：`bun scripts/check-design-docs.ts`，记录真实错误、警告和 uncovered 文件。
- 变更相关测试必须运行；完成后运行 `bun run test`、`bun run typecheck`、`bun run build`。
- 检查 Finding ID 唯一、owner 属于 manifest、登记行 schema 和统计一致；确认无占位符、重复归属和失效链接。
- 测试存在、通过、mock/offline、live 分开陈述；未运行不得写通过。

## 常见借口与纠正

| 借口 | 纠正 |
|---|---|
| “CI 很急，先删掉已修发现” | 原始基线保留，只追加 PR 与 verified 证据 |
| “只改一个文件，不用查 coverage” | 新增/移动文件必须先确定唯一主责 |
| “让 spec 状态好看些” | 用户审阅是 approved 的硬门禁 |
| “增量会漏，所以每次全审” | 先沿真实调用链做增量；只有明确触发条件才全审 |
| “字符串/测试文件存在即可证明 live” | 分别记录源码、strings、mock/offline 和 live 证据 |

## Red Flags — 停止提交

- 删除或改写原发现以减少统计。
- PR 没有 Finding ID、主责 spec 或可观察验收。
- 未检查新增文件 coverage 或沿用旧警告数。
- 未经用户审阅把 spec 改为 approved。
- 用“最快路径”“状态好看”“应该没影响”代替证据。
