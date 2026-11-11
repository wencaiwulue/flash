# Commit documentation policy

每个 commit 必须有独立的**方案设计文档（SPEC）**和**步骤实施文档（PLAN）**。正文必须依据该提交的 parent/current revision、实现和测试独立撰写，不是 commit message、diffstat 或裸文件列表的改写。

## 内容来源与文件命名

- `docs/specs/YYYY-MM-DD-<feature-slug>-SPEC.md`：前置问题、实际方案、控制流/数据流、接口关系、取舍与验收标准。
- `docs/plans/YYYY-MM-DD-<feature-slug>-PLAN.md`：前置条件、复用、文件级实施顺序、风险与验收顺序。
- 日期取 committer date 的自然日；slug 显式使用小写 kebab-case，同日同功能按 topo 顺序使用空、`-02`、`-03` 等后缀。
- full SHA 保留在 frontmatter 和索引中。SPEC 与 PLAN 必须使用相同日期、slug 和 commit。
- `docs/specs/self-SPEC.md`、`docs/plans/self-PLAN.md`：当前工作，包含稳定 `changeId`。

功能提交写具体控制流、接口、失败语义和可执行验收。元数据提交只写实际身份迁移、索引与 self，不硬套产品架构。大型快照不虚构开发顺序。文档不保存历史测试、命令、CI 或 live 执行结果。

## 人工正文与只读索引器

人工 SPEC/PLAN 是正文来源。`scripts/commit-docs/manual.ts` 只读取 frontmatter、检查身份与结构并生成 `docs/INDEX.md` 和 `docs/status/index.json`，**不得自动生成或改写设计正文**。

检查包括：full SHA 覆盖、日期、slug、同日序号、SPEC/PLAN 配对、self、旧通用步骤、验证证据章节、缺失文件和索引过期。结构检查不能替代语义审查。

## self 与模式

- head 模式：所有祖先使用历史文档，当前 HEAD 使用 self。
- `--next` 模式：包括当前 HEAD 在内的全部历史使用历史文档，未提交的新工作使用 self。

开始下一项工作时，先把旧 self 落实为上一 commit 的历史文档，再编写新的 self。不要在 commit 自身树中写入会改变自身 SHA 的最终记录。

## 更新流程

1. 阅读目标提交及父提交的 diff、实现和测试。
2. 独立撰写或修订对应 SPEC/PLAN，禁止通用 fallback、复制正文和虚构设计理由。
3. 准备下一提交时运行 `bun run docs:generate -- --next` 和 `bun run docs:check -- --next`；提交后运行默认 head 模式检查。
4. 抽查各类代表文档，再运行全量测试、typecheck 和 build。
5. 将人工文档与索引一起提交。CI 只运行只读 `bun run docs:check`，不得在检查前生成正文。
