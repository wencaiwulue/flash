---
commit: self
changeId: include-superpowers-plan
title: "Include the date-based documentation implementation plan"
status: implemented
kind: metadata-migration
---

# 实施计划：Include the date-based documentation implementation plan

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

用户要求把该计划纳入提交并创建 PR。只把 Markdown 裸加到分支会缺少本次变更自己的结构化记录，也无法保持仓库要求的 self/SHA 文档连续性。需要先固化上一提交，再为计划纳入建立独立设计与实施记录。

- 上一提交 94038b1 已推送到功能分支，当前只有计划目录和本地会话目录未跟踪。
- 计划全文已审阅，用户明确要求包含 docs/superpowers/plans 并创建 PR。

## 复用与兼容处理

### 复用现有实现

- 复用上一提交的 external-stub 设计正文、结构化渲染器和 head/next 文档门禁。
- 复用已存在的日期命名迁移实施计划，不重写其技术内容或执行其任务。

### 兼容、迁移与生命周期

- 不修改上一提交或远程分支历史；新提交只追加计划及其设计记录。
- self 机制继续避免在当前提交中预写自身 SHA，后续工作再将本 self 固化。

## 文件级实施步骤

### 1. 固化上一提交记录

将 external-stub self 复制为 94038b1 的完整 SHA 记录，并按真实 diff 统计添加 src、tests、docs、scripts 分组。

涉及位置：`scripts/commit-docs/records/94038b1.ts`

### 2. 建立计划纳入记录并生成文档

以新的 self 说明纳入目标和非实施边界，加入计划文件后运行 next 生成与只读检查。

涉及位置：`scripts/commit-docs/records/self.ts`、`docs/superpowers/plans/2026-11-11-date-based-commit-documentation.md`、`docs/specs`、`docs/plans`、`docs/INDEX.md`、`docs/status/index.json`

### 3. 提交并创建 PR

仅暂存计划及对应记录，提交后运行 head 检查、推送当前功能分支并创建 PR。

涉及位置：`scripts/commit-docs/records`、`docs/superpowers/plans`、`docs/specs`、`docs/plans`、`docs/INDEX.md`、`docs/status/index.json`

## 风险与处理

- 把计划中的完成定义误读为当前实现状态会造成误报，因此在记录中明确这是未执行的未来迁移。
- 大范围历史记录分组计数错误会被校验器发现，必须用上一提交的真实 diff 统计而不是估计值。

## 验证顺序

1. 运行 docs:generate -- --next 和 docs:check -- --next，检查上一提交的分组覆盖及新 self 的结构。
2. 提交后运行普通 docs:generate 和 docs:check，再确认工作树只剩未要求的本地目录。
3. 核对推送提交和 PR 的文件范围及链接。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 已固化上一提交设计记录，并为计划纳入建立独立 self 记录。
- 已审阅完整实施计划，明确不执行其迁移任务或纳入本地会话文件。

### 未完成或后续工作

- 计划文件及记录仍需提交、推送和创建 PR；日期命名迁移实施本身不在本次范围。
