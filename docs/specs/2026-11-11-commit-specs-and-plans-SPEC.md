---
commit: 587c466f7e28e4cb59b0c4522857a7110e7b152a
title: "Document every commit with specs and plans"
date: 2026-11-11T10:37:55+08:00
status: partial
kind: component
---

# Document every commit with specs and plans

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交只有全局 ARCHITECTURE/STATUS/RELEASE，没有逐提交 SPEC、PLAN、机器索引或文档 CI。当时的 41 个祖先需要集中补齐，当前文档工作又无法在自己的树内写入不会改变自身 SHA 的最终文件名。

该提交建立生成器、self 约定和 checker 来解决覆盖与 SHA 自引用，但内容层主要仍是 DETAILS 的四类短句、通用 fallback 和固定三步 PLAN；生命周期层又在生成时枚举包含当前 HEAD 的全部 commits，同时额外加入 self，导致提交前后预期清单不一致。

## 目标与非目标

### 目标

- 建立从 Git metadata 到 SPEC/PLAN、INDEX、status JSON 的统一生成与只读比较入口。
- 用 self/changeId 表达当前工作，并在基础 CI 获取完整历史、执行文档检查。
- 保留每个提交的状态、变更文件、约束、验证和剩余范围，同时识别实际生成物尚未达到真正方案设计/实施文档标准。

### 非目标

- 不把 diffstat 和文件名列表当成架构，不把通用三步当成文件级实施计划。
- 不改变产品功能或 OAuth/Cloud/desktop 的验证状态，也不借文档状态宣称 live 成功。
- 本提交没有解决当前 HEAD 与 self 同时存在的确定性问题，后续提交仍需修正。

## 方案架构与数据流

生成器用 git log --reverse 取得 full/short SHA、日期和 subject，statusFor 只把根提交标为 partial，其余一律 implemented。specFor 将 detailsFor 的四段说明与完整文件名/shortstat 拼接，planFor 在没有手工 plan 时使用相同三步；DETAILS 仅覆盖部分功能提交，fallback 为其余提交生成同义泛化文字。

self 文案由 COMMIT_DOC_ID/COMMIT_DOC_SUBJECT 环境变量或默认值决定。buildCommitDocuments 在生成时遍历 git log 默认选出的 HEAD 可达历史（并非仓库所有 refs），再额外加入 self-SPEC/PLAN、INDEX 行和 JSON self 对象。预先提交时 HEAD 是 beee034，落地为 587c466 后再次运行会多出一个 587c466 SHA pair，因此已提交索引与新期望不同。

checker 调同一个 buildCommitDocuments 并逐字比较工作树，能发现相对当前算法的缺失/过期文件，却不能评价设计理由或实施深度。CI 增加 fetch-depth: 0 与 checker step，package.json 提供 docs:generate/docs:check，COMMIT_DOCS 规定后续维护方式。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `scripts/document-commits.ts`，符号 `buildCommitDocuments` | 实现 Git 枚举、DETAILS/fallback、SPEC/PLAN、self 与索引生成，也是两处核心缺陷所在。 |
| 变更 | `scripts/check-commit-docs.ts`，符号 `buildCommitDocuments` | 以同一生成结果逐字比较文档，只提供结构一致性检查。 |
| 变更 | `.github/workflows/ci.yml`，符号 `fetch-depth: 0` | 加入全历史 checkout 和文档检查 step。 |
| 变更 | `package.json`，符号 `docs:generate` | 暴露生成与检查两个维护命令。 |
| 变更 | `docs/COMMIT_DOCS.md`，符号 `## The `self` record` | 记录 self、状态和后续生成流程的政策约定。 |
| 变更 | `docs/INDEX.md`，符号 `- Implemented: 40` | 提供人类可读链接与状态计数，反映预提交的 41 个祖先视角。 |
| 变更 | `docs/status/index.json`，符号 `"commits"` | 保存 fullSha、日期、状态和文档路径的机器索引。 |
| 变更 | `docs/STATUS.md`，符号 `\| Commit documentation \|` | 记录当时的 41 pairs 与 checker 通过声明。 |
| 变更 | `docs/RELEASE.md`，符号 `## Commit documentation policy` | 把全历史文档和 self 约定纳入发布说明。 |

### 大型快照分组核对

- 41 个祖先提交 SHA SPEC、self-SPEC 与 SPEC 模板；根/恢复 SPEC 还包含大段原始文件清单。：`docs/specs/`，43 个文件。
- 41 个祖先提交 SHA PLAN、self-PLAN 与 PLAN 模板；多数 PLAN 使用同一组三步。：`docs/plans/`，43 个文件。

## 关键决策与工程取舍

- 把生成逻辑集中于一个脚本，初期便于批量建立 86 个生成物（41 个历史 SHA pairs、self pair 和两个索引）；本提交总计 95 个变更文件，但脚本、静态模板、政策/状态文档及 CI/package 变更并非生成器输出。大型 DETAILS、模板和 Git 查询耦合也放大了后续修订成本。
- 选择 self 是为避免 SHA 自引用，这一方向合理；错误在于没有从 SHA 历史清单排除当前 HEAD，形成双份当前提交语义。
- 以精确文本比较作为首个 CI 门禁只能保证可重复生成，本记录据此把提交定为 partial，而不是继续沿用其自我评价。

### 备选方案与回溯分析

- 回溯来看，head 模式只处理祖先并由 self 表示 HEAD、next 模式再包含 HEAD，可以消除递归补丁；直接手写所有 Markdown 虽避免生成器状态问题，却无法提供路径和索引一致性校验。

## 安全与协议边界

- 生成内容来自公开 Git 和人工说明，不应包含凭据；但“其余提交一律 implemented”和通用验证句会产生无依据状态，结构完整不等于证据真实。

## 验收标准

- diff 应包含生成器、checker、两个模板、政策/索引/状态文件、CI 与 package scripts，以及 43 个 SPEC 和 43 个 PLAN 路径。
- 生成器能输出真实 SHA/title/date，以及按硬编码 statusFor 规则填入的 status 和索引，checker 能报告缺失或文本漂移。
- 质量验收必须同时报告 fallback、固定 PLAN 和 HEAD/self 双份问题，不能只引用 41 pairs 的数量。

## 实现状态与剩余范围

- 状态：**partial**
- 通用 fallback 和固定三步使多数文档不具备独立架构与实施价值，需要按真实 diff 全面重写。
- HEAD 与 self 的清单语义需要拆分为明确的祖先/下一提交模式，不能依靠预提交时 HEAD 恰好是上一节点。
- checker 只检查生成集合中的路径是否存在及正文是否逐字一致；它不校验 SPEC 内列出的变更路径或 Markdown 链接目标，不发现额外/孤儿文档，也不检查证据真实性、重复正文或敏感信息，静态模板和政策文件更不在其比较集合中，因此 CI 成功不能代表内容合格。
