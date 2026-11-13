---
id: documentation-system
batch: 0
title: 文档系统注册、覆盖与校验设计
date: 2026-11-12
status: draft
---

# 文档系统注册、覆盖与校验设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。描述对象是已经存在的 `scripts/check-design-docs.ts`、registry、coverage 和测试，不再用“要建立文档体系”的目标陈述代替具体设计。

## 1. 问题与约束

### 1.1 要解决的问题

全项目设计文档需要同时满足两个容易冲突的要求：

1. **设计正文按内聚职责组织。** 例如插件的命令、loader、UI 和 marketplace 应共享一份领域设计，而不是按目录拆成互不相干的说明。
2. **文件覆盖可以机械证明。** 新增、移动或删除源码后，必须能发现哪个文件没有主 spec、被重复归属，或仍被失效 coverage 引用。

只在 Markdown 中写“本 spec 覆盖某目录”无法证明第二点；只生成逐文件摘要又不能表达第一点。当前实现因此把**正文**与**覆盖元数据**分开，并用一个只读校验器连接二者。

### 1.2 当前实现的精确范围

- 文件全集仅来自 `src/`、`tests/`、`scripts/` 三个根目录。
- Git 命令同时读取已跟踪文件和未忽略的新文件，避免新 checker/test 因尚未暂存而漏检。
- `dist/`、`node_modules/` 不进入扫描根，不需要排除记录。
- 扫描根内的生成代码和二进制必须显式排除；排除的是逐文件主归属义务，不是解释其来源的义务。
- `src/entrypoints/sdk/settingsTypes.generated.ts` 是手写兼容 re-export，必须作为普通源码等待主归属，不能因文件名被排除。
- spec 正文负责解释设计；coverage 负责主归属；manifest 负责注册和排除；INDEX 只负责导航。

### 1.3 工程约束

- 使用现有 Bun、TypeScript、Zod 和 `yaml`，不引入第二套运行时或测试框架。
- 校验器只读，不自动修复文件，不修改 registry，不访问网络验证外部 URL。
- 中间阶段允许覆盖不完整，但不能掩盖结构错误；最终阶段必须能用一个严格门禁拒绝所有未完成状态。
- planned 不允许创建 spec/coverage 空壳。draft 和 approved 必须有真实正文及 coverage。
- 自动检查只证明结构、路径和部分元数据，不能证明设计语义正确。

## 2. 设计理由与备选方案

### 2.1 决策一：正文、coverage、manifest 和 INDEX 分离

| 选择 | 直接理由 | 备选方案及不采用原因 | 代价 |
|---|---|---|---|
| spec 保存设计正文，coverage 保存文件主归属 | 一组同职责文件可以共享正文，文件集合又能独立做集合运算 | 在 spec 中用 Markdown 列表兼任 coverage：仍可做文本解析，但会把路径维护混入架构叙述，且容易在改写正文时破坏机器契约 | 同一 spec 有两类文件需要同步，因此校验器强制双向链接和状态一致 |
| manifest 集中注册 spec 和排除 | 校验器有唯一入口，不必递归猜测哪些 YAML 是 coverage | 扫描全部 YAML 并猜测用途：无法区分 planned、测试 fixture 和普通配置 | manifest 更新成为每次新增 spec 的必要步骤 |
| INDEX 只做导航 | 避免产品概览、spec 正文和索引三处复制同一架构 | 在 INDEX 汇总所有子系统正文：最终会再次形成巨型文档 | 单独阅读 INDEX 不能理解子系统设计，必须进入 spec |

这里的关键不是“文件更多就更清晰”，而是每种数据只设一个权威来源。coverage 不解释架构，INDEX 不复制正文，manifest 不保存文件全集。

### 2.2 决策二：唯一主归属，引用不计入覆盖

`covered` 是 `Map<file, specId>`。第二次遇到同一路径时产生 `DUPLICATE_FILE`，而不是覆盖旧值；这样错误消息仍能报告前后两个 spec。

唯一主归属解决的是“谁负责解释这个文件”，不是“谁可以使用这个文件”。例如 `query-core` 可以引用 SDK query 入口解释调用链，但该入口仍由 SDK spec 主拥有。若允许多个主归属，文件移动后的更新责任和设计正文都会漂移；若禁止跨域引用，又会损失真实调用链。

### 2.3 决策三：排除必须命中实际文件并关联 source_spec

每个排除包含 `glob`、`reason`、`source_spec`。实现使用 `Bun.Glob.scan()` 找到磁盘文件，再与 Git 文件全集取交集：

- 没有命中实际全集：`STALE_EXCLUSION`。
- 同时出现在 coverage：`EXCLUSION_COVERED`。
- 命中多个排除：`DUPLICATE_EXCLUSION`。
- `source_spec` 未注册：`UNKNOWN_SOURCE_SPEC`。

这比按扩展名或文件名统一排除更冗长，但能防止把手写 `.d.ts`、`controlTypes.ts` 或 `settingsTypes.generated.ts` 误判为同一类。`source_spec` 可以是 planned，因此排除可以先登记，解释正文随后交付；严格模式仍会拒绝 planned 状态。

### 2.4 决策四：默认报告不完整，严格模式提升为错误

`PLANNED_SPEC`、`DRAFT_SPEC`、`UNCOVERED_FILE` 经过统一的 `incomplete()` 通道：默认进入 `warnings`，`requireApproved=true` 时进入 `errors`。

| 模式 | 用途 | 为什么不是始终严格 |
|---|---|---|
| 默认 | 分批撰写期间持续检查重复、幽灵路径、断链和元数据 | 如果几千个未覆盖文件直接让命令失败，真正的结构错误会淹没在“尚未完成”中 |
| `--require-approved` | 全量交付后的最终门禁 | 此时 planned、draft 和未覆盖都必须阻止通过 |

备选方案是提供“忽略未覆盖”开关。当前没有采用，因为默认警告已经能区分阶段，额外开关会让调用方容易意外跳过完整性要求。

### 2.5 决策五：Zod 负责契约错误，Diagnostic 负责仓库一致性错误

YAML 形状不合法时，`loadYaml()` 抛出包含字段路径的错误；文件重复、断链、状态不一致等可继续收集的问题进入 `CheckResult`。

- 契约错误意味着输入无法安全解释，继续推断 ownership 可能产生误导性二次错误。
- 仓库一致性错误彼此独立，应尽量一次报告多个，减少修复—运行循环。
- CLI 将未捕获的读取、YAML、Git 或运行时异常映射为退出码 2，与“校验完成但有错误”的退出码 1 区分。

### 2.6 决策六：planned 不允许存在正文产物

planned 只表达“已在 manifest 预留责任边界”。如果 planned 文件存在，产生 `PLANNED_ARTIFACT`，而不是自动视为 draft。

这样设计是为了防止批量创建空 spec 后让导航看起来“已有文档”。状态迁移必须显式发生：创建完整正文时改为 draft，用户审阅后改为 approved，并在 manifest、coverage、frontmatter 和 INDEX 同步。

## 3. 目标与非目标

### 3.1 当前承担的目标

- 定义一套可解析的 spec 注册、覆盖分组和排除契约。
- 计算实际文件、covered 文件和 excluded 文件之间的集合关系。
- 保证每个主覆盖文件恰好属于一个非 planned spec。
- 检查 spec frontmatter、九章正文、占位符、coverage 回链和 INDEX 导航。
- 检查本地 Markdown 文件链接；原始 `%` 文件名在 URI 解码失败时按原路径处理。
- 提供适合中间阶段的警告报告和最终严格门禁。
- 用临时目录 fixture 和真实仓库测试固定上述行为。

### 3.2 明确不承担的目标

- 不分析 import graph 或 AST 来自动判断设计归属。
- 不验证 spec 中的架构叙述是否真实，不验证源码符号是否存在。
- 不验证外部 URL、Markdown 锚点或 CommonMark 的全部语法。
- 不自动生成设计正文，不把“有 coverage”视为“设计已完整”。
- 不把 mock 测试升级为模型、Cloud、OAuth、桌面、浏览器或 SSH live 证据。
- 不自动修复错误，不修改产品源码。

## 4. 架构、模块与数据流

### 4.1 公共接口与常量

实现集中在 `scripts/check-design-docs.ts`，对外导出以下契约：

```typescript
const ROOTS = ['src', 'tests', 'scripts'] as const
const MANIFEST_PATH = 'docs/architecture/coverage/manifest.yaml'
const INDEX_PATH = 'docs/architecture/INDEX.md'

interface Diagnostic {
  code: string
  message: string
}

interface CheckResult {
  errors: Diagnostic[]
  warnings: Diagnostic[]
}

loadManifest(cwd: string): Promise<Manifest>
loadCoverage(cwd: string, path: string): Promise<Coverage>
listRepositoryFiles(cwd: string): Promise<string[]>

checkOwnership(options: {
  cwd: string
  manifest: Manifest
  files: string[]
  requireApproved?: boolean
}): Promise<CheckResult>

checkDesignDocs(options: {
  cwd: string
  files?: string[]
  requireApproved?: boolean
}): Promise<CheckResult>
```

`files` 是可注入的测试边界：fixture 显式传数组，生产调用省略它并由 `git ls-files` 构造。这样集合测试不需要初始化 Git；CLI 测试则故意使用临时 Git 仓库覆盖真实发现路径。

### 4.2 Manifest 数据契约

```typescript
type Status = 'planned' | 'draft' | 'approved'

interface SpecEntry {
  id: string                 // ^[a-z0-9-]+$
  spec: string               // 仓库相对、非绝对、无反斜杠、无 .. 段
  coverage: string           // 同上
  batch: number              // 非负整数
  status: Status
}

interface Exclusion {
  glob: string               // 非空 Bun.Glob 表达式
  reason: string             // 非空说明
  source_spec: string        // 必须等于某个 SpecEntry.id
}

interface Manifest {
  schema_version: 1
  roots: ['src', 'tests', 'scripts']
  specs: SpecEntry[]
  exclusions: Exclusion[]
}
```

`roots` 使用固定 tuple 而不是任意字符串数组，防止配置看似成功却扫描错误目录。`schema_version` 当前只接受字面量 `1`，未来结构变化必须显式升级而不是被旧校验器静默误读。

### 4.3 Coverage 数据契约

```typescript
interface CoverageGroup {
  id: string                         // ^[a-z0-9-]+$
  kind: 'source' | 'test' | 'script'
  section: number                    // 1..9 的整数
  summary: string                    // 非空职责说明
  files: string[]                    // 至少一个规范化仓库相对路径
}

interface Coverage {
  schema_version: 1
  spec_id: string
  spec: string                       // 相对 coverage 文件所在目录的 spec 回链
  status: Status
  groups: CoverageGroup[]
}
```

`kind` 与根目录有确定关系：`source → src/`、`test → tests/`、`script → scripts/`。不匹配产生 `KIND_MISMATCH`。`section` 是九章中的固定序号，不绑定标题文本；例如架构文件组使用 `4`，测试证据组使用 `7`。

coverage 的 `spec` 允许 `..`，因为它必须从 `docs/architecture/coverage/` 回到 `docs/superpowers/specs/`；manifest 和 `files` 则禁止 `..`，防止逃逸仓库范围。

当前 schema 不强制同一个 coverage 内的 `group.id` 唯一；唯一性约束仅覆盖文件主归属和 spec ID。这个限制及其改进方向见第 9 节。

### 4.4 实际注册示例

当前 `documentation-system` 的 coverage 主拥有 checker 和四个测试文件。它不包含 `docs/` 自身，因为文档元数据不属于 `src/tests/scripts` 的文件全集。

```yaml
schema_version: 1
spec_id: documentation-system
spec: ../../superpowers/specs/2026-11-12-codebase-design-docs-design.md
status: draft
groups:
  - id: documentation-checker
    kind: script
    section: 4
    summary: Registry, ownership, exclusion, spec, link, Git discovery, and CLI validation.
    files:
      - scripts/check-design-docs.ts
```

生成代码排除当前只有三类登记：两个 SDK 类型生成目标，以及 `src/types/generated/**` 下的 protobuf 输出。`settingsTypes.generated.ts` 没有排除记录，这是有意的测试边界。

### 4.5 总控执行顺序

`checkDesignDocs()` 的实际顺序如下：

```text
loadManifest(cwd)
  ↓
files 参数存在？
  ├─ 是：使用注入的文件全集
  └─ 否：git ls-files --cached --others --exclude-standard -z -- src tests scripts
  ↓
checkOwnership()
  ├─ 注册表、状态和 coverage 检查
  ├─ covered / excluded 集合检查
  └─ 未覆盖文件报告
  ↓
读取 INDEX；缺失时记录 MISSING_INDEX，但以空字符串继续
  ↓
逐个检查非 planned spec
  ├─ frontmatter
  ├─ 九章与非空正文
  ├─ 占位符
  ├─ spec → coverage 回链
  ├─ INDEX → spec 链接
  └─ 本地 Markdown 链接
  ↓
返回 { errors, warnings }
```

INDEX 缺失不提前返回，是刻意保留的聚合诊断行为：调用方同时还能看到 spec 缺章、元数据和回链问题，而不是每修一个错误才发现下一个。

### 4.6 Ownership 算法

`checkOwnership()` 维护三个核心集合：

- `actual: Set<string>`：本次 Git 或注入输入的规范化路径。
- `covered: Map<string, string>`：文件到主 spec ID。
- `excluded: Map<string, string>`：文件到命中它的排除 glob。

执行步骤：

1. 检查重复 spec ID，保留集合用于排除引用验证。
2. 检查输入是否越出三个根目录。
3. planned 只报告状态并检查产物；draft 报告状态；其他状态加载 coverage。
4. 比较 coverage 的 `spec_id/status` 与 manifest，并将 coverage 回链解析成仓库路径比较。
5. 逐文件检查组类型、实际存在性和唯一主归属。
6. 逐个 glob 扫描排除，检查来源、空匹配、覆盖冲突和重复排除。
7. 对 `actual - covered - excluded` 的排序结果逐项产生 `UNCOVERED_FILE`。

选择显式 Map/Set 而不是仅比较数量，是因为数量相等仍可能掩盖“一遗漏一重复”；路径级诊断才能指出具体冲突双方。

### 4.7 Spec 与链接算法

`checkSpecDocument()` 对非 planned spec 执行：

1. 读取开头 `--- ... ---` frontmatter，逐字段比较 `id/batch/status`，错误消息包含期望值和实际值。
2. 查找九个精确二级标题；标题存在但到下一个二级标题前没有正文时产生 `EMPTY_SECTION`。
3. 只拒绝 `checkSpecDocument()` 占位正则中枚举的两个大写英文关键词，并要求词边界匹配；这不是通用占位符检测，具体枚举以该实现为准。
4. 根据 spec 与 coverage 的实际相对路径计算必须出现的 Markdown 回链。
5. 根据 INDEX 与 spec 的实际相对路径检查导航链接。
6. 扫描 Markdown 行内链接，跳过 HTTP(S)、mailto 和纯锚点；本地路径先 URI decode，失败则使用原始路径，再检查文件存在性。

这里只实现项目需要的链接子集。正则解析不是完整 Markdown parser，这是第 9 节列出的明确边界，而不是隐含的“支持所有 Markdown”。

### 4.8 CLI 输入、输出与退出码

```bash
bun scripts/check-design-docs.ts [--require-approved]
```

| 情况 | 退出码 | 输出语义 |
|---|---:|---|
| 默认模式，无结构错误；允许有警告 | 0 | 警告写 stderr，汇总写 stdout |
| 校验完成且 `errors` 非空 | 1 | 错误/警告分别输出，汇总包含准确总数 |
| 未知参数 | 2 | 输出用法和未知参数 |
| Git、读取、YAML 或未捕获运行时异常 | 2 | 输出异常消息，不伪装成普通 Diagnostic |

每类诊断最多逐条打印 20 条，剩余只打印数量；总数不被截断。这样中间阶段几千个未覆盖警告不会淹没前 20 个结构问题。

### 4.9 诊断目录

| 错误码 | 触发条件 | 默认级别 |
|---|---|---|
| `DUPLICATE_SPEC` | manifest 中重复 spec ID | error |
| `OUT_OF_SCOPE` | 输入文件不在 src/tests/scripts 下 | error |
| `PLANNED_SPEC` | spec 为 planned | warning；strict 为 error |
| `PLANNED_ARTIFACT` | planned 的 spec 或 coverage 文件已存在 | error |
| `DRAFT_SPEC` | spec 为 draft | warning；strict 为 error |
| `MISSING_COVERAGE` | draft/approved 没有 coverage | error |
| `COVERAGE_METADATA` | coverage 的 ID/status 与 manifest 不同 | error |
| `COVERAGE_BACKLINK` | coverage 的 spec 回链解析后不等于注册路径 | error |
| `KIND_MISMATCH` | 文件根目录与 group.kind 不一致 | error |
| `GHOST_COVERAGE` | coverage 文件不在实际 Git 全集 | error |
| `DUPLICATE_FILE` | 同一路径有多个主归属 | error |
| `UNKNOWN_SOURCE_SPEC` | 排除引用未注册的 source_spec | error |
| `STALE_EXCLUSION` | 排除没有命中实际文件 | error |
| `EXCLUSION_COVERED` | 文件同时被覆盖和排除 | error |
| `DUPLICATE_EXCLUSION` | 文件命中多个排除 | error |
| `UNCOVERED_FILE` | 文件既无覆盖也无排除 | warning；strict 为 error |
| `MISSING_INDEX` | INDEX 不存在；仍继续其他 spec 检查 | error |
| `MISSING_SPEC` | draft/approved 的 spec 不存在 | error |
| `SPEC_METADATA` | frontmatter 的 id/batch/status 与注册不一致 | error |
| `MISSING_SECTION` | 缺少任一必需的九章标题 | error |
| `EMPTY_SECTION` | 必需标题下没有正文 | error |
| `PLACEHOLDER` | spec 命中占位正则中两个大写英文关键词的词边界匹配 | error |
| `SPEC_COVERAGE_LINK` | spec 没有正确的 coverage Markdown 回链 | error |
| `INDEX_SPEC_LINK` | INDEX 没有正确的 spec Markdown 链接 | error |
| `BROKEN_LINK` | 本地 Markdown 目标不存在 | error |

### 4.10 设计证据的记录格式

子系统 spec 中的事实引用采用：

```text
`path/to/file.ts` 的 `symbolName()`：具体行为或不变量。
```

- 路径用于找到文件，符号用于在文件漂移后复核，行号只作为可失效的定位辅助。
- “测试证明什么”必须写到场景与不变量，不能只列测试文件。
- 注释、公开 contract、schema 或协议可直接支持设计理由。
- 仅从结构推导的动机必须写成“**设计推断：……**”。
- “文件被覆盖”与“某证据支持设计决策”是两件事：前者进入 coverage，后者进入第 7 节正文。

## 5. 失败语义与工程取舍

| 场景 | 当前行为 | 设计理由与代价 |
|---|---|---|
| YAML 字段类型或枚举不合法 | `loadYaml()` 抛出含字段路径的异常；CLI 退出 2 | 输入无法可靠解释时停止，避免级联误报；代价是会掩盖后续可独立报告的问题 |
| Git 命令失败 | 抛出包含 stderr 的异常；CLI 退出 2 | 文件全集不可信，不能继续声称覆盖完整 |
| INDEX 缺失 | 记录错误并继续 spec 检查 | 一次返回更多独立问题；INDEX 链接检查会因空索引额外失败，这是有意的诊断结果 |
| spec 缺失 | `MISSING_SPEC` 后跳过该文件其余检查 | 没有正文可检查，避免读取异常 |
| 原始 `%` 路径不是合法 URI 编码 | decode 失败时使用原始路径 | 合法 Unix 文件名不应让校验器崩溃；代价是 URI 编码路径与原始路径存在歧义时按文件系统实际存在性判断 |
| planned 已创建文件 | `PLANNED_ARTIFACT` | 防止空壳文档；代价是状态与文件创建必须同一批修改 |
| 生成文件删除后排除仍存在 | `STALE_EXCLUSION` | 强制清理过期规则；代价是重生成前必须先同步元数据 |
| 大量文件未覆盖 | 默认逐条最多打印 20 个并汇总 | 保留中间阶段可用性；严格模式仍将全部视为错误 |
| 外部 URL 失效 | 不检查 | 离线校验必须稳定；代价是外部链接需要另行验证 |
| 架构正文写错但结构合法 | 自动检查不能发现 | 必须人工语义评审；增加更多章节检查也不能替代源码事实审查 |

主要性能取舍是排除规则使用文件系统 glob 扫描，coverage 使用显式列表。前者减少手写排除清单，后者让每个主归属都可审查。当前排除数量很少，重复扫描成本可接受；规模风险列入改进建议而不是提前设计缓存。

## 6. 现状验收标准

### 6.1 数据契约

- 非 `schema_version: 1`、错误 roots、非法路径、错误 status/kind、越界 section、空 summary/files 必须被 schema 拒绝，并指出字段路径。
- coverage 的 `spec` 回链必须解析到 manifest 注册的同一 spec；只比较字符串而不是路径解析会误判等价路径。

### 6.2 集合与状态

- 完全覆盖加合法排除时，默认和严格模式均无错误、无警告。
- 同文件重复归属、幽灵路径、覆盖与排除重叠、重复排除、过期排除和未知来源必须产生对应错误。
- 新增未覆盖文件默认产生警告，严格模式产生错误。
- planned 无产物时默认可继续，严格模式失败；planned 有产物时两种模式都失败。

### 6.3 文档与链接

- approved spec 必须具备匹配的 frontmatter、九章非空正文、正确 coverage 回链和 INDEX 链接。
- 缺章、空章、占位符、字段不匹配和断链分别产生可区分诊断。
- INDEX 缺失不能阻止其他 spec 检查。
- 含原始 `%` 的已存在文件链接不得导致 URIError。

### 6.4 CLI 与真实仓库

- 默认中间状态退出 0，结构错误退出 1，未知参数和运行时异常退出 2。
- 诊断逐条输出最多 20 条，但汇总数量准确。
- 真实仓库测试要求结构错误为空，并明确断言 `settingsTypes.generated.ts` 仍是未覆盖文件而不是排除项。
- 完整交付前 `--require-approved` 必须失败；只有所有文件归属完成且所有 spec approved 后才允许转为通过。

## 7. 代码与测试证据

| 设计行为 | 源码证据 | 测试证据及其证明边界 |
|---|---|---|
| Manifest/Coverage 形状 | `scripts/check-design-docs.ts` 的 `manifestSchema`、`coverageSchema`、`loadYaml()` | `tests/designDocsModel.test.ts` 验证合法加载和非法 group 字段路径；不证明任意 YAML 语义 |
| 唯一归属与排除 | `checkOwnership()` 的 `covered/excluded` Map 和 glob 扫描 | `tests/designDocsOwnership.test.ts` 验证完整集合、重复、幽灵、过期排除和严格提升 |
| 九章、元数据和链接 | `checkSpecDocument()`、`checkMarkdownLinks()` | `tests/designDocs.test.ts` 构造完整 fixture，再分别破坏元数据、章节和链接；原始 `%` 用例验证不抛 URIError |
| INDEX 缺失聚合诊断 | `checkDesignDocs()` 使用空 `indexContent` 继续循环 | `tests/designDocs.test.ts` 验证 MISSING_INDEX 之外仍报告 spec 问题 |
| Git 文件发现和 CLI | `listRepositoryFiles()`、`main()` | `tests/designDocsCli.test.ts` 初始化真实临时 Git 仓库，验证默认/严格/未知参数退出码 |
| 真实注册和误排除边界 | 实际 manifest、coverage、INDEX、documentation-system spec | `tests/designDocs.test.ts` 的真实仓库用例要求结构错误为空，并检查手写 re-export 的警告 |

这些测试证明校验器按本文契约工作，不证明其他子系统 spec 的设计正文正确，也不证明 planned 的 SDK/telemetry 功能已经实现。

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/documentation-system.yaml)

本 spec 的主 coverage 只包含：

- `scripts/check-design-docs.ts`。
- `tests/designDocsModel.test.ts`。
- `tests/designDocsOwnership.test.ts`。
- `tests/designDocs.test.ts`。
- `tests/designDocsCli.test.ts`。

`docs/architecture/INDEX.md`、coverage YAML、模板和政策文件由 registry 与文档政策管理，不计入仅限 `src/tests/scripts` 的源码覆盖集合，避免分母口径不一致。

相关子系统边界：

- `sdk-type-generation`：解释 `coreSchemas.ts`、`controlSchemas.ts` 到两个生成类型文件的流程，以及手写 `settingsTypes.generated.ts` 的兼容角色。
- `telemetry`：解释 protobuf 生成契约、来源边界和生成文件使用方式。
- `query-core` 及后续领域 spec：提供实际代码设计正文；本 spec 只定义它们如何注册和被校验，不代替其架构内容。

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险、验收与工作量 |
|---|---|---|---|
| P2 | `loadYaml()` 在第一个损坏的 coverage 抛出，其他 spec 无法继续检查；证据：`checkOwnership()` 直接 await `loadCoverage()` | 将单个 coverage 的解析异常转换为带 spec ID 的 Diagnostic，并继续其他独立条目 | 风险是把根本契约错误与集合错误混在一起；验收为一个损坏 coverage 不掩盖其他错误且 CLI 仍退出 1；S；已证实 |
| P2 | `CoverageGroup.id` 只检查格式，没有检查同文件内重复；证据：`coverageSchema.groups` 无唯一性约束 | 在 ownership 加载后检查同 coverage 内重复 group ID | 风险是旧 coverage 可能已有重复 ID；验收为重复组报清晰错误且不同 spec 可复用相同组 ID；S；已证实 |
| P2 | Markdown 链接使用正则，带嵌套括号或标题的合法链接可能误判；证据：`checkMarkdownLinks()` 的 `matchAll()` | 在真实 spec 出现这些语法后引入小范围 Markdown tokenizer，而非提前替换全部解析 | 风险是新 parser 改变现有链接接受范围；先用嵌套括号和标题 fixture 驱动；M；设计推断 |
| P2 | 每个排除都扫描文件系统，排除数量显著增长时会放大 I/O；证据：`checkOwnership()` 在排除循环内调用 `Bun.Glob.scan()` | 先基准测量，再考虑一次文件遍历匹配多个 glob | 风险是 Bun.Glob 与自定义匹配语义不一致；只有基准证明瓶颈后优化；M；待运行验证 |
| P3 | `Diagnostic` 只有 code/message，调用方难以按文件或 spec 聚合；证据：`Diagnostic` 接口 | 如需 JSON 输出或 IDE 集成，再增加可选 path/specId 字段 | 风险是扩大当前 CLI 契约；只有出现实际消费者时实施；M；设计推断 |
| P1 | 结构合法的设计正文仍可能虚构接口或动机，自动检查无法识别；证据：checker 只验证路径、章节和链接 | 后续每份领域 spec 必须经过源码符号审查和“设计推断”审查，关键控制流应有测试或源码证据 | 风险是把人工评审变成盖章；验收为抽查每个关键决策能回到具体符号/注释/测试；持续成本；已证实 |
