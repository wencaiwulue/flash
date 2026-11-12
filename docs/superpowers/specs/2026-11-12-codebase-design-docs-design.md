---
id: documentation-system
batch: 0
title: 全项目代码设计文档体系
date: 2026-11-12
status: approved
---

# 全项目代码设计文档体系

## 1. 问题与约束

项目包含约 55 万行 TypeScript/TSX，覆盖 CLI、Agent SDK、查询引擎、工具、权限、MCP、会话持久化、终端 UI、多代理、远程运行和工程验证等多个子系统。现有 `docs/ARCHITECTURE.md` 提供产品级概览，`docs/superpowers/specs/` 只覆盖少数功能，尚不能回答每个代码文件的职责归属、关键数据流、失败语义和设计取舍。

本设计解决的是**回溯性设计档案不完整**，而不是重新设计产品。目标是在不修改产品实现的前提下，让所有产品代码、测试和工程脚本都能追溯到内聚的子系统 spec，并由 spec 解释现状、为什么形成这种结构，以及有哪些有证据支持的改进方向。

### 约束

- 采用领域子系统 spec 与全量文件覆盖索引，不按顶层目录机械拆分，也不为每个文件复制模板正文。
- `src/`、`tests/`、`scripts/` 中的手写文件全部纳入；这三个根目录内的生成代码和二进制通过显式规则排除。`dist/` 与依赖目录不进入扫描根，无需重复登记排除项。
- 生成代码被排除的是逐文件正文义务，不是可追溯性义务：必须由源 schema、生成器或构建流程所属 spec 解释其来源。
- 沿用中文设计文档、现有 frontmatter 和 `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md` 命名。
- 子系统 spec 描述当前实现；改进建议只记录和分级，不在本项目中顺带修改产品代码。
- 历史动机必须有证据。无法从代码注释、既有 contract、schema、协议或已评审文档证实的内容，只能标为“设计推断”。
- 自动检查负责完整性和一致性，不能替代逐批人工语义评审。

## 2. 设计理由与备选方案

### 2.1 方案比较

| 方案 | 优点 | 不采用原因 |
|---|---|---|
| 按顶层目录组织 | 文件统计直观，初期盘点快 | 会把插件、MCP 等跨目录功能拆散，并在 `utils`、`components` 下形成新的巨型文档 |
| 按领域子系统组织，配合唯一文件主归属 | 能完整描述运行时职责、公共契约、生命周期和失败语义；覆盖与正文解耦 | 前期需要人工判断边界，并维护机器可读索引；这是本设计采用的方案 |
| 每个文件、工具或组件一份 spec | 局部查找直接，映射简单 | 会产生大量重复正文，完整主流程仍需另行说明；自动从 AST 或文件名生成的内容也无法可靠解释设计动机 |

领域方案的关键不是减少文档数量，而是让一份 spec 对应一个可独立理解和评审的责任边界。文件覆盖索引负责证明“没有遗漏”，spec 负责解释“为什么这样工作”，两者不能互相替代。

### 2.2 为什么采用唯一主归属

每个纳入范围的文件必须在所有 coverage 文件中出现恰好一次。归属按以下优先级确定：

1. 运行时职责和公共契约，而非目录位置。
2. 功能专用入口、命令、UI、hook 和测试随该功能归属。
3. 注册表与聚合器归属于定义该层组合契约的 spec，不吞并被注册实现的正文。
4. 真正服务多个不相关领域的通用模块才归共享基础能力 spec。
5. 测试按主要验证的行为归属；跨领域测试归入口、构建或集成生命周期 spec。
6. 非 TypeScript 的手写资源归其加载器或消费者所属功能。

其他 spec 可以链接这些文件作为依赖或证据，但不重复拥有。这样既避免漏项，也避免同一设计在多处漂移。

### 2.3 为什么先试点再批量撰写

`query-core` 能验证核心生命周期和跨层数据流，`plugins` 能验证命令、服务、loader、marketplace 与 UI 的跨目录归属。两个试点覆盖不同的失败模式，适合在批量投入前暴露模板和边界问题。

试点评审后才冻结完整 spec 注册表和文件归属。过早并行会造成重复归属、跨域流程断裂和模板化正文；先冻结归属则能让后续撰写按 spec ID 独立分工。

## 3. 目标与非目标

### 目标

- 建立产品级领域导航，使读者能从架构入口找到所有子系统 spec。
- 让 `src/`、`tests/`、`scripts/` 中每个手写文件恰好归属一份主 spec。
- 每份 spec 解释问题、设计理由、备选方案、职责边界、接口、数据流、失败语义、工程取舍、验收标准和改进建议。
- 让关键设计陈述能追溯到源码符号、协议约束或测试场景，并明确区分事实与推断。
- 用自动校验发现遗漏、重复、幽灵路径、非法排除、断链和元数据不一致。
- 按依赖关系分批交付，每批都是可独立评审的完整文档，而不是空壳占位文件。

### 非目标

- 不重写产品架构，不实施子系统 spec 中的重构或功能建议。
- 不把 Git commit 标题、diffstat 或文件名自动拼接成设计理由。
- 不恢复 commit SHA frontmatter、commit 附录或 commit 索引。
- 不为生成代码和构建产物建立重复的逐文件设计正文。
- 不把 mock 测试表述为真实模型、Cloud、OAuth、浏览器、桌面或 SSH live 验证。
- 不用结构校验通过代替对架构语义、证据和“设计推断”的人工审查。

## 4. 架构、模块与数据流

### 4.1 文档结构

```text
docs/
├── ARCHITECTURE.md
│   └── 产品级架构摘要与领域文档入口
├── STATUS.md
│   └── 实际执行结果和在线/离线验证边界
├── architecture/
│   ├── INDEX.md
│   │   └── 领域、子系统 spec、批次与状态导航
│   └── coverage/
│       ├── manifest.yaml
│       │   └── 覆盖范围、spec 注册表、批次和排除规则
│       └── <subsystem>.yaml
│           └── 该 spec 主拥有的文件及职责分组
└── superpowers/specs/
    └── YYYY-MM-DD-<subsystem>-design.md
        └── 现状设计、设计理由、证据和改进建议
```

职责分离如下：

- **spec**：唯一保存子系统设计正文，不复制其他领域的架构说明。
- **INDEX.md**：只负责导航，不成为另一份巨型架构文档。
- **manifest.yaml**：唯一注册 spec ID、文档路径、coverage 路径、批次、状态和排除规则。
- **coverage YAML**：显式列出文件，按共同职责分组；不为每个文件重复一段模板文字。
- **STATUS.md**：保存实际运行结果；spec 的验收标准只描述应满足的条件。

coverage 数据采用以下逻辑结构：

```yaml
schema_version: 1
spec_id: query-core
spec: ../../superpowers/specs/2026-11-12-query-core-design.md
status: draft
groups:
  - id: conversation-lifecycle
    kind: source
    section: 4
    summary: 对话状态、轮次和模型/工具循环
    files:
      - src/QueryEngine.ts
      - src/query.ts
  - id: lifecycle-tests
    kind: test
    section: 7
    summary: 查询取消、恢复和工具编排证据
    files:
      - tests/sdkQueryLifecycle.test.ts
```

该结构允许一组同职责文件共享说明，同时仍能对每个文件执行精确集合校验。`section` 使用九章的固定序号（例如 `4` 表示架构、`7` 表示证据），避免依赖标题文本；coverage 不保存易漂移的源码行号。

### 4.2 子系统 spec 内容契约

每份 spec 使用以下九章：

1. **问题与约束**：当前行为、责任范围、internal/external 条件和成功标准。
2. **设计理由与备选方案**：当前结构解决的问题、代价、备选方案及不采用原因。
3. **目标与非目标**：该子系统当前承担和明确不承担的职责。
4. **架构、模块与数据流**：入口、公共接口、状态所有权、控制流、持久化和跨 spec 依赖。
5. **失败语义与工程取舍**：错误、取消、重试、并发、兼容性、安全、资源清理和性能。
6. **现状验收标准**：可独立判断的行为条件，不记录历史执行结果。
7. **代码与测试证据**：事实对应的源码路径、符号和测试意图。
8. **文件覆盖与相关子系统**：coverage 双向链接、上游、下游和共享证据。
9. **改进建议**：按优先级列出依据、失败场景、建议方向、代价和验收方式。

文首注明这是回溯性设计说明，不冒充原始历史设计记录。大文件按生命周期或职责分节；只有存在独立入口、状态所有者、生命周期或安全边界时才继续拆分 spec，反之避免碎片化。

### 4.3 证据与设计推断

源码事实使用“仓库相对路径 + 符号”定位，必要时附行号。入口存在、静态 import、构建成功和运行时可用是不同陈述，不得相互替代。`feature()`、`USER_TYPE`、动态 import 和显式 unavailable 分支必须注明适用条件。

以下内容可直接支持设计动机：解释动机的源码注释、已评审 spec、公开 contract、schema、协议约束和明确的接口不变量。只有代码结构、命名或测试表现时，可以说明当前结构产生的效果，但历史性的“当初为什么选择”必须写成“设计推断”。

测试证据写明测试文件、场景和它覆盖的不变量。测试文件存在不等于测试已通过；实际结果只进入 `STATUS.md` 或专门验证记录。跨域测试可被多份 spec 引用，但仍只有一个主覆盖归属。

### 4.4 改进建议模型

优先级与证据置信度分开记录：

| 级别 | 含义 | 要求 |
|---|---|---|
| P0 | 已确认的安全、数据丢失、核心正确性或协议边界问题 | 必须有直接代码或测试证据及具体失败场景 |
| P1 | 高影响可靠性、生命周期、并发、性能或显著架构耦合 | 说明影响面、约束、建议方向和可衡量验收条件 |
| P2 | 局部可维护性、重复实现、测试缺口和有边界的重构 | 限定局部路径，避免扩张为全仓重写 |
| P3 | 可选体验、命名、风格和低收益优化 | 明确非紧急，不与真实缺陷混列 |

每条建议包含证据位置、触发条件或可观察问题、建议方向、潜在回归、工程代价、验收方式和 S/M/L 粗略工作量，并标注“已证实”“待运行验证”或“设计推断”。P0/P1 不应仅依赖推测。

### 4.5 分批交付与依赖

| 批次 | 交付内容 |
|---|---|
| 0 | 扩展模板与政策；建立索引和校验器；完成 query-core 与 plugins 试点；冻结完整文件归属 |
| 1 | CLI/headless、QueryEngine/query、模型流、消息与上下文、SDK、AppState |
| 2 | 工具体系、文件/搜索、Bash/PowerShell、权限、MCP、LSP |
| 3 | 会话与文件历史、记忆、配置/认证/安全存储、插件、技能 |
| 4 | REPL、输入与 hooks、Ink UI、设计系统、通用命令族 |
| 5 | Agent/tasks、coordinator/swarm、Workflow/jobs、cron、proactive |
| 6 | Bridge、daemon/server、SSH/runner、浏览器/computer-use、安装更新 |
| 7 | 共享基础能力、遥测、构建/feature profile、测试与 Live 验证、external stubs、文档工具和最终审计 |

预计形成约 30–45 份子系统 spec，准确边界由试点和全量归属盘点确定。已有 SDK 与 external-stubs 文档应复用或补齐，不建立平行体系。每批可拥有独立实施计划；全局 INDEX 和 manifest 串行更新，避免并行撰写相互覆盖。

### 4.6 覆盖计算与校验流程

以 Git 工作树清单为基准，包含未暂存但未被忽略的新文件：

```bash
git ls-files --cached --others --exclude-standard -z -- src tests scripts
```

新增 `scripts/check-design-docs.ts` 和 `tests/designDocs.test.ts`，使用现有 Bun/TypeScript 工具链，不引入另一套测试框架。校验器执行以下数据流：

```text
Git 文件全集 + manifest 排除规则 + coverage 主归属 + spec/frontmatter + INDEX
  → 集合相等与唯一性检查
  → spec/coverage/INDEX 双向引用检查
  → 必需章节、状态与本地链接检查
  → 中间批次报告 / 最终 require-approved 严格门禁
```

## 5. 失败语义与工程取舍

| 失败或边界 | 处理语义 |
|---|---|
| 文件没有任何主归属 | 校验失败，列出遗漏路径；不允许用“misc/其他”spec 消除错误 |
| 文件出现在多个 coverage 中 | 校验失败，由人工按运行时职责确定唯一主归属 |
| coverage 引用不存在的文件或 spec | 校验失败，不接受幽灵路径或失效双向链接 |
| 文件确属生成物或二进制 | 在 manifest 登记有界路径/glob、原因、来源和负责解释它的 spec |
| 排除 glob 过宽或匹配不到文件 | 校验失败，要求缩小规则或删除过期规则 |
| 跨域测试被多份 spec 使用 | 允许引用为证据，但主覆盖只能出现一次 |
| spec 尚处于 planned/draft | 中间批次允许注册，最终 `--require-approved` 必须拒绝 |
| 历史动机没有直接证据 | 标为“设计推断”，不得改写成确定事实 |
| 测试只覆盖 mock 或离线路径 | 只声称对应测试契约，不声称 live 能力已验证 |
| 自动检查通过但正文语义错误 | 由逐批人工评审拦截；校验器不输出语义正确性结论 |
| 源码路径或符号漂移 | coverage 路径检查捕获文件漂移；行号漂移由符号引用和批次复核辅助发现 |

显式文件清单比大范围 glob 更有维护成本，但能证明每个文件的归属经过判断。这个成本是覆盖可信度的必要交换。类似地，前期试点和归属冻结会推迟批量正文产出，却能降低大规模返工风险。

## 6. 现状验收标准

### 每批验收

- 本批 spec 都是完整正文，并通过独立语义评审。
- 本批文件在主索引中恰好出现一次，跨域引用不造成重复归属。
- 主要架构、失败语义和改进建议具有对应证据；历史推断均明确标记。
- 本地链接、双向引用和覆盖检查通过。
- 不修改 `src/` 产品实现；变化仅限文档、文档工具及其测试。
- 文档工具变化时运行专项测试和 typecheck。

### 最终验收

```bash
bun test tests/designDocs.test.ts
bun scripts/check-design-docs.ts --require-approved
bun run typecheck
bun run test
bun run build
git diff --check
```

同时满足：

- 实际文件全集 = 主覆盖文件全集 + 明确排除全集。
- 每个纳入文件恰好一个主归属，每个排除项都有原因和来源 spec。
- 所有 spec 均为 approved，可从 `docs/architecture/INDEX.md` 到达。
- INDEX、manifest、coverage、spec frontmatter 的 ID、批次和状态一致。
- 没有 `utils/misc/其他` 巨型兜底 spec，没有 planned、draft 或空正文链接。
- 每份 spec 都能回答现状、为什么这样设计、证据是什么以及如何改进。
- 全量测试和 build 只作为回归检查，不被写成各子系统运行时能力证明。

## 7. 代码与测试证据

本设计直接复用和扩展以下现有约束：

- `docs/COMMIT_DOCS.md`：功能级 spec/plan、设计理由、用户审阅和不按 commit 组织文档的政策。
- `docs/superpowers/specs/TEMPLATE.md`：frontmatter 和六个基础章节。
- `docs/ARCHITECTURE.md`：CLI/SDK 产品边界、查询主链、构建入口和 external feature boundary。
- `docs/STATUS.md`：实际验证状态与已知边界的记录位置。
- `docs/superpowers/specs/2026-11-12-sdk-query-sessions-design.md`：现有中文功能 spec 的接口、数据流和失败语义写法。
- `docs/external-stubs/contracts/`：external stub 和开放协议的现有契约来源。
- `package.json`、`scripts/test.ts`：Bun 测试、typecheck 和 build 入口。

后续每个子系统 spec 必须自行补充具体源码符号与测试场景，不能仅依赖本总 spec 的概览作为证据。

## 8. 文件覆盖与相关子系统

本总 spec 定义文档体系的政策、导航、coverage 和校验器设计。
[Documentation-system coverage](../../architecture/coverage/documentation-system.yaml)

`documentation-system` coverage 最终主拥有以下纳入范围的文件：

- `scripts/check-design-docs.ts`。
- `tests/designDocs.test.ts`。

`docs/architecture/INDEX.md`、`docs/architecture/coverage/`、模板和政策文件属于文档体系自身，由 manifest 的 spec 注册表和文档政策管理，**不计入仅限 `src/`、`tests/`、`scripts/` 的源码覆盖集合**，避免实际文件全集与 coverage 全集采用不同范围。

`src/`、`tests/`、`scripts/` 的其余文件由对应领域 spec 主拥有。生成代码排除项由 SDK schema/type generation 或 build/feature-profile spec 解释；external stubs 与其现有 contracts 关联；测试与 Live 验证脚本由工程验证 spec 汇总其验证边界。

本总 spec 不代替任何子系统正文，也不复制其文件清单。完整归属在批次 0 的两个试点评审后冻结。

## 9. 改进建议

| 优先级 | 建议 | 依据与触发场景 | 验收与代价 |
|---|---|---|---|
| P1 | 将语义评审设为每批明确交付物，记录评审发现的跨域流程、证据和推断问题 | 已证实：自动检查只能验证结构和引用，无法判断设计是否符合源码；S | 每批评审意见被处理后才进入下一批；代价是增加人工评审时间 |
| P1 | 在新增、移动或删除源码时同步更新 coverage，并把严格检查用于最终完整性门禁 | 设计推断：显式归属会随文件演进漂移；若不更新会出现漏项和幽灵路径；S | 覆盖集合持续相等，严格模式拒绝未批准或失效归属；代价是文件变更需同步维护元数据 |
| P2 | 对生成代码和排除规则做专项审计，避免宽泛 glob 误排除手写 `.d.ts` 或名称含 generated 的辅助模块 | 已证实：名称和扩展名不足以判断生成来源；S | 每个排除项都有有界匹配、生成器/来源和负责 spec，过期规则会报错 |
| P2 | 源码事实优先使用符号引用，行号只作辅助定位 | 已证实：行号会随编辑漂移，而符号更适合复核；S | 关键陈述可由路径和符号定位，coverage 不保存行号；代价是需要人工选择稳定符号 |
| P3 | 在完整覆盖稳定后评估导航体验，而不是预先生成逐文件正文 | 设计推断：领域入口和分组索引通常比逐文件重复摘要更有用；M | 只有真实导航问题出现时才增加视图，且生成视图不成为设计事实的第二来源 |
