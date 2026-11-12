---
commit: self
changeId: include-superpowers-plan
title: "Include the date-based documentation implementation plan"
status: implemented
kind: metadata-migration
---

# Include the date-based documentation implementation plan

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

上一提交已经包含 external stub 的公开实现、总审计、十五份模块契约和验证记录，但既有的日期加功能命名迁移实施计划仍以未跟踪文件留在工作区，未进入分支或远程 PR。

用户要求把该计划纳入提交并创建 PR。只把 Markdown 裸加到分支会缺少本次变更自己的结构化记录，也无法保持仓库要求的 self/SHA 文档连续性。需要先固化上一提交，再为计划纳入建立独立设计与实施记录。

## 目标与非目标

### 目标

- 将日期加功能命名迁移实施计划纳入版本控制和 PR 范围。
- 把上一提交的 external-stub self 记录固化为完整 SHA 历史记录，保持逐提交设计文档链完整。
- 为本次计划纳入建立新的 self SPEC/PLAN，并在提交后验证 head 模式幂等。

### 非目标

- 不纳入未明确要求的 `.claude/` 本地会话文件。
- 不实施该计划描述的日期命名迁移，也不把计划文本中的目标状态当成已完成事实。
- 不重写上一提交或远程分支历史，不创建重复实现提交。

## 方案架构与数据流

内容层只新增一份已审阅的实施方案，说明命名模块、记录迁移、渲染、政策、旧路径删除和原子提交步骤。

记录层先把 external-stub-restoration 的 self 固化为 94038b1 历史记录，再以 include-superpowers-plan 建立新的 self，形成上一提交与当前工作的明确边界。

生成层继续由同一渲染器输出历史 SPEC/PLAN、self SPEC/PLAN 和两个索引；提交后以 head 模式验证清单和重复生成不产生差异。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/superpowers/plans/2026-11-11-date-based-commit-documentation.md` | 纳入日期加功能命名迁移的完整实施计划。 |
| 变更 | `scripts/commit-docs/records/94038b1.ts` | 将 external-stub-restoration 的上一 self 固化为完整 SHA，并用精确分组覆盖 318 个变更文件。 |
| 变更 | `scripts/commit-docs/records/self.ts` | 记录本次计划纳入的范围、决策和验收。 |
| 变更 | `docs/specs/94038b1-SPEC.md` | 生成上一提交的方案设计文档。 |
| 变更 | `docs/plans/94038b1-PLAN.md` | 生成上一提交的文件级实施文档。 |
| 变更 | `docs/specs/self-SPEC.md` | 生成当前计划纳入工作的方案设计。 |
| 变更 | `docs/plans/self-PLAN.md` | 生成当前计划纳入工作的实施步骤。 |
| 变更 | `docs/INDEX.md` | 加入上一提交历史文档链接并保留 self 导航。 |
| 变更 | `docs/status/index.json` | 同步上一提交与当前 self 的机器可读状态和路径。 |

## 关键决策与工程取舍

- 采用独立的文档纳入提交，而不修改上一提交，是为了保留已推送分支历史并清楚呈现用户追加的范围。
- 为上一提交使用按 src/tests/docs/scripts 分组的精确 diff 计数，避免对三百余个文件逐条建立浅引用，同时保留关键架构文件和测试引用。
- 计划文本仅作为未来迁移设计保存，不根据其中的复选框、预期输出或完成定义推断迁移已经执行。

### 备选方案与回溯分析

- 直接 git add 计划文件会更短，但会延续上一 self 的对象错位，不能说明本次为何纳入及如何保持文档连续性。
- 把计划纳入 external-stub 原提交会改变已推送历史，因此选择新的独立提交和 PR。

## 安全与协议边界

- 已逐段审阅计划内容，未发现凭据、私密令牌或需要排除的本地会话信息；`.claude/` 继续不纳入。
- Git 操作只新增提交和 PR，不执行计划中的代码修改、历史删除、真实更新或外部服务调用。

## 验收标准

- 日期命名迁移实施计划和上一提交的结构化记录均进入提交，新的 self 与历史 SPEC/PLAN 及索引一致。
- 提交前 next 检查通过，提交后 head 检查通过且重复生成没有工作树差异。
- PR 包含计划文件与记录迁移，不包含 `.claude/` 或其他未要求的本地文件。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | 实施计划包含八个任务，覆盖纯命名、schema/validate/render、self/SHA 记录、机械迁移、语义清理、政策模板、生成物迁移和原子提交验收。 | `docs/superpowers/plans/2026-11-11-date-based-commit-documentation.md` |
| not-recorded | 本次是计划文件与文档记录的纳入，没有执行该计划描述的日期迁移实现；不得把计划中的预期结果写成实际完成证据。 | `docs/superpowers/plans/2026-11-11-date-based-commit-documentation.md` |

## 实现状态与剩余范围

- 状态：**implemented**
- 日期命名迁移计划本身仍需按其实施步骤执行，本提交只负责将计划和设计记录纳入 PR。
- 提交、推送和 PR 创建后，应保留其链接和提交身份，不把 PR 创建当作计划实施验证。
