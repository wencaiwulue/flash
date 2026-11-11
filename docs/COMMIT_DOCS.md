# Commit documentation policy

每个 commit 必须有独立的**方案设计文档（SPEC）**、**步骤实施文档（PLAN）**和实现状态。文档不是 commit message、diffstat 或裸文件列表的改写。

## 内容来源

- `scripts/commit-docs/records/<short-sha>.ts`：一个历史提交一份完整设计记录，full SHA 与文件名必须对应，并显式维护功能 `slug`。
- `scripts/commit-docs/records/self.ts`：当前工作的设计记录，含稳定 `changeId` 和后续固化所需的 `slug`。
- `docs/specs/YYYY-MM-DD-<feature-slug>-SPEC.md`：前置问题、目标/非目标、架构与数据流、设计决策、备选与取舍、安全协议、验收标准和剩余范围。
- `docs/plans/YYYY-MM-DD-<feature-slug>-PLAN.md`：前置条件、复用、按依赖排序的文件级步骤、兼容/迁移、风险、验收顺序和完成状态。
- `docs/status/index.json` 与 `docs/INDEX.md`：保存 full SHA、slug 和新路径的机器映射与人工导航。

正文由人工依据实际 diff 编写和审核。**没有通用 fallback，也不允许从 commit 标题自动推断设计正文。** 相同标题的提交仍须分别记录自己的变更和迁移事实。

状态为 `implemented`、`partial`、`unimplemented`，只描述该提交的实现范围。SPEC/PLAN 不保存历史测试、命令、CI 或 live 执行结果，不记录 run ID，也不以"已通过"描述历史验证；测试文件和 revision 引用仅用于说明设计及验收关系。

历史 SPEC/PLAN 是回溯性设计重建。只有代码或当时记录支持时才陈述当时理由；其余取舍明确作为回溯工程分析，不虚构原作者意图。

## `self` 与 SHA

一个 commit 无法在自身树中包含会改变该 SHA 的最终 SHA 文件，因此采用两种模式：

- 正常模式：所有祖先使用 SHA 记录，当前 HEAD 使用 `self`。
- `--next` 模式：包括当前 HEAD 在内的全部历史使用 SHA 记录，未提交的新工作使用 `self`。

开始下一项工作时，先把旧 `self` 落实为上一 commit 的 full-SHA 记录，再编写新的 `self`。不要删除 `self`，也不要用它绕过历史记录。

## 更新流程

1. 阅读目标提交及父提交的 diff、实现、测试和当时的 `docs/STATUS.md`/`docs/RELEASE.md`。
2. 编写或迁移对应的结构化记录，覆盖全部变更文件并注明复用、设计与验收关系。
3. 准备下一提交时运行 `bun run docs:generate -- --next` 和 `bun run docs:check -- --next`；提交后运行 `bun run docs:generate` 和 `bun run docs:check`。
4. 审查渲染后的 SPEC/PLAN 是否真正解释“为什么这样设计”和“具体怎样实施”，再运行全量测试、typecheck 和 build。
5. 将记录、生成文档、索引和校验修改一起提交。

## CI 质量门禁

CI 使用完整历史并只运行只读的 `bun run docs:check`，**不得先运行 generator**。否则 writer 会在检查前掩盖缺失或过期的 committed documents。

检查包括：记录/SHA 全量覆盖、slug 格式、日期与同日序号、路径冲突、必需章节、非空内容、旧模板和执行证据字段、历史执行结果表述、变更文件覆盖、路径与 symbol、重复正文、敏感信息、索引和孤儿文档。单元测试覆盖这些失败分支。

这些自动门禁只证明结构、引用和重复度约束，不能证明技术设计正确。每个 pair 仍需对照自己的 diff 做语义审查。OAuth、Cloud、remote-control 和原生桌面 live 状态仍以各自授权环境的真实结果为准。
