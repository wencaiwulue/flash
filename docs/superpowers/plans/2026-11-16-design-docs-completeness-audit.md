# Design Docs Completeness Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 68 个注册子系统及相关顶层文档完成源码、上游和测试证据审查，交付可追踪、可独立复核的总报告、8 份批次报告和跨子系统契约报告，再交由用户决定整改批次。

**Architecture:** 先固定仓库和上游证据基线并生成 68 行总矩阵，再按 manifest batch 0–7 逐批完成 spec、coverage、源码、测试和上游证据闭环。每批使用“先失败的报告门禁 → 完成报告 → 门禁通过”的测试循环；最后沿 context、memory、session 等真实生命周期进行横向复审。审查阶段只写报告，不修改产品源码或既有子系统 spec。

**Tech Stack:** Markdown、YAML、Bun 1.3+、TypeScript、Git、ripgrep、本机上游 Claude Code 2.1.212（规划时观测值）、上游官方文档与 `strings`。

## Global Constraints

- 权威设计：`docs/superpowers/specs/2026-11-16-design-docs-completeness-audit-design.md`；每个任务都隐含遵守该 spec。
- 所有命令均从仓库根目录 `/Users/fengcaiwen/GolandProjects/claude-code` 执行；若执行环境路径不同，先进入实际仓库根目录，再使用计划中的仓库相对路径。
- 全部 68 个注册子系统、所有 coverage groups、internal/experimental/feature-gated 能力均采用同等审查深度；不得以 external build 禁用为由跳过源码审查。
- 不修改 `src/` 产品实现，不修改既有子系统 spec/coverage/manifest，不批量改变 `draft` 状态，不在本计划中实施整改。
- 只创建或修改 `docs/status/design-docs-completeness-audit/` 下的报告；最终验证产生的构建产物不得提交。
- 不提交当前未跟踪的 `fixtures/token-count-0ec853c8c1b3.json`、`fixtures/token-count-89a86bd029c0.json`、`fixtures/token-count-9657eb13c6fe.json`。
- 官方文档只执行只读 HTTP GET；不得执行上游 CLI 的登录、写配置、模型请求、远程同步或其他有副作用操作。
- 上游证据顺序：官方文档 → 本机二进制 `strings` → 本仓库 external-stubs 契约与既有 spec。行为冲突时记录版本，并优先采用可定位的二进制证据。
- 测试存在、测试通过、mock/offline 通过、live 通过分别记录。私有环境不可用时标为 `blocked` 或 `unverified`，不得推断成功或直接判定实现缺陷。
- 每条发现使用真实批次、spec ID 和两位序号，例如 `B0-query-core-01`；横向发现使用真实领域和两位序号，例如 `X-context-01`。一个问题只有一个主责 spec，其他位置引用同一 ID。
- P0/P1 与上游偏离必须由未参与初稿的审查者进行反驳式独立复核；`设计推断` 不能单独支撑 P0/P1。
- 批次报告必须将真实 spec ID 写成三级标题，例如 `### query-core`，并包含 `## 基线与范围`、`## 子系统审查`、`## 发现登记`、`## 证据边界`、`## 完成判定`。
- 每个子系统小节必须显式写出：coverage group 审查数/总数、文档完整性、实现一致性、上游一致性、验证状态、关键源码证据、测试证据边界、发现 ID 或“无发现”。
- 报告状态只能使用设计定义的枚举：`open`、`blocked`、`unconfirmed`、`complete`、`gaps`、`consistent`、`mismatches`、`aligned`、`deviation`、`live`、`offline-or-mock`、`unverified`、`mixed`。
- 每批完成后用户审阅该批报告；审阅意见只修改报告，不自动修改子系统 spec。
- 每个任务提交信息以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。

## 实施理由与步骤依据

先建立总矩阵和报告门禁，避免 68 个子系统在分批执行时漏项或统计口径漂移。批次顺序沿用 manifest，而非按兴趣跳读，是因为核心 query/SDK 契约需要先确认，后续 context、memory、UI、远程和工程子系统才能引用稳定的基线结论。

每个批次都先运行必然失败的报告门禁，再完成报告使其通过，形成文档工作可执行的 RED→GREEN 循环。独立复核放在提交之前，防止高优先级误报进入权威报告。横向复审放在全部批次之后，因为此时每个主责领域已经有证据，可以专注检查组合行为而不是重复初查。

最终才运行全量测试、typecheck 和 build，并汇总完成门禁。若任何命令失败或报告仍有 `open`，最终任务保持未完成，不得以大多数批次完成宣称全量审查完成。

## File Structure

- Create `docs/status/design-docs-completeness-audit/README.md`：仓库/上游基线、68 行总矩阵、分类统计、整改顺序和最终完成状态。
- Create `docs/status/design-docs-completeness-audit/batch-0.md`：5 个核心 spec，以及顶层文档和未注册工程 spec 的一致性审查。
- Create `docs/status/design-docs-completeness-audit/batch-1.md`：CLI 启动、context compaction、model API。
- Create `docs/status/design-docs-completeness-audit/batch-2.md`：附件、工具、权限、MCP 与会话持久化等 12 个 spec。
- Create `docs/status/design-docs-completeness-audit/batch-3.md`：认证、Git、memory、设置、技能等 9 个 spec。
- Create `docs/status/design-docs-completeness-audit/batch-4.md`：AppState、UI、输入、渲染等 11 个 spec。
- Create `docs/status/design-docs-completeness-audit/batch-5.md`：子代理、计划、调度、任务与 DAG 等 7 个 spec。
- Create `docs/status/design-docs-completeness-audit/batch-6.md`：后台、远程、SSH、teleport 等 7 个 spec。
- Create `docs/status/design-docs-completeness-audit/batch-7.md`：构建、stubs、hooks、运行时、遥测、验证等 14 个 spec。
- Create `docs/status/design-docs-completeness-audit/cross-subsystem.md`：context、memory、共享状态、持久化恢复、构建门和 CLI/SDK/远程契约矩阵。

## 通用证据操作（每个批次任务必须执行）

以下操作定义了所有批次共用的实际工作方法，各任务中的源码与上游步骤必须逐项落实，不能只复制 spec 的 §7 表格。

1. 用 Bun 展开该批 coverage groups 和文件，逐组阅读；不得只按目录猜归属。先把 shell 变量 `BATCH` 设为当前任务的批次号，例如 batch 0 使用 `BATCH=0`，batch 7 使用 `BATCH=7`，再运行：

```bash
bun -e 'import { parse } from "yaml"; const batch = Number(process.argv[1]); const root = "docs/architecture/coverage/"; const manifest = parse(await Bun.file(root + "manifest.yaml").text()); for (const entry of manifest.specs.filter(item => item.batch === batch)) { const coverage = parse(await Bun.file(entry.coverage).text()); console.log(`\n${entry.id}`); for (const group of coverage.groups) { console.log(`  ${group.id} (${group.kind})`); for (const file of group.files) console.log(`    ${file}`); } }' -- "$BATCH"
```

2. 对每个子系统 §2、§4、§5、§7 的关键主张，定位真实符号并记录“主张 → 源码路径+符号 → 实际行为 → 测试场景 → 证据边界”。发现失效行号时以符号为准，不凭旧行号复述。
3. 对 coverage 中 `kind: test` 的文件阅读测试体，而不是只读测试名。只有需要解决证据争议时才运行聚焦测试；命令、退出码和输出摘要写入对应报告。
4. 官方文档索引只下载一次，后续批次复用：

```bash
curl -fsSL https://code.claude.com/docs/llms.txt -o /tmp/flash-design-audit-llms.txt
```

5. 在索引中检索本批主题，抓取实际相关 `.md` 页面；索引无结果只记为“文档未确认”，随后检查二进制，不能推断功能不存在。
6. 二进制证据使用只读命令。每个批次的上游步骤都给出完整检索式和输出路径；以下是 batch 1 的实际示例，其他批次执行各自任务中的字面命令：

```bash
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'autoCompact|microcompact|contextCollapse|marble.origami|reactiveCompact|prompt.{0,20}too long|AUTO_COMPACT_WINDOW|cache_edits' > /tmp/flash-design-audit-batch-1-strings.txt || true
```

7. 将命中的字符串与当前源码符号对照。只有字符串不足以证明完整控制流时，结论保持 `unconfirmed`；不得把字符串片段包装成实机行为验证。
8. 每个批次报告的发现表使用以下列，不可省略证据边界：

```markdown
| ID | 主责 spec | 关联 spec | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
```

9. 高优先级独立复核使用以下提示词。派遣时必须同时给出当前任务 Files 中 Create 的报告路径和报告内实际发现 ID；复核者只读、不编辑：

```text
请对当前批次报告中所有 P0、P1 和“上游偏离”发现做反驳式复核。逐条读取其源码、测试、官方文档摘录和 strings 证据，尝试证明发现不成立或严重度错误。不要信任报告结论，不要修改文件。输出：发现 ID、confirmed/rejected/needs-more-evidence、反证或确认证据、建议严重度。证据不足时必须选 needs-more-evidence。
```

---

### Task 1: 固定基线并建立 68 行总矩阵

**Files:**
- Create: `docs/status/design-docs-completeness-audit/README.md`
- Consumes: `docs/architecture/coverage/manifest.yaml`
- Consumes: `docs/architecture/coverage/*.yaml`

**Interfaces:**
- Produces: 68 行初始总矩阵，字段为 `Spec ID / Batch / Coverage groups / 文档完整性 / 实现一致性 / 上游一致性 / 验证状态 / 发现 / 报告`。
- Produces: 后续任务共用的仓库 commit、上游版本、官方文档索引和报告目录。

- [ ] **Step 1: 运行初始完整性门禁并确认 RED**

Run:

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/README.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: audit matrix missing"); process.exit(1); }'
```

Expected: 退出码 1，输出 `FAIL: audit matrix missing`。若目录已存在，先阅读现有报告，确认是否为之前执行产物；不得覆盖未审阅内容。

- [ ] **Step 2: 固定实际基线并下载只读文档索引**

Run:

```bash
git rev-parse HEAD
git status --short
/opt/homebrew/bin/claude --version
curl -fsSL https://code.claude.com/docs/llms.txt -o /tmp/flash-design-audit-llms.txt
wc -l /tmp/flash-design-audit-llms.txt
```

Expected: HEAD 为完整 commit；状态只包含本计划允许的文档和题目已有的三个未跟踪 fixture；上游输出非空版本；索引下载成功且行数大于 0。规划时上游版本为 `2.1.212 (Claude Code)`，执行时必须记录实际输出而非照抄。

- [ ] **Step 3: 运行文档结构基线并记录真实结果**

Run:

```bash
bun scripts/check-design-docs.ts > /tmp/flash-design-audit-docs-check.out 2> /tmp/flash-design-audit-docs-check.err
exit_code=$?
printf 'exit=%s\n' "$exit_code"
printf '%s\n' '--- stdout ---'
bun -e 'console.log(await Bun.file("/tmp/flash-design-audit-docs-check.out").text())'
printf '%s\n' '--- stderr summary ---'
wc -l /tmp/flash-design-audit-docs-check.err
exit "$exit_code"
```

Expected: 退出码 0；规划时结果为 `0 errors, 71 warnings`。执行时把真实输出写入 README 基线；若有新增错误，先记录为 `documentation-system` 发现，不得假装基线干净。

- [ ] **Step 4: 生成完整初始矩阵使门禁 GREEN**

Run:

```bash
bun - <<'TS'
import { parse } from 'yaml'
const manifestPath = 'docs/architecture/coverage/manifest.yaml'
const manifest = parse(await Bun.file(manifestPath).text())
const commit = new TextDecoder().decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout).trim()
const upstream = new TextDecoder().decode(Bun.spawnSync(['/opt/homebrew/bin/claude', '--version']).stdout).trim()
const rows = []
for (const entry of manifest.specs) {
  const coverage = parse(await Bun.file(entry.coverage).text())
  rows.push(`| ${entry.id} | ${entry.batch} | 0/${coverage.groups.length} | open | open | open | unverified | 0 | 未生成 |`)
}
const content = [
  '# Design Docs Completeness Audit',
  '',
  '## 基线',
  '',
  `- 仓库 commit：${commit}`,
  `- 上游 CLI：${upstream}`,
  '- 官方文档索引：https://code.claude.com/docs/llms.txt',
  `- 矩阵生成时间：${new Date().toISOString()}`,
  '- 范围：68 个注册子系统、全部 coverage groups、顶层文档、未注册工程 spec 与横向契约。',
  '- 当前状态：矩阵已建立，子系统审查尚未完成；open 不表示无问题。',
  '',
  '## 总矩阵',
  '',
  '| Spec ID | Batch | Coverage groups | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 发现 | 报告 |',
  '|---|---:|---:|---|---|---|---|---:|---|',
  ...rows,
  '',
  '## 分类统计与整改顺序',
  '',
  '各批次尚未完成，当前不统计问题，不生成整改顺序。',
  '',
  '## 完成判定',
  '',
  'open：等待 batch 0–7 和横向契约复审。',
  '',
].join('\n')
await Bun.write('docs/status/design-docs-completeness-audit/README.md', content)
TS
```

Expected: README 含 68 个 spec 行，所有初始状态为 `open`；这不是完成报告，而是防漏项基线。

- [ ] **Step 5: 验证 68 行、分组数量和基线字段**

Run:

```bash
bun - <<'TS'
import { parse } from 'yaml'
const manifest = parse(await Bun.file('docs/architecture/coverage/manifest.yaml').text())
const report = await Bun.file('docs/status/design-docs-completeness-audit/README.md').text()
const missing = manifest.specs.filter(entry => !report.includes(`| ${entry.id} | ${entry.batch} |`))
if (manifest.specs.length !== 68 || missing.length) {
  console.error({ registered: manifest.specs.length, missing: missing.map(entry => entry.id) })
  process.exit(1)
}
for (const field of ['仓库 commit：', '上游 CLI：', '## 总矩阵', '## 完成判定']) {
  if (!report.includes(field)) throw new Error(`missing ${field}`)
}
console.log('PASS: 68 subsystem rows and baseline fields present')
TS
```

Expected: `PASS: 68 subsystem rows and baseline fields present`，退出码 0。

- [ ] **Step 6: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md
git commit -m "Start comprehensive design docs audit" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 审查 batch 0 核心契约与顶层文档

**Files:**
- Create: `docs/status/design-docs-completeness-audit/batch-0.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Review: `docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md` + `docs/architecture/coverage/documentation-system.yaml`
- Review: `docs/superpowers/specs/2026-11-12-plugins-design.md` + `docs/architecture/coverage/plugins.yaml`
- Review: `docs/superpowers/specs/2026-11-12-query-core-design.md` + `docs/architecture/coverage/query-core.yaml`
- Review: `docs/superpowers/specs/2026-11-12-sdk-query-sessions-design.md` + `docs/architecture/coverage/sdk-query-sessions.yaml`
- Review: `docs/superpowers/specs/2026-11-12-sdk-type-generation-design.md` + `docs/architecture/coverage/sdk-type-generation.yaml`
- Review: `docs/ARCHITECTURE.md`、`docs/architecture/INDEX.md`、`docs/COMMIT_DOCS.md`、`docs/STATUS.md`
- Review: `docs/superpowers/specs/2026-11-11-date-based-commit-design-docs-design.md`
- Review: `docs/superpowers/specs/2026-11-12-external-feature-profile-design.md`
- Review: `docs/superpowers/specs/2026-11-13-playwright-chrome-lifecycle-design.md`
- Review: `docs/superpowers/specs/2026-11-14-flash-rename-design.md`
- Review: `docs/superpowers/specs/2026-11-14-readme-language-split-design.md`
- Review: `docs/superpowers/specs/2026-11-14-sh-installer-design.md`
- Review: `docs/superpowers/specs/2026-11-15-chrome-bundled-wiring-design.md`
- Review: `docs/superpowers/specs/2026-11-15-flash-coding-skill-design.md`
- Review: `docs/superpowers/specs/2026-11-16-design-docs-completeness-audit-design.md`

**Interfaces:**
- Consumes: Task 1 的 68 行矩阵与证据基线。
- Produces: 5 个核心子系统结论、顶层文档一致性发现，以及后续批次可引用的 query/SDK 主契约。

- [ ] **Step 1: 运行 batch 0 报告门禁并确认 RED**

```bash
bun -e 'const ids = ["documentation-system","plugins","query-core","sdk-query-sessions","sdk-type-generation"]; const file = "docs/status/design-docs-completeness-audit/batch-0.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-0 report missing", ids); process.exit(1); }'
```

Expected: 退出码 1，报告尚不存在。

- [ ] **Step 2: 逐 coverage group 核对五个子系统**

Run 通用证据操作第 1 条，参数为 `0`。逐个阅读展开的源码和测试，并重点回答：

- `documentation-system`：结构校验与语义校验边界、planned/draft/approved、唯一归属、排除和诊断是否准确；71 个基线警告的组成是否被如实分类。
- `plugins`：发现、加载、缓存、 marketplace、命令/技能/agent 合并、禁用与错误路径是否完整。
- `query-core`：消息数组所有权、主循环、generator 完成、取消、工具配对、compact/snip/withheld 分支、持久化顺序是否准确。
- `sdk-query-sessions`：V1/V2、多轮、控制面、abort、checkpoint、fork/resume、资源清理和 SDK/CLI 隔离是否一致。
- `sdk-type-generation`：schema→类型→声明的真实顺序、生成/手写文件边界和 build 前置条件是否准确。

- [ ] **Step 3: 审查顶层文档与未注册工程 spec**

逐份阅读 Files 中 13 份顶层/工程文档，检查它们是否与当前命令、命名、构建、发布、external stubs 和审查方案一致。每份至少记录“当前有效 / 历史设计 / 被后续文档替代 / 与现状冲突”之一及证据；不得因为没有 coverage 而跳过，也不得把它们加入 manifest。

- [ ] **Step 4: 收集 batch 0 上游证据**

```bash
rg -n -i 'plugin|query|session|sdk|checkpoint|fork|resume|type' /tmp/flash-design-audit-llms.txt > /tmp/flash-design-audit-batch-0-doc-index.txt || true
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'unstable_v2|resumeSession|forkSession|checkpoint|plugin|QueryEngine|generate.*type' > /tmp/flash-design-audit-batch-0-strings.txt || true
```

读取并引用相关官方页面，至少包括 `https://code.claude.com/docs/en/plugins.md`、`https://code.claude.com/docs/en/agent-sdk/sessions.md`、`https://code.claude.com/docs/en/agent-sdk/session-storage.md`、`https://code.claude.com/docs/en/agent-sdk/agent-loop.md`、`https://code.claude.com/docs/en/checkpointing.md`。不存在的 URL 记录真实 HTTP 结果并回退索引，不虚构页面内容。

- [ ] **Step 5: 写 batch-0 报告并更新总矩阵**

报告包含五个真实 spec ID 的三级小节、顶层文档专节、发现表、证据边界和完成判定。每个 coverage group 都有审查记录；query/SDK 的跨域问题只设一个主责。将 README 对应 5 行的 open 替换为实际结论，并使用真实锚点链接，例如 `batch-0.md#query-core`；其余 63 行保持原状态。

- [ ] **Step 6: 独立复核高优先级发现并处理反证**

使用通用提示词复核 batch-0。被驳回的发现删除或降级；证据不足的改为 `unconfirmed`/`待运行验证`，不能为保留 P0/P1 而补写推测。

- [ ] **Step 7: 运行 batch 0 门禁和文档检查**

```bash
bun - <<'TS'
const ids = ['documentation-system','plugins','query-core','sdk-query-sessions','sdk-type-generation']
const report = await Bun.file('docs/status/design-docs-completeness-audit/batch-0.md').text()
const required = ['## 基线与范围','## 子系统审查','## 发现登记','## 证据边界','## 完成判定','## 顶层与工程文档一致性']
const missing = [...ids.filter(id => !report.includes(`### ${id}\n`)), ...required.filter(h => !report.includes(h))]
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
console.log('PASS: batch 0 has 5 subsystem sections and required audit sections')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: 门禁 PASS；结构检查 0 errors；无 whitespace 错误。然后请用户审阅 batch-0，按意见仅修订报告。

- [ ] **Step 8: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/batch-0.md
git commit -m "Audit core design contracts" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 审查 batch 1 启动、模型与 Context Compaction

**Files:**
- Create: `docs/status/design-docs-completeness-audit/batch-1.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Review: `docs/superpowers/specs/2026-11-12-cli-startup-design.md` + `docs/architecture/coverage/cli-startup.yaml`
- Review: `docs/superpowers/specs/2026-11-12-context-compaction-design.md` + `docs/architecture/coverage/context-compaction.yaml`
- Review: `docs/superpowers/specs/2026-11-12-model-api-design.md` + `docs/architecture/coverage/model-api.yaml`

**Interfaces:**
- Consumes: batch 0 的 query/SDK 主契约。
- Produces: context 生命周期初查结论和 `B1-*` 发现，供横向复审引用。

- [ ] **Step 1: 运行 batch 1 报告门禁并确认 RED**

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/batch-1.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-1 report missing"); process.exit(1); }'
```

Expected: 退出码 1。

- [ ] **Step 2: 逐 coverage group 核对源码和测试**

Run 通用证据操作第 1 条，参数为 `1`。重点回答：

- `cli-startup`：version/help 快速路径、interactive/headless、TTY、bundled/source、初始化顺序和失败退出。
- `context-compaction`：模型投影与 transcript/磁盘的区别；microcompact、snip、collapse、auto/reactive/manual/session-memory compact 的真实顺序与互斥；token 窗口、工具配对、UUID 链、boundary、附件重建、持久化恢复、reset/后台竞态。
- `model-api`：请求组装、流式响应、重试、abort、token 统计、cache edits、PTL 错误与模型功能门。
- 阅读 `tests/contextCollapse.test.ts`、`tests/reactiveCompact.test.ts` 的测试体；需要解决争议时分别运行 `bun test tests/contextCollapse.test.ts` 或 `bun test tests/reactiveCompact.test.ts`，记录真实退出码。

- [ ] **Step 3: 收集 batch 1 上游证据**

```bash
rg -n -i 'compact|context window|model|cache|prompt too long|token' /tmp/flash-design-audit-llms.txt > /tmp/flash-design-audit-batch-1-doc-index.txt || true
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'autoCompact|microcompact|contextCollapse|marble.origami|reactiveCompact|prompt.{0,20}too long|AUTO_COMPACT_WINDOW|cache_edits' > /tmp/flash-design-audit-batch-1-strings.txt || true
```

读取 `https://code.claude.com/docs/en/model-config.md`、`https://code.claude.com/docs/en/context-window.md`、`https://code.claude.com/docs/en/prompt-caching.md`、`https://code.claude.com/docs/en/troubleshooting.md`。逐项区分公开文档行为和仅二进制可见行为。

- [ ] **Step 4: 写 batch-1 报告并独立复核**

三个子系统小节必须完整列出 coverage groups。Context 报告单独给出“请求前 → 请求中 → PTL → boundary → QueryEngine → session restore”的证据链；所有 P0/P1 和上游偏离按通用提示词独立复核。更新 README 对应 3 行。

- [ ] **Step 5: 运行门禁、文档检查并提交用户审阅**

```bash
bun - <<'TS'
const ids = ['cli-startup','context-compaction','model-api']
const report = await Bun.file('docs/status/design-docs-completeness-audit/batch-1.md').text()
const required = ['## 基线与范围','## 子系统审查','## 发现登记','## 证据边界','## 完成判定']
const missing = [...ids.filter(id => !report.includes(`### ${id}\n`)), ...required.filter(h => !report.includes(h))]
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
console.log('PASS: batch 1 has 3 subsystem sections')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: PASS、0 errors、无 whitespace 错误。请用户审阅 batch-1，尤其是 context 证据链。

- [ ] **Step 6: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/batch-1.md
git commit -m "Audit context and model design specs" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 审查 batch 2 工具、权限与会话持久化

**Files:**
- Create: `docs/status/design-docs-completeness-audit/batch-2.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Review: `docs/superpowers/specs/2026-11-12-attachments-design.md` + `docs/architecture/coverage/attachments.yaml`
- Review: `docs/superpowers/specs/2026-11-12-bridge-design.md` + `docs/architecture/coverage/bridge.yaml`
- Review: `docs/superpowers/specs/2026-11-12-buddy-design.md` + `docs/architecture/coverage/buddy.yaml`
- Review: `docs/superpowers/specs/2026-11-12-computer-use-design.md` + `docs/architecture/coverage/computer-use.yaml`
- Review: `docs/superpowers/specs/2026-11-12-file-tools-design.md` + `docs/architecture/coverage/file-tools.yaml`
- Review: `docs/superpowers/specs/2026-11-12-lsp-design.md` + `docs/architecture/coverage/lsp.yaml`
- Review: `docs/superpowers/specs/2026-11-12-mcp-design.md` + `docs/architecture/coverage/mcp.yaml`
- Review: `docs/superpowers/specs/2026-11-12-onboarding-ui-design.md` + `docs/architecture/coverage/onboarding-ui.yaml`
- Review: `docs/superpowers/specs/2026-11-12-permissions-design.md` + `docs/architecture/coverage/permissions.yaml`
- Review: `docs/superpowers/specs/2026-11-12-session-persistence-design.md` + `docs/architecture/coverage/session-persistence.yaml`
- Review: `docs/superpowers/specs/2026-11-12-shell-tools-design.md` + `docs/architecture/coverage/shell-tools.yaml`
- Review: `docs/superpowers/specs/2026-11-12-tool-framework-design.md` + `docs/architecture/coverage/tool-framework.yaml`

**Interfaces:**
- Consumes: batch 0/1 的消息、工具调用和 compact 边界。
- Produces: 12 个子系统结论及权限、工具结果、附件、session 持久化的关联发现。

- [ ] **Step 1: 运行 batch 2 报告门禁并确认 RED**

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/batch-2.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-2 report missing"); process.exit(1); }'
```

Expected: 退出码 1。

- [ ] **Step 2: 逐 coverage group 核对 12 个子系统**

Run 通用证据操作第 1 条，参数为 `2`。逐一审查：附件注入/预算与媒体错误；bridge 配对和生命周期；buddy 会话通知；浏览器/桌面后端和 sidecar；文件读写编辑与路径安全；LSP 生命周期；MCP 发现/重连/工具合并；首次信任；权限 allow/ask/deny 与持久规则；JSONL、UUID、恢复和文件历史；shell 沙箱/进程组/取消；工具契约、结果错误和并发上下文。每项同时检查 feature-disabled、bundled 和 live 证据边界。

- [ ] **Step 3: 收集 batch 2 上游证据**

```bash
rg -n -i 'permission|mcp|chrome|computer|file|shell|bash|session|lsp|attachment|trust' /tmp/flash-design-audit-llms.txt > /tmp/flash-design-audit-batch-2-doc-index.txt || true
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'tool_result|permission|canUseTool|sessionStorage|parentUuid|chrome|computer.use|mcp|sandbox|lsp' > /tmp/flash-design-audit-batch-2-strings.txt || true
```

读取索引命中的权限、MCP、Chrome、会话、checkpoint、hooks 和 SDK tools 页面。涉及私有 native messaging/bridge 协议时，必须再读 `docs/external-stubs/contracts/` 对应契约，不得从字符串宣称兼容。

- [ ] **Step 4: 写 batch-2 报告并独立复核**

每个 spec 一个三级小节，发现使用 `B2-*`。权限与 ReviewArtifact、WebBrowser 错误、session UUID 等跨域问题引用已有主责或建立唯一新 ID，不重复创建整改项。复核所有 P0/P1 与上游偏离，更新 README 对应 12 行。

- [ ] **Step 5: 运行门禁、文档检查并提交用户审阅**

```bash
bun - <<'TS'
const ids = ['attachments','bridge','buddy','computer-use','file-tools','lsp','mcp','onboarding-ui','permissions','session-persistence','shell-tools','tool-framework']
const report = await Bun.file('docs/status/design-docs-completeness-audit/batch-2.md').text()
const required = ['## 基线与范围','## 子系统审查','## 发现登记','## 证据边界','## 完成判定']
const missing = [...ids.filter(id => !report.includes(`### ${id}\n`)), ...required.filter(h => !report.includes(h))]
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
console.log('PASS: batch 2 has 12 subsystem sections')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: PASS、0 errors、无 whitespace 错误。请用户审阅 batch-2。

- [ ] **Step 6: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/batch-2.md
git commit -m "Audit tools and session design specs" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 审查 batch 3 Memory、设置、认证与恢复

**Files:**
- Create: `docs/status/design-docs-completeness-audit/batch-3.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Review: `docs/superpowers/specs/2026-11-12-auth-design.md` + `docs/architecture/coverage/auth.yaml`
- Review: `docs/superpowers/specs/2026-11-12-commit-attribution-design.md` + `docs/architecture/coverage/commit-attribution.yaml`
- Review: `docs/superpowers/specs/2026-11-12-git-integration-design.md` + `docs/architecture/coverage/git-integration.yaml`
- Review: `docs/superpowers/specs/2026-11-12-memory-design.md` + `docs/architecture/coverage/memory.yaml`
- Review: `docs/superpowers/specs/2026-11-12-notifications-design.md` + `docs/architecture/coverage/notifications.yaml`
- Review: `docs/superpowers/specs/2026-11-12-session-search-recovery-design.md` + `docs/architecture/coverage/session-search-recovery.yaml`
- Review: `docs/superpowers/specs/2026-11-12-sessions-share-design.md` + `docs/architecture/coverage/sessions-share.yaml`
- Review: `docs/superpowers/specs/2026-11-12-settings-design.md` + `docs/architecture/coverage/settings.yaml`
- Review: `docs/superpowers/specs/2026-11-12-skills-design.md` + `docs/architecture/coverage/skills.yaml`

**Interfaces:**
- Consumes: batch 0–2 的 query、compact、session 和权限证据。
- Produces: memory 生命周期初查结论、9 个子系统报告和 `B3-*` 发现。

- [ ] **Step 1: 运行 batch 3 报告门禁并确认 RED**

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/batch-3.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-3 report missing"); process.exit(1); }'
```

Expected: 退出码 1。

- [ ] **Step 2: 逐 coverage group 核对源码和测试**

Run 通用证据操作第 1 条，参数为 `3`。重点审查：OAuth/凭据存储；提交归因；Git/GitHub；通知折叠；会话搜索/跨项目恢复；分享导出；设置来源和优先级；技能发现/缓存/路径；memory 全生命周期。

Memory 必须逐项回答：auto/team/session/CLAUDE.md/daily log 边界；MEMORY.md 截断；findRelevantMemories/memoryAge/memoryScan；主代理写入与 extractMemories；Session Memory 与 compact；autoDream；重启 cursor；删除/失效/缓存；团队 watcher、secret、symlink、ETag 冲突；多会话和取消。不得只复核 memdir.ts 而遗漏 coverage 中其他文件。

- [ ] **Step 3: 收集 batch 3 上游证据**

```bash
rg -n -i 'memory|remember|CLAUDE.md|settings|oauth|session|resume|skill|dream|team' /tmp/flash-design-audit-llms.txt > /tmp/flash-design-audit-batch-3-doc-index.txt || true
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'autoMemory|MEMORY.md|extractMemories|autoDream|session.memory|team.memory|memoryDirectory|lastMemoryMessageUuid|tengu_session_memory' > /tmp/flash-design-audit-batch-3-strings.txt || true
```

读取 `https://code.claude.com/docs/en/memory.md`、`https://code.claude.com/docs/en/claude-directory.md`、`https://code.claude.com/docs/en/large-codebases.md`、`https://code.claude.com/docs/en/settings.md`、`https://code.claude.com/docs/en/settings-reference.md`、`https://code.claude.com/docs/en/sessions.md`、`https://code.claude.com/docs/en/skills.md`。公开文档未描述 team/autoDream 时保留二进制证据和未验证边界。

- [ ] **Step 4: 写 batch-3 报告并独立复核**

Memory 小节增加“加载 → 检索 → 写入/提取 → 整理/同步 → 失效 → compact → restore”证据链。symlink 安全结论必须同时检查权限路径和实际写入路径；没有可复现越界路径不得写 P0。复核所有 P0/P1 和上游偏离，更新 README 对应 9 行。

- [ ] **Step 5: 运行门禁、文档检查并提交用户审阅**

```bash
bun - <<'TS'
const ids = ['auth','commit-attribution','git-integration','memory','notifications','session-search-recovery','sessions-share','settings','skills']
const report = await Bun.file('docs/status/design-docs-completeness-audit/batch-3.md').text()
const required = ['## 基线与范围','## 子系统审查','## 发现登记','## 证据边界','## 完成判定']
const missing = [...ids.filter(id => !report.includes(`### ${id}\n`)), ...required.filter(h => !report.includes(h))]
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
console.log('PASS: batch 3 has 9 subsystem sections')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: PASS、0 errors、无 whitespace 错误。请用户审阅 batch-3，尤其是 memory 证据链。

- [ ] **Step 6: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/batch-3.md
git commit -m "Audit memory and settings design specs" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 审查 batch 4 AppState 与终端 UI

**Files:**
- Create: `docs/status/design-docs-completeness-audit/batch-4.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Review: `docs/superpowers/specs/2026-11-12-app-state-design.md` + `docs/architecture/coverage/app-state.yaml`
- Review: `docs/superpowers/specs/2026-11-12-assistant-ui-design.md` + `docs/architecture/coverage/assistant-ui.yaml`
- Review: `docs/superpowers/specs/2026-11-12-commands-framework-design.md` + `docs/architecture/coverage/commands-framework.yaml`
- Review: `docs/superpowers/specs/2026-11-12-cost-tracking-design.md` + `docs/architecture/coverage/cost-tracking.yaml`
- Review: `docs/superpowers/specs/2026-11-12-ide-integration-design.md` + `docs/architecture/coverage/ide-integration.yaml`
- Review: `docs/superpowers/specs/2026-11-12-ink-platform-design.md` + `docs/architecture/coverage/ink-platform.yaml`
- Review: `docs/superpowers/specs/2026-11-12-repl-input-design.md` + `docs/architecture/coverage/repl-input.yaml`
- Review: `docs/superpowers/specs/2026-11-12-text-formatting-design.md` + `docs/architecture/coverage/text-formatting.yaml`
- Review: `docs/superpowers/specs/2026-11-12-ui-rendering-design.md` + `docs/architecture/coverage/ui-rendering.yaml`
- Review: `docs/superpowers/specs/2026-11-12-voice-assistant-design.md` + `docs/architecture/coverage/voice-assistant.yaml`
- Review: `docs/superpowers/specs/2026-11-12-workspace-ui-design.md` + `docs/architecture/coverage/workspace-ui.yaml`

**Interfaces:**
- Consumes: 前序消息、权限、会话和 memory 主契约。
- Produces: 11 个 UI/状态子系统结论及 UI 与模型投影的关联发现。

- [ ] **Step 1: 运行 batch 4 报告门禁并确认 RED**

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/batch-4.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-4 report missing"); process.exit(1); }'
```

Expected: 退出码 1。

- [ ] **Step 2: 逐 coverage group 核对 11 个子系统**

Run 通用证据操作第 1 条，参数为 `4`。检查 AppState 所有权/订阅/清理；助手消息与历史交互；命令解析；成本/用量；IDE 连接；Ink 原生边界；REPL 输入和取消；ANSI/文本；消息和工具渲染；语音生命周期；工作区/diff/dialog。重点区分 UI 展示历史与模型可见投影，并检查无 TTY、bundled、外部构建下的行为。

- [ ] **Step 3: 收集 batch 4 上游证据**

```bash
rg -n -i 'ide|terminal|ink|voice|cost|usage|command|vim|renderer|ui' /tmp/flash-design-audit-llms.txt > /tmp/flash-design-audit-batch-4-doc-index.txt || true
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'AppState|Ink|voice|cost|token usage|IDE|keybinding|slash command|compact warning' > /tmp/flash-design-audit-batch-4-strings.txt || true
```

读取索引命中的 IDE、CLI 参考、键盘快捷键、usage/cost、voice 和配置页面。UI 外观不能仅凭字符串推断，未实机运行时标记证据边界。

- [ ] **Step 4: 写 batch-4 报告并独立复核**

每个 spec 一个三级小节；可选视觉/体验改进与已证实状态错误分开分级。高优先级发现独立复核后更新 README 对应 11 行。

- [ ] **Step 5: 运行门禁、文档检查并提交用户审阅**

```bash
bun - <<'TS'
const ids = ['app-state','assistant-ui','commands-framework','cost-tracking','ide-integration','ink-platform','repl-input','text-formatting','ui-rendering','voice-assistant','workspace-ui']
const report = await Bun.file('docs/status/design-docs-completeness-audit/batch-4.md').text()
const required = ['## 基线与范围','## 子系统审查','## 发现登记','## 证据边界','## 完成判定']
const missing = [...ids.filter(id => !report.includes(`### ${id}\n`)), ...required.filter(h => !report.includes(h))]
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
console.log('PASS: batch 4 has 11 subsystem sections')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: PASS、0 errors、无 whitespace 错误。请用户审阅 batch-4。

- [ ] **Step 6: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/batch-4.md
git commit -m "Audit state and terminal UI design specs" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 审查 batch 5 Agent、任务与工作流

**Files:**
- Create: `docs/status/design-docs-completeness-audit/batch-5.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Review: `docs/superpowers/specs/2026-11-12-agent-swarms-design.md` + `docs/architecture/coverage/agent-swarms.yaml`
- Review: `docs/superpowers/specs/2026-11-12-help-feedback-design.md` + `docs/architecture/coverage/help-feedback.yaml`
- Review: `docs/superpowers/specs/2026-11-12-plan-worktree-design.md` + `docs/architecture/coverage/plan-worktree.yaml`
- Review: `docs/superpowers/specs/2026-11-12-review-analysis-design.md` + `docs/architecture/coverage/review-analysis.yaml`
- Review: `docs/superpowers/specs/2026-11-12-scheduling-design.md` + `docs/architecture/coverage/scheduling.yaml`
- Review: `docs/superpowers/specs/2026-11-13-task-system-design.md` + `docs/architecture/coverage/task-system.yaml`
- Review: `docs/superpowers/specs/2026-11-12-workflow-design.md` + `docs/architecture/coverage/workflow.yaml`

**Interfaces:**
- Consumes: query、工具、权限、AppState 和持久化证据。
- Produces: 7 个子系统结论、fork/全局状态及后台并发的横向候选问题。

- [ ] **Step 1: 运行 batch 5 报告门禁并确认 RED**

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/batch-5.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-5 report missing"); process.exit(1); }'
```

Expected: 退出码 1。

- [ ] **Step 2: 逐 coverage group 核对 7 个子系统**

Run 通用证据操作第 1 条，参数为 `5`。检查子代理/团队/协调；帮助反馈；plan/worktree 隔离；ReviewArtifact 与权限输入；cron/主动唤醒；任务状态/后台执行/清理；DAG skip/retry/generation/终态。特别检查 forked agent 与 collapse、microcompact、memory 全局状态的隔离，以及旧 runner 迟到结果。

- [ ] **Step 3: 收集 batch 5 上游证据**

```bash
rg -n -i 'subagent|agent team|worktree|plan|review|cron|schedule|task|workflow|feedback' /tmp/flash-design-audit-llms.txt > /tmp/flash-design-audit-batch-5-doc-index.txt || true
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'runForkedAgent|agent team|worktree|ReviewArtifact|cron|workflow|retry|generation|DreamTask' > /tmp/flash-design-audit-batch-5-strings.txt || true
```

读取索引命中的 subagents、agent teams、scheduled tasks、worktree、hooks 和 SDK agent-loop 页面。内部 KAIROS/coordinator 无公开文档时保持二进制与静态证据边界。

- [ ] **Step 4: 写 batch-5 报告并独立复核**

DAG 和任务并发问题必须给出具体状态序列，不能只写“可能竞态”。ReviewArtifact 权限问题关联 batch 2 主责。复核 P0/P1 与上游偏离，更新 README 对应 7 行。

- [ ] **Step 5: 运行门禁、文档检查并提交用户审阅**

```bash
bun - <<'TS'
const ids = ['agent-swarms','help-feedback','plan-worktree','review-analysis','scheduling','task-system','workflow']
const report = await Bun.file('docs/status/design-docs-completeness-audit/batch-5.md').text()
const required = ['## 基线与范围','## 子系统审查','## 发现登记','## 证据边界','## 完成判定']
const missing = [...ids.filter(id => !report.includes(`### ${id}\n`)), ...required.filter(h => !report.includes(h))]
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
console.log('PASS: batch 5 has 7 subsystem sections')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: PASS、0 errors、无 whitespace 错误。请用户审阅 batch-5。

- [ ] **Step 6: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/batch-5.md
git commit -m "Audit agent and workflow design specs" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 审查 batch 6 后台、远程与迁移

**Files:**
- Create: `docs/status/design-docs-completeness-audit/batch-6.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Review: `docs/superpowers/specs/2026-11-12-daemon-background-design.md` + `docs/architecture/coverage/daemon-background.yaml`
- Review: `docs/superpowers/specs/2026-11-12-deep-link-design.md` + `docs/architecture/coverage/deep-link.yaml`
- Review: `docs/superpowers/specs/2026-11-12-open-runner-design.md` + `docs/architecture/coverage/open-runner.yaml`
- Review: `docs/superpowers/specs/2026-11-12-platform-integrations-design.md` + `docs/architecture/coverage/platform-integrations.yaml`
- Review: `docs/superpowers/specs/2026-11-12-remote-control-design.md` + `docs/architecture/coverage/remote-control.yaml`
- Review: `docs/superpowers/specs/2026-11-12-ssh-design.md` + `docs/architecture/coverage/ssh.yaml`
- Review: `docs/superpowers/specs/2026-11-12-teleport-design.md` + `docs/architecture/coverage/teleport.yaml`

**Interfaces:**
- Consumes: 会话、任务、权限和 runtime 证据。
- Produces: 7 个远程/后台子系统结论及私有协议验证边界。

- [ ] **Step 1: 运行 batch 6 报告门禁并确认 RED**

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/batch-6.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-6 report missing"); process.exit(1); }'
```

Expected: 退出码 1。

- [ ] **Step 2: 逐 coverage group 与 stubs 契约核对**

Run 通用证据操作第 1 条，参数为 `6`。检查 daemon/后台会话；deep-link 解析；Open Runner worker；桌面/移动/协作平台；远程重连；SSH 认证/进程；teleport 迁移恢复。相关 `docs/external-stubs/contracts/` 契约必须逐项对照；不得连接私有服务或声称协议已 live 兼容。

- [ ] **Step 3: 收集 batch 6 上游证据**

```bash
rg -n -i 'remote|daemon|background|deep.link|ssh|teleport|desktop|mobile|slack|discord|runner' /tmp/flash-design-audit-llms.txt > /tmp/flash-design-audit-batch-6-doc-index.txt || true
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'teleport|remote.control|deep.link|ssh|daemon|open.runner|background.session|reconnect' > /tmp/flash-design-audit-batch-6-strings.txt || true
```

读取索引命中的远程、SSH、桌面、移动、Slack/Discord 和后台任务页面。无法访问的环境全部列入验证边界。

- [ ] **Step 4: 写 batch-6 报告并独立复核**

每个子系统分别记录“源码实现”“external stub”“协议证据”“live 状态”。高优先级结论必须有直接路径和失败序列；更新 README 对应 7 行。

- [ ] **Step 5: 运行门禁、文档检查并提交用户审阅**

```bash
bun - <<'TS'
const ids = ['daemon-background','deep-link','open-runner','platform-integrations','remote-control','ssh','teleport']
const report = await Bun.file('docs/status/design-docs-completeness-audit/batch-6.md').text()
const required = ['## 基线与范围','## 子系统审查','## 发现登记','## 证据边界','## 完成判定']
const missing = [...ids.filter(id => !report.includes(`### ${id}\n`)), ...required.filter(h => !report.includes(h))]
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
console.log('PASS: batch 6 has 7 subsystem sections')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: PASS、0 errors、无 whitespace 错误。请用户审阅 batch-6。

- [ ] **Step 6: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/batch-6.md
git commit -m "Audit remote and background design specs" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 审查 batch 7 构建、Stubs、Hooks 与运行时

**Files:**
- Create: `docs/status/design-docs-completeness-audit/batch-7.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Review: `docs/superpowers/specs/2026-11-12-build-feature-profile-design.md` + `docs/architecture/coverage/build-feature-profile.yaml`
- Review: `docs/superpowers/specs/2026-11-12-data-structures-design.md` + `docs/architecture/coverage/data-structures.yaml`
- Review: `docs/superpowers/specs/2026-11-12-diagnostics-design.md` + `docs/architecture/coverage/diagnostics.yaml`
- Review: `docs/superpowers/specs/2026-11-12-experimental-features-design.md` + `docs/architecture/coverage/experimental-features.yaml`
- Review: `docs/superpowers/specs/2026-11-12-external-stubs-design.md` + `docs/architecture/coverage/external-stubs.yaml`
- Review: `docs/superpowers/specs/2026-11-12-hooks-system-design.md` + `docs/architecture/coverage/hooks-system.yaml`
- Review: `docs/superpowers/specs/2026-11-12-magic-docs-design.md` + `docs/architecture/coverage/magic-docs.yaml`
- Review: `docs/superpowers/specs/2026-11-12-messaging-primitives-design.md` + `docs/architecture/coverage/messaging-primitives.yaml`
- Review: `docs/superpowers/specs/2026-11-12-native-installer-design.md` + `docs/architecture/coverage/native-installer.yaml`
- Review: `docs/superpowers/specs/2026-11-12-network-security-design.md` + `docs/architecture/coverage/network-security.yaml`
- Review: `docs/superpowers/specs/2026-11-12-runtime-lifecycle-design.md` + `docs/architecture/coverage/runtime-lifecycle.yaml`
- Review: `docs/superpowers/specs/2026-11-12-telemetry-design.md` + `docs/architecture/coverage/telemetry.yaml`
- Review: `docs/superpowers/specs/2026-11-12-test-validation-design.md` + `docs/architecture/coverage/test-validation.yaml`
- Review: `docs/superpowers/specs/2026-11-12-web-tools-design.md` + `docs/architecture/coverage/web-tools.yaml`

**Interfaces:**
- Consumes: 前 7 批全部主契约和关联发现。
- Produces: 最后 14 个子系统结论、构建/验证边界及横向复审输入。

- [ ] **Step 1: 运行 batch 7 报告门禁并确认 RED**

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/batch-7.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-7 report missing"); process.exit(1); }'
```

Expected: 退出码 1。

- [ ] **Step 2: 逐 coverage group 核对 14 个子系统**

Run 通用证据操作第 1 条，参数为 `7`。检查构建/feature profile；通用数据结构；诊断和敏感日志；实验功能；external stubs；hooks 事件/异步/退出码；magic docs；消息寻址；原生安装/更新；证书/代理/云凭据；取消/清理/退出；telemetry 隐私；测试与 live 证据；web 搜索/抓取/内容预算。检查 `docs/external-stubs/contracts/*.md` 与 protocol gates，不把禁用边界写成完成实现。

- [ ] **Step 3: 收集 batch 7 上游证据**

```bash
rg -n -i 'hook|install|update|proxy|certificate|telemetry|web.search|web.fetch|debug|settings|feature' /tmp/flash-design-audit-llms.txt > /tmp/flash-design-audit-batch-7-doc-index.txt || true
strings /opt/homebrew/bin/claude | rg -n -i -C 2 'PreToolUse|PostToolUse|SessionStart|PreCompact|native.installer|auto.updater|proxy|certificate|telemetry|WebSearch|WebFetch|DEBUG_LOGS' > /tmp/flash-design-audit-batch-7-strings.txt || true
```

读取 `https://code.claude.com/docs/en/hooks-guide.md`、`https://code.claude.com/docs/en/hooks.md`、`https://code.claude.com/docs/en/settings-reference.md`、`https://code.claude.com/docs/en/debug-your-config.md` 及索引命中的安装、网络、WebSearch/WebFetch 页面。

- [ ] **Step 4: 写 batch-7 报告并独立复核**

14 个三级小节全部完成，测试/live 结论逐条标边界。settings live-validation 等争议只在实际运行聚焦命令后更新结果；不得复制旧 RELEASE 成功描述。复核 P0/P1 与上游偏离，更新 README 对应 14 行。

- [ ] **Step 5: 运行门禁、文档检查并提交用户审阅**

```bash
bun - <<'TS'
const ids = ['build-feature-profile','data-structures','diagnostics','experimental-features','external-stubs','hooks-system','magic-docs','messaging-primitives','native-installer','network-security','runtime-lifecycle','telemetry','test-validation','web-tools']
const report = await Bun.file('docs/status/design-docs-completeness-audit/batch-7.md').text()
const required = ['## 基线与范围','## 子系统审查','## 发现登记','## 证据边界','## 完成判定']
const missing = [...ids.filter(id => !report.includes(`### ${id}\n`)), ...required.filter(h => !report.includes(h))]
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
console.log('PASS: batch 7 has 14 subsystem sections')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: PASS、0 errors、无 whitespace 错误。请用户审阅 batch-7。

- [ ] **Step 6: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/batch-7.md
git commit -m "Audit build and runtime design specs" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 完成 Context、Memory 与共享契约横向复审

**Files:**
- Create: `docs/status/design-docs-completeness-audit/cross-subsystem.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Consumes: `docs/status/design-docs-completeness-audit/batch-0.md` 至 `batch-7.md`

**Interfaces:**
- Produces: `X-context-*`、`X-memory-*`、`X-state-*`、`X-recovery-*`、`X-boundary-*` 发现及完整矩阵。
- Produces: 总报告整改顺序所需的跨域主责和依赖关系。

- [ ] **Step 1: 运行横向报告门禁并确认 RED**

```bash
bun -e 'const file = "docs/status/design-docs-completeness-audit/cross-subsystem.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: cross-subsystem report missing"); process.exit(1); }'
```

Expected: 退出码 1。

- [ ] **Step 2: 建立 Context 端到端证据矩阵**

沿以下实际顺序回读 batch 证据和主责源码：

```text
system prompt/tools/attachments/CLAUDE.md/memory
  → token count/effective window
  → microcompact/snip/context collapse/autocompact
  → model request/cache edits/stream/PTL
  → reactive compact/staged recovery
  → compact boundary/post-compact attachments/hooks
  → QueryEngine mutable messages
  → UI transcript/SDK messages/session JSONL
  → restore/fork/replay
```

矩阵至少包含：每一步输入输出、状态所有者、工具配对、UUID/parentUuid、缓存、持久化、失败和 disabled 分支。每格标 `confirmed/gap/conflict/unconfirmed/N/A（理由）` 并链接证据。重点复核 snip marker、staged collapse、reset-during-persistence、session-memory compact 和 post-compact 记忆重建。

- [ ] **Step 3: 建立 Memory 端到端证据矩阵**

沿以下顺序回读证据：

```text
auto/team/session/CLAUDE.md/daily log
  → index load/truncation/on-demand retrieval
  → main-agent write/extractMemories/Session Memory
  → autoDream/team sync/cache invalidation
  → compaction and post-compact reinjection
  → restart/resume/cursor recovery
```

矩阵必须覆盖删除、失效、重复注入、旧 cursor、并发写、锁回滚、secret、symlink、权限与实际写入。任何“memory spec 未提及”都要先查相关 query/settings/session 主责，确认是真正缺失还是由相邻 spec 拥有。

- [ ] **Step 4: 完成其余共享契约矩阵**

逐项对账：模块级状态与多会话/fork；后台任务取消和重复清理；消息、附件、任务、权限、设置、压缩元数据和记忆的恢复组合；源码存在/build enabled/stub/protocol/live 五类状态；CLI/SDK/daemon/remote 对同一核心能力的副作用。

- [ ] **Step 5: 登记跨域发现并独立复核**

跨域发现使用真实领域和两位序号，例如 `X-context-01`、`X-memory-01`，字段与批次发现表一致。每条指定唯一主责 spec、关联 batch 发现和整改依赖；重复问题合并，不重复计数。使用通用反驳式提示词复核所有 P0/P1 和上游偏离。

- [ ] **Step 6: 运行横向门禁、文档检查并提交用户审阅**

```bash
bun - <<'TS'
const report = await Bun.file('docs/status/design-docs-completeness-audit/cross-subsystem.md').text()
const sections = ['## Context 全生命周期','## Memory 全生命周期','## 共享状态与并发','## 持久化与恢复','## 构建与功能边界','## 跨域发现登记','## 完成判定']
const missing = sections.filter(h => !report.includes(h))
if (missing.length) { console.error('FAIL', missing); process.exit(1) }
if (/\|\s*\|/.test(report)) { console.error('FAIL: empty matrix cell'); process.exit(1) }
const statuses = ['confirmed','gap','conflict','unconfirmed','N/A（']
for (const section of sections.slice(0, 5)) {
  const start = report.indexOf(section)
  const remaining = report.slice(start + section.length)
  const nextHeading = remaining.indexOf('\n## ')
  const body = nextHeading < 0 ? remaining : remaining.slice(0, nextHeading)
  if (!statuses.some(status => body.includes(status))) {
    console.error(`FAIL: ${section} has no explicit matrix status`)
    process.exit(1)
  }
}
console.log('PASS: cross-subsystem sections have statuses and no empty cells')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: PASS、0 errors、无 whitespace 错误。请用户审阅 context/memory 两张完整矩阵和所有跨域发现。

- [ ] **Step 7: Commit**

```bash
git add docs/status/design-docs-completeness-audit/README.md docs/status/design-docs-completeness-audit/cross-subsystem.md
git commit -m "Audit cross-subsystem design contracts" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 汇总整改批次并完成全量验证

**Files:**
- Modify: `docs/status/design-docs-completeness-audit/README.md`
- Verify: `docs/status/design-docs-completeness-audit/batch-0.md` 至 `batch-7.md`
- Verify: `docs/status/design-docs-completeness-audit/cross-subsystem.md`

**Interfaces:**
- Consumes: 所有批次和横向审查结论。
- Produces: 最终分类统计、整改批次、未验证边界、完成/阻塞判定和用户审阅入口。

- [ ] **Step 1: 运行全量报告门禁并确认当前缺口**

```bash
bun - <<'TS'
import { parse } from 'yaml'
const manifest = parse(await Bun.file('docs/architecture/coverage/manifest.yaml').text())
const summary = await Bun.file('docs/status/design-docs-completeness-audit/README.md').text()
const missingRows = manifest.specs.filter(entry => !summary.includes(`| ${entry.id} | ${entry.batch} |`))
const openRows = manifest.specs.filter(entry => {
  const line = summary.split('\n').find(row => row.startsWith(`| ${entry.id} |`))
  return !line || line.includes('| open |')
})
console.log(JSON.stringify({ registered: manifest.specs.length, missing: missingRows.map(x => x.id), open: openRows.map(x => x.id) }, null, 2))
if (missingRows.length || openRows.length) process.exit(1)
TS
```

Expected: 若前序任务全部完成则 PASS；任何缺失或 open 都退出 1，必须回到对应批次完成，不能在本任务直接改状态掩盖。

- [ ] **Step 2: 校验所有发现 ID、主责和引用**

Run:

```bash
rg -n '^\| (B[0-7]|X)-' docs/status/design-docs-completeness-audit/*.md > /tmp/flash-design-audit-findings.txt
bun - <<'TS'
const files = Array.from(new Bun.Glob('docs/status/design-docs-completeness-audit/*.md').scanSync('.'))
const rows = []
for (const file of files) {
  const text = await Bun.file(file).text()
  for (const line of text.split('\n')) {
    const match = line.match(/^\| ((?:B[0-7]|X)-[^|]+)\|/)
    if (match) rows.push({ file, id: match[1].trim(), line })
  }
}
const duplicates = rows.filter((row, index) => rows.findIndex(other => other.id === row.id) !== index)
if (duplicates.length) { console.error('Duplicate finding IDs', duplicates); process.exit(1) }
for (const row of rows) {
  const cells = row.line.split('|').slice(1, -1).map(cell => cell.trim())
  if (cells.length !== 14) { console.error('Expected 14 finding columns', row); process.exit(1) }
  if (!row.line.includes('`')) { console.error('Finding lacks inline evidence', row); process.exit(1) }
}
console.log(`PASS: ${rows.length} unique findings with 14 columns`)
TS
```

Expected: 无重复 ID，每条发现 14 列且有行内证据。无发现时输出 `PASS: 0 unique findings with 14 columns`，但仍须人工证明不是漏审。

- [ ] **Step 3: 写最终分类统计和整改批次**

README 按“文档缺口 / 已证实实现问题 / 上游偏离 / 验证缺口 / 可选改进”分别统计，并列出 P0–P3。整改顺序必须满足：

1. 已证实 P0/P1 和事实错误优先，文档修复与产品修复分开。
2. 跨域问题只有主责一个主任务，关联 spec 只修改自己的调用边界。
3. 证据不足先补证据；私有 live 不可用时保留阻塞，不生成虚假整改结论。
4. 每项给主责 spec、来源发现 ID、依赖和可观察验收条件。
5. 报告批准不自动改变子系统 spec 状态。

- [ ] **Step 4: 检查报告链接、文档结构与 whitespace**

Run:

```bash
bun - <<'TS'
import { resolve, dirname } from 'path'
const files = Array.from(new Bun.Glob('docs/status/design-docs-completeness-audit/*.md').scanSync('.'))
const broken = []
for (const file of files) {
  const text = await Bun.file(file).text()
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (!target || /^(https?:|mailto:)/.test(target)) continue
    if (!(await Bun.file(resolve(dirname(file), decodeURIComponent(target))).exists())) broken.push({ file, target })
  }
}
if (broken.length) { console.error('Broken local links', broken); process.exit(1) }
console.log('PASS: audit report local links resolve')
TS
bun scripts/check-design-docs.ts
git diff --check
```

Expected: 链接 PASS；结构检查 0 errors；无 whitespace 错误。

- [ ] **Step 5: 运行全量测试、类型和构建验证**

Run separately and record each exit code in README:

```bash
bun run test
bun run typecheck
bun run build
```

Expected: 三个命令均退出 0；测试以总退出码和无 `Failed test files` 为准，不能只引用最后一个文件的 pass 数。若沙箱中 `tests/openBackends.test.ts` 因进程组 kill 出现 EPERM，在允许该操作的环境重跑；仍失败则本任务不完成，README 记录真实失败。

- [ ] **Step 6: 最终独立完整性复核**

派遣未参与此前审查的只读复核者，提示词：

```text
请独立审查 docs/status/design-docs-completeness-audit/ 的全部报告。以 docs/architecture/coverage/manifest.yaml 和 docs/superpowers/specs/2026-11-16-design-docs-completeness-audit-design.md 为基准，检查：68 个 spec 是否全部覆盖；每个 coverage group 是否有语义审查；context/memory 矩阵是否闭合；P0/P1 是否有直接证据；open/blocked/unconfirmed 是否被隐藏；统计是否与发现表一致。不要修改文件。输出具体漏项、矛盾、误报及对应文件/发现 ID；若某项无法证明，明确说无法证明，不要给出“全面”的笼统背书。
```

将所有实质问题写回对应报告并重新运行 Step 1–5；无法解决的项保留 open/blocked，最终状态不得写成完成。

- [ ] **Step 7: 提交用户进行最终审阅**

向用户提供 README、8 份 batch 报告和 cross-subsystem 报告路径，分别说明：已完成范围、发现分类、live 未验证边界、建议整改顺序。只有用户确认总报告后，才允许另开 brainstorming/spec/plan 进行文档或产品整改。

- [ ] **Step 8: Commit**

```bash
git add docs/status/design-docs-completeness-audit
git commit -m "Complete comprehensive design docs audit" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```
