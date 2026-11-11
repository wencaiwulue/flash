---
commit: c69c271db2278642918bce5caf9641108e4f6cab
title: "Rebuild substantive commit design documentation"
date: 2026-11-11T14:04:41+08:00
status: implemented
kind: component
---

# Rebuild substantive commit design documentation

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

既有文档系统把提交标题、变更文件数量和少量一句话说明填入固定模板；大多数历史提交共用 fallback，PLAN 则共用三个没有文件和依赖关系的步骤。CI 还会先运行 writer，再检查刚刚被它重写的文件。

这种结构只能证明文档存在且可由同一套模板复现，无法回答某个提交为什么采用特定架构、数据怎样流动、实施时先改哪个模块，也无法发现缺失记录被自动生成所掩盖。需要把技术正文变成强制、可核对的一等数据，并保留人工语义审查的位置。

## 目标与非目标

### 目标

- 为全部 93 个历史提交建立独立、结构化的方案设计与实施记录，并生成对应 SPEC/PLAN。
- 让缺失记录、空泛占位、错误文件引用、无来源执行证据和复制正文在本地及 CI 中失败。
- 明确区分当提交证据、后续证据、实现状态和仍需授权环境的验证边界。
- 统一 self 与下一提交的准备模式，CI 只读校验已提交文档。

### 非目标

- 不改写历史 commit、commit message 或产品实现，也不借文档整改重新解释未发生的 live 验证。
- 不把重复度、路径存在性或 schema 通过宣称为计算机已经证明设计语义正确。
- 不处理 OAuth、Cloud、remote-control 和原生桌面环境本身的验收。

## 方案架构与数据流

记录层以每提交一个 TypeScript 模块保存 beforeState、architecture、decisions、evidence 和有序 plan.steps。加载器只接受显式记录；Git 层负责真实历史、rename 和 revision 内容，渲染层不再创作技术正文。

校验层先把提交 diff 与 changed references 对齐，再检查 reused/test/evidence 在指定 revision 是否存在，最后对作者正文做占位、敏感信息和跨记录重复检查。证据对象带 kind 与 source，使“新增测试”和“执行通过”在数据模型中就不能混为一谈。

渲染器把同一份审核记录分别投影为 SPEC 与 PLAN，同时重建 INDEX 和 JSON 状态。head 模式要求祖先 SHA 加当前 self，next 模式把当前 HEAD 也纳入 SHA 清单，从而消除额外复制 previous HEAD 文档的补丁。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `scripts/commit-docs/schema.ts` | 定义设计记录、证据、引用、变更分组和实施步骤的数据契约。 |
| 变更 | `scripts/commit-docs/git.ts` | 提供确定顺序历史、rename-aware diff 和 revision 文件读取。 |
| 变更 | `scripts/commit-docs/load.ts` | 只加载显式逐提交记录，并拒绝文件名与 SHA 不一致。 |
| 变更 | `scripts/commit-docs/validate.ts` | 执行覆盖、引用、证据、占位、重复和敏感信息检查。 |
| 变更 | `scripts/commit-docs/render.ts` | 把审核记录投影为 SPEC、PLAN 和两种索引。 |
| 变更 | `scripts/document-commits.ts` | 提供唯一写入口和 head/next 清单语义。 |
| 变更 | `scripts/check-commit-docs.ts` | 只读比较生成结果并发现孤儿 SPEC/PLAN。 |
| 变更 | `tests/commitDocs.test.ts` | 验证结构与负向质量门禁。 |
| 变更 | `.github/workflows/ci.yml` | 固定实际 head revision，并禁止 CI 检查前写文档。 |
| 变更 | `.gitignore` | 把 plainTextStorage 使用的 .credentials.json 纳入防误提交范围。 |
| 变更 | `docs/COMMIT_DOCS.md` | 规定设计正文、证据和人工审查责任。 |
| 变更 | `docs/STATUS.md` | 修正 Cloud skip、settings 加载、ReviewArtifact 与 context-collapse 的当前状态和剩余边界。 |
| 变更 | `docs/RELEASE.md` | 以 93 个实质设计记录和只读 CI 政策替换过时的 41-commit 结构检查说明。 |
| 变更 | `docs/INDEX.md` | 更新索引以包含 93 个历史提交的文档。 |
| 变更 | `docs/status/index.json` | 更新机器可读状态索引以包含 93 个历史提交。 |

### 大型快照分组核对

- 逐提交结构化设计与实施记录。：`scripts/commit-docs/records/`，94 个文件。
- 由记录渲染的历史方案设计文档。：`docs/specs/`，95 个文件。
- 由记录渲染的历史步骤实施文档。：`docs/plans/`，95 个文件。

## 关键决策与工程取舍

- 采用结构化记录而不是直接维护散落的 Markdown，是为了让文件覆盖、证据类型和 revision 成为机器可校验字段；Markdown 仍作为人类阅读的最终产物。
- 将功能、纯证据更新和元数据迁移区分为不同 kind，避免给 rename 或 finalization commit 虚构产品架构。
- 把重复检查限制在作者撰写的实质段落，排除 frontmatter、索引和机械统计，避免正常元数据格式造成无意义冲突。
- CI 不调用 writer；生成与检查分离后，工作树里缺失或过期的文档会原样暴露，而不是在检查前被修复。

### 备选方案与回溯分析

- 继续扩充单个 DETAILS 表会让长正文、证据和步骤挤在一个脚本里，也无法按提交并行审查，因此拆成独立记录。
- 根据标题和 diffstat 自动推断理由仍然会产生用户已经否定的泛化文档，故只自动提取机械事实，不自动生成设计 prose。
- 把所有提交硬套成产品组件设计会迫使纯文档提交编造数据流；采用 kind 和具体的“不适用”理由更诚实。

## 安全与协议边界

- 记录和生成物只引用公开源码、测试与已有状态文档；敏感模式检查失败时不回显疑似凭据。
- 证据模型不允许用后续 live 结果冒充当提交结果，OAuth/Cloud/desktop 边界继续按真实环境记录。
- 校验器对 Git 只执行读取操作；CI 不再获得通过 writer 修改待检查内容的隐式路径。

## 验收标准

- 93 个历史提交均有 full-SHA 对应的独立记录，且每个普通变更文件能在设计或实施记录中定位。
- 缺失记录、旧 fallback、空章节、错误路径、复制段落和证据缺源均有确定失败测试。
- next 与 head 两种模式生成结果一致地衔接，重复生成不产生 diff，CI 不再先写后查。
- 代表性 Workflow、bridge、CI、rename 和 finalization 文档能独立说明架构、取舍与文件级顺序。

## 实现状态与剩余范围

- 状态：**implemented**
- 93 个历史记录、独立语义审查、审查后重生成和本地全量验证均已完成；仅剩提交后的 head 幂等检查与 hosted CI 验证，自动门禁不替代已经执行的语义审查。
- 审计发现的 standalone settings、ReviewArtifact、context-collapse、Workflow、Snip、SkillHub/cache 和 Browser 实现缺口已写入 STATUS，本次不修改产品实现。
- 既有 OAuth、Cloud、remote-control 与原生桌面 live 边界不受本次文档工作影响。
