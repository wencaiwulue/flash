# 全量配置对齐 B0：基线、矩阵与 Hook 局部容错实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 固定上游 stable 2.1.311 的可审计证据，生成全量 settings/hooks/env 清单和兼容矩阵，建立离线漂移门禁，并修复普通文件来源中三类 hook 局部错误导致整文件失效的问题。

**Architecture:** 采集期脚本把实时 Markdown 和二进制元数据固化为 JSON inventory/evidence；检查期脚本把 inventory、人工 compatibility YAML、现有 Settings JSON Schema 与 `HOOK_EVENTS` 对比。运行时只在现有权限预过滤之后增加 hook 预过滤，普通 schema 校验、缓存与合并顺序不变；managed 文件显式禁用新增容错。

**Tech Stack:** Bun、TypeScript、Zod v4 JSON Schema、YAML、`bun:test`、React/Ink。

**依据：** `docs/superpowers/specs/2026-11-16-upstream-config-b0-baseline-design.md`（approved）及总路线 `2026-11-16-upstream-configuration-alignment-design.md`。

## Global Constraints

- B0 不实现 6 个新事件的运行时协议，不把 schema/矩阵登记标成 runtime aligned；这些属于 B1。
- 不执行或提交真实用户 HOME、凭据、OAuth token、上游二进制和完整文档；probe 只使用隔离临时目录。
- 文档是 2026-11-16 实时快照。Requires 版本高于 2.1.311 的项必须 `afterBaseline:true`、runtime blocked。
- 不实现通用字段容错；已知 hook 数组内部、普通字段、managed/MDM/remote/inline 行为保持原样。
- 不用 `npm view claude-code`；包名是 `@anthropic-ai/claude-code`。
- 测试以退出码判断，不能只看 tail；不修改无关未跟踪文件。
- 每个提交信息以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。
- 当前分支已有其他工作；实施前按 executing-plans/subagent-driven-development 要求确认隔离工作区，不覆盖现有修改。

## File Structure

- Create: `scripts/upstreamConfigInventory.ts` — Markdown 解析、证据与 inventory CLI。
- Create: `scripts/checkUpstreamConfigCompatibility.ts` — matrix 初始化、schema 遍历、差异检查 CLI。
- Create: `fixtures/upstream-config/2.1.311/{evidence.json,inventory.json,compatibility.yaml}`。
- Create: `fixtures/upstream-config/2.1.311/probes/{hooks-doctor.txt,hooks-results.json}`。
- Create: `tests/upstreamConfigInventory.test.ts`、`tests/upstreamConfigCompatibility.test.ts`。
- Create: `tests/settingsHookCompatibility.test.ts`、`tests/settingsManagedHookCompatibility.test.ts`、`tests/invalidSettingsDialog.test.tsx`。
- Modify: `src/utils/settings/validation.ts` — severity 与 hook 局部过滤。
- Modify: `src/utils/settings/settings.ts` — 普通过滤接线、managed opt-out。
- Modify: `src/components/InvalidSettingsDialog.tsx` — warning/error 展示。
- Modify: `docs/architecture/{INDEX.md,coverage/manifest.yaml}`；Create `coverage/upstream-config-b0-baseline.yaml`。

---

### Task 1: 固定证据并生成完整 inventory（TDD）

**Files:**
- Create: `scripts/upstreamConfigInventory.ts`
- Create: `tests/upstreamConfigInventory.test.ts`
- Create: `fixtures/upstream-config/2.1.311/**`

**Interfaces:**
- `parseSettingsReference(markdown, source): UpstreamEntry[]`
- `parseHooksReference(markdown, source): UpstreamEntry[]`
- `parseEnvironmentReference(markdown, source): UpstreamEntry[]`
- `buildInventory(input): UpstreamInventory`
- CLI 只读显式文档和二进制，输出 evidence.json 与 inventory.json，不访问 HOME。

- [ ] **Step 1: 写解析与真实快照失败测试**

创建 `tests/upstreamConfigInventory.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  buildInventory,
  parseEnvironmentReference,
  parseHooksReference,
  parseSettingsReference,
  type UpstreamSource,
} from '../scripts/upstreamConfigInventory.ts'

const source: UpstreamSource = {
  url: 'https://code.claude.com/docs/en/settings-reference',
  sha256: 'a'.repeat(64),
}

const settingsFixture = `
| Setting | Description | Category | Scope |
| :- | :- | :- | :- |
| [\`model\`](#model) | Set the model | Model | Any file |
| [\`oldKey\`](#oldkey) | Deprecated; use \`newKey\` instead | Other | Any file |
| [\`futureKey\`](#futurekey) | Future setting | Other | Any file |
### \`model\`
Set the model.
* **Scope**: [\`Any file\`](#scopes)
* **Type**: string, a model alias or full model ID
* **Default**: unset
* **Per-session overrides**: --model takes precedence over this key
### \`oldKey\`
Deprecated.
* **Type**: Boolean
* **Default**: \`true\`
### \`futureKey\`
Requires Claude Code v2.1.319 or later.
* **Type**: object
* **Default**: unset
`

describe('upstream config inventory', () => {
  test('parses paths, metadata, lifecycle, replacement and after-baseline versions', () => {
    const entries = parseSettingsReference(settingsFixture, source)
    expect(entries.map(entry => entry.id)).toEqual([
      'setting:model', 'setting:oldKey', 'setting:futureKey',
    ])
    expect(entries[0]).toMatchObject({
      path: 'model', types: ['string'], defaultDocumented: true,
      lifecycle: 'active', scopes: ['Any file'],
      precedenceDocumented: true, precedence: '--model takes precedence over this key',
    })
    expect(entries[1]).toMatchObject({
      lifecycle: 'deprecated', replacement: 'newKey', default: true,
    })
    expect(entries[2]).toMatchObject({
      introduced: '2.1.319', afterBaseline: true,
    })
  })

  test('parses hooks only from the event summary table', () => {
    const markdown = `
| Event | When it fires |
| :- | :- |
| \`SessionStart\` | When a session begins |
| \`PostToolBatch\` | After a parallel batch |
### \`SessionStart\`
Details must not create a duplicate.
`
    const entries = parseHooksReference(markdown, source)
    expect(entries.map(entry => entry.id)).toEqual([
      'hook:SessionStart', 'hook:PostToolBatch',
    ])
  })

  test('parses env table and retains deprecated variables', () => {
    const markdown = `
| Variable | Purpose |
| :- | :- |
| \`API_TIMEOUT_MS\` | Header timeout |
| \`ANTHROPIC_SMALL_FAST_MODEL\` | \\[DEPRECATED] Old model variable |
`
    const entries = parseEnvironmentReference(markdown, source)
    expect(entries.map(entry => entry.id)).toEqual([
      'env:API_TIMEOUT_MS', 'env:ANTHROPIC_SMALL_FAST_MODEL',
    ])
    expect(entries[1]?.lifecycle).toBe('deprecated')
  })

  test('rejects duplicate IDs and sorts by kind then id', () => {
    const settings = parseSettingsReference(settingsFixture, source)
    expect(() => buildInventory({
      entries: [...settings, ...settings],
      documents: {}, capturedAt: '2026-11-16T00:00:00.000Z',
      binary: { version: '2.1.311', commit: 'e7d3b8365a0f', platform: 'darwin-arm64', sha256: 'b'.repeat(64) },
    })).toThrow('duplicate inventory id')
  })

  test('real 2.1.311 snapshot is complete and self-consistent', async () => {
    const root = new URL('../fixtures/upstream-config/2.1.311/', import.meta.url)
    const inventory = JSON.parse(await readFile(new URL('inventory.json', root), 'utf8'))
    const evidence = JSON.parse(await readFile(new URL('evidence.json', root), 'utf8'))
    expect(inventory.baseline.version).toBe('2.1.311')
    expect(evidence.binary.version).toContain('2.1.311')
    expect(inventory.entries.filter((entry: { kind: string }) => entry.kind === 'hook')).toHaveLength(33)
    expect(inventory.entries.some((entry: { id: string }) => entry.id === 'setting:permissions.denyInsteadOfPrompting' && entry.afterBaseline)).toBe(true)
    expect(inventory.entries.some((entry: { id: string }) => entry.id === 'setting:keybindingFlavor' && entry.lifecycle === 'deprecated')).toBe(true)
    expect(new Set(inventory.entries.map((entry: { id: string }) => entry.id)).size).toBe(inventory.entries.length)
  })
})
```

- [ ] **Step 2: 运行测试，确认模块不存在而失败**

Run: `bun test ./tests/upstreamConfigInventory.test.ts`

Expected: FAIL，无法 import `scripts/upstreamConfigInventory.ts`；此时尚不创建空 fixture 让 smoke 假通过。

- [ ] **Step 3: 实现解析器和采集 CLI**

创建 `scripts/upstreamConfigInventory.ts`，导出 spec 中的类型及以上函数。实现必须遵守以下确定规则：

1. settings 顶层索引行按 `[ \`path\` ](#anchor)`（去掉空格）识别；从对应 `### \`path\`` 到下一个同级/更高级标题提取 Scope/Type/Default。索引提供 scope/category 回退，详情提供类型与默认值。表格 splitting 只认未转义且不在反引号内的 `|`；目标表中的畸形行必须抛错，不能静默跳过。
2. 完整 Scope 行写入 `sourceRules`；详情节中 Per-session overrides 行及包含 precedence/override/merge/highest/outrank 的非代码段写入 `precedence`，有原文时 `precedenceDocumented:true`。env Purpose 中同类规则同样保留；hook 没有文档优先级时明确 false/空串。
3. Type 取第一个逗号或冒号前的主类型，并把 Boolean→boolean、String→string、Number→number、Object→object、Array→array；其余保留小写原文。Default 的反引号 `true/false/null`、有限数字转对应 JSON 值；unset 和描述性默认值保留 `default:null`，同时 `defaultDocumented:true`，原文进入 excerpt。
4. 描述以 Deprecated 开头设 deprecated，以 Removed 开头设 removed；env 的 `\[DEPRECATED]`/`[DEPRECATED]` 前缀也设 deprecated。`use \`replacement\`` 提取 replacement。Requires 正则 `/Requires Claude Code v(\d+\.\d+\.\d+)/`；按数字三段比较 2.1.311。
5. hooks 只解析 `| Event | When it fires |` 后的连续表行；env 只解析 `| Variable | Purpose |` 后的连续表行，避免把正文示例误登记。
6. `stripMarkdown()` 去除 link 的 URL 但保留文本、反引号和 HTML；`excerpt` 压成单行，最长 1000 字符。不得从配置示例采集任何值。
7. `buildInventory()` 深检查重复 ID，按 `setting`、`hook`、`env` 再按 id 排序；baseline.distTag 固定 `stable`，version 固定 `2.1.311`。
8. CLI 参数为 `--settings-reference --settings --hooks-reference --env-vars --llms --binary --binary-commit --binary-platform --captured-at --output-dir`。使用 `createHash('sha256')` 计算文档和二进制哈希；`spawnSync(binary, ['--version'], { encoding:'utf8' })` 只获取版本，不运行 doctor。
9. evidence.json 写 `schemaVersion:1`、`capturedAt`、五个文档的 URL/hash、`binary:{version,commit,platform,sha256}`、`probeDirectory` 不写本机路径。inventory.json 的 baseline 复用同一份数据。
10. 所有未知参数、缺失参数、重复 ID、空 entries、二进制版本不含 2.1.311 均非零退出。

- [ ] **Step 4: 运行真实采集并保存脱敏 probe**

Run（同一 shell 中执行，已有文档缺失时先用列出的官方 URL 重新 curl）：

```bash
CAPTURE_ROOT=$(mktemp -d /tmp/flash-b0-capture.XXXXXX) && \
cp /tmp/claude-settings-reference-2.1.311.md "$CAPTURE_ROOT/settings-reference.md" && \
cp /tmp/claude-settings-2.1.311.md "$CAPTURE_ROOT/settings.md" && \
cp /tmp/claude-hooks-reference-2.1.311.md "$CAPTURE_ROOT/hooks-reference.md" && \
cp /tmp/claude-env-vars-reference-2.1.311.md "$CAPTURE_ROOT/env-vars.md" && \
cp /tmp/claude-llms.txt "$CAPTURE_ROOT/llms.txt" && \
bun scripts/upstreamConfigInventory.ts \
  --settings-reference "$CAPTURE_ROOT/settings-reference.md" \
  --settings "$CAPTURE_ROOT/settings.md" \
  --hooks-reference "$CAPTURE_ROOT/hooks-reference.md" \
  --env-vars "$CAPTURE_ROOT/env-vars.md" \
  --llms "$CAPTURE_ROOT/llms.txt" \
  --binary /tmp/flash-upstream-2.1.311.hQPPEu/native/package/claude \
  --binary-commit e7d3b8365a0f \
  --binary-platform darwin-arm64 \
  --captured-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --output-dir fixtures/upstream-config/2.1.311
```

若临时文件已清理，下载 URL 依次为：
`https://code.claude.com/docs/en/settings-reference.md`、`settings.md`、`hooks-reference.md`、`env-vars.md`、`https://code.claude.com/docs/llms.txt`。不得用 latest 二进制替换固定的 2.1.311 证据；原二进制不可用时停止并重新按官方 native 安装渠道获取该精确版本。

创建 `probes/hooks-results.json`，只记录以下结构化结果，不复制隔离 `.claude.json`：

```json
{
  "schemaVersion": 1,
  "upstreamVersion": "2.1.311",
  "isolation": ["temporary HOME", "temporary CLAUDE_CONFIG_DIR", "temporary project"],
  "cases": [
    { "case": "unknown-event", "input": "FutureUpstreamEvent", "result": "warning-and-entry-ignored" },
    { "case": "event-not-array", "input": ["SessionStart:object", "PostToolUse:number"], "result": "warning-and-entry-ignored" },
    { "case": "hooks-not-object", "input": "hooks:string", "result": "warning-hooks-ignored-siblings-retained" },
    { "case": "ordinary-schema-error", "input": "model:number", "result": "Expected string, but received number" }
  ]
}
```

`probes/hooks-doctor.txt` 写规范化说明和 33 个事件（每行一个）：当前 `src/entrypoints/sdk/coreTypes.ts:25-53` 的 27 个，加 `UserPromptExpansion`、`PostToolBatch`、`MessageDisplay`、`DirectoryAdded`、`PreModelSwitch`、`PostModelSwitch`。首行注明“2.1.311 isolated doctor; normalized from observed valid-event list; no user config included”。

- [ ] **Step 5: 验证解析与确定性**

Run: `bun test ./tests/upstreamConfigInventory.test.ts`
Expected: PASS；hook 数恰好 33，settings/env 数量打印但不硬编码早期 `99+22`。

再次运行同一采集命令到临时输出目录并比较：

```bash
bun scripts/upstreamConfigInventory.ts --help
git diff --exit-code -- fixtures/upstream-config/2.1.311/inventory.json
```

Expected: `--help` 非零或零均可但必须只列用法；inventory 无非 capturedAt 引起的 diff。若比较包含 capturedAt，逐字段排除该字段后必须相同。

- [ ] **Step 6: 提交 Task 1**

```bash
git add scripts/upstreamConfigInventory.ts tests/upstreamConfigInventory.test.ts fixtures/upstream-config/2.1.311 docs/superpowers/specs/2026-11-16-upstream-config-b0-baseline-design.md docs/superpowers/plans/2026-11-16-upstream-config-b0-baseline.md docs/architecture/INDEX.md docs/architecture/coverage/manifest.yaml docs/architecture/coverage/upstream-config-b0-baseline.yaml docs/architecture/coverage/upstream-configuration-alignment.yaml docs/superpowers/specs/2026-11-16-upstream-configuration-alignment-design.md
git commit -m "$(cat <<'EOF'
Add upstream configuration B0 evidence and inventory

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 初始化 matrix 并建立离线差异门禁（TDD）

**Files:**
- Create: `scripts/checkUpstreamConfigCompatibility.ts`
- Create: `tests/upstreamConfigCompatibility.test.ts`
- Create: `fixtures/upstream-config/2.1.311/compatibility.yaml`

**Interfaces:**
- `collectSchemaPaths(schema: Record<string, unknown>): Set<string>`
- `createInitialMatrix(inventory, schemaPaths, hookEvents): CompatibilityMatrix`
- `checkCompatibility(input): Diagnostic[]`
- `CompatibilityInventory` 是结构类型：`baseline` 至少含 version，entries 至少含 id/kind/path/lifecycle，并允许 UpstreamEntry 其余可选字段；这样合成 fixture 与真实 inventory 都无需类型强转。
- `hookEvents` 参数类型为 `readonly string[]`，直接接受 `HOOK_EVENTS`。
- CLI 默认只读；只有显式 `--initialize-matrix` 可写 matrix。

- [ ] **Step 1: 写遍历、状态和真实基线失败测试**

创建 `tests/upstreamConfigCompatibility.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import {
  checkCompatibility,
  collectSchemaPaths,
  createInitialMatrix,
} from '../scripts/checkUpstreamConfigCompatibility.ts'

const syntheticSchema = {
  $defs: {
    sandbox: {
      anyOf: [
        { type: 'object', properties: { enabled: { type: 'boolean' } } },
        { type: 'null' },
      ],
    },
  },
  type: 'object',
  properties: {
    model: { type: 'string' },
    sandbox: { $ref: '#/$defs/sandbox' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
  },
}

const inventory = {
  baseline: { version: '2.1.311' },
  entries: [
    { id: 'setting:model', kind: 'setting', path: 'model', lifecycle: 'active' },
    { id: 'setting:sandbox.enabled', kind: 'setting', path: 'sandbox.enabled', lifecycle: 'active' },
    { id: 'setting:missingKey', kind: 'setting', path: 'missingKey', lifecycle: 'active' },
    { id: 'hook:Stop', kind: 'hook', path: 'Stop', lifecycle: 'active' },
    { id: 'hook:PostToolBatch', kind: 'hook', path: 'PostToolBatch', lifecycle: 'active' },
  ],
}

describe('upstream compatibility checker', () => {
  test('resolves local refs and unions without treating dynamic record keys as paths', () => {
    expect([...collectSchemaPaths(syntheticSchema)].sort()).toEqual([
      'env', 'model', 'sandbox', 'sandbox.enabled',
    ])
  })

  test('initializer records existing paths as partial and missing paths as missing', () => {
    const matrix = createInitialMatrix(inventory, collectSchemaPaths(syntheticSchema), ['Stop'])
    expect(matrix.entries.find(entry => entry.id === 'setting:model')).toMatchObject({
      status: 'partial', dimensions: { path: { status: 'aligned' } },
    })
    expect(matrix.entries.find(entry => entry.id === 'setting:missingKey')?.status).toBe('missing')
    expect(matrix.entries.find(entry => entry.id === 'hook:PostToolBatch')?.status).toBe('missing')
    expect(matrix.schemaExclusions.map(entry => entry.path)).toEqual(['env', 'sandbox'])
  })

  test('recorded missing work is non-fatal but false aligned evidence is fatal', () => {
    const matrix = createInitialMatrix(inventory, collectSchemaPaths(syntheticSchema), ['Stop'])
    expect(checkCompatibility({ inventory, matrix, schemaPaths: collectSchemaPaths(syntheticSchema), hookEvents: ['Stop'] })).toEqual([])
    const missing = matrix.entries.find(entry => entry.id === 'setting:missingKey')!
    missing.status = 'aligned'
    missing.dimensions.path = { status: 'aligned', evidence: 'false-claim' }
    const diagnostics = checkCompatibility({ inventory, matrix, schemaPaths: collectSchemaPaths(syntheticSchema), hookEvents: ['Stop'] })
    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain('missing-in-flash')
    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain('invalid-aligned-evidence')
  })

  test('rejects missing/stale entries and unrecorded schema keys', () => {
    const matrix = createInitialMatrix(inventory, collectSchemaPaths(syntheticSchema), ['Stop'])
    matrix.entries = matrix.entries.filter(entry => entry.id !== 'setting:model')
    matrix.entries.push({ ...matrix.entries[0]!, id: 'setting:stale' })
    matrix.schemaExclusions = []
    const codes = checkCompatibility({ inventory, matrix, schemaPaths: collectSchemaPaths(syntheticSchema), hookEvents: ['Stop'] }).map(diagnostic => diagnostic.code)
    expect(codes).toContain('missing-matrix-entry')
    expect(codes).toContain('stale-matrix-entry')
    expect(codes).toContain('undocumented-schema-key')
  })

  test('real 2.1.311 baseline has no unrecorded drift', async () => {
    const root = new URL('../fixtures/upstream-config/2.1.311/', import.meta.url)
    const realInventory = JSON.parse(await readFile(new URL('inventory.json', root), 'utf8'))
    const matrix = parse(await readFile(new URL('compatibility.yaml', root), 'utf8'))
    const { generateSettingsJSONSchema } = await import('../src/utils/settings/schemaOutput.ts')
    const { HOOK_EVENTS } = await import('../src/entrypoints/sdk/coreTypes.ts')
    const diagnostics = checkCompatibility({
      inventory: realInventory, matrix,
      schemaPaths: collectSchemaPaths(JSON.parse(generateSettingsJSONSchema())),
      hookEvents: HOOK_EVENTS,
    })
    expect(diagnostics).toEqual([])
    expect(realInventory.entries.filter((entry: { kind: string }) => entry.kind === 'hook')).toHaveLength(33)
    for (const id of ['UserPromptExpansion', 'PostToolBatch', 'MessageDisplay', 'DirectoryAdded', 'PreModelSwitch', 'PostModelSwitch']) {
      const entry = matrix.entries.find((candidate: { id: string }) => candidate.id === `hook:${id}`)
      expect(entry.dimensions.runtime.status).not.toBe('aligned')
    }
  })
})
```

- [ ] **Step 2: 确认失败**

Run: `bun test ./tests/upstreamConfigCompatibility.test.ts`
Expected: FAIL，checker 模块不存在。

- [ ] **Step 3: 实现 checker 与显式初始化器**

实现要求：

1. `resolveRef()` 只接受本地 `#/` 引用，按 `/` 遍历并解码 `~0/~1`；外部引用抛错。遍历 `properties` 时登记父路径，再递归对象子 schema；同时遍历 `anyOf/oneOf/allOf`。用当前递归分支的 `refStack` 防环：进入 ref 前若已在 stack 中则不再展开，退出该分支后删除；同一 def 在不同兄弟路径仍可遍历。动态 `additionalProperties` 不展开。
2. `createInitialMatrix()` 为每个 inventory entry 创建六维状态，默认全 missing、`implementation:[]`、`tests:[]`、`evidence:[]`、`exclusion:null`。schema/hook 已存在时总状态 partial、path aligned，evidence 填 `generated schema diff` 或 `HOOK_EVENTS`。
3. active 缺失项为 missing；afterBaseline 总状态为 blocked，且 `dimensions.runtime` 也为 blocked、evidence 指向 Requires 原文；deprecated/removed 缺失项为 excluded，exclusion 记录 upstream lifecycle、replacement 和来源 anchor。已有 deprecated schema 路径仍可 partial，不能自动删配置。
4. schema 独有路径在显式初始化时逐条写入 `schemaExclusions`，不用 `*`；reason 为 `flash-only or legacy schema path; review ownership in B2-B5`，evidence 为 `src/utils/settings/types.ts`。后续普通检查绝不自动增加排除。
5. matrix entry 数与 inventory ID 必须完全一致。`aligned` 要求 implementation/tests 非空、六维全 aligned 且每维 evidence 非空。`different` 要求 notes 和 evidence；`excluded` 要求 exclusion.reason/evidence。
6. 已记录 missing/partial/different/blocked/excluded 的缺失路径只打印统计；若 path aligned 但总状态不是 aligned，不报错；若 path aligned 而实际路径不存在，报 `missing-in-flash`。总状态 aligned 但任何维度不合格报 `invalid-aligned-evidence`。
7. 额外诊断：`missing-matrix-entry`、`stale-matrix-entry`、`undocumented-schema-key`、`invalid-matrix-status`、`invalid-after-baseline`。afterBaseline 的 runtime aligned 必须失败。
8. 默认加载真实 fixture 和 `generateSettingsJSONSchema()`，输出每种 kind 的 total/aligned/partial/missing/different/blocked/excluded 数量及 diagnostics。诊断非空 `process.exitCode=1`。`--initialize-matrix` 只允许 matrix 不存在时创建，存在时拒绝覆盖，防止抹掉人工证据。

- [ ] **Step 4: 生成真实 matrix 并审查排除项**

Run: `bun scripts/checkUpstreamConfigCompatibility.ts --initialize-matrix`

随后检查：

```bash
bun scripts/checkUpstreamConfigCompatibility.ts
bun test ./tests/upstreamConfigCompatibility.test.ts
```

Expected: PASS，退出码 0；输出会显示大量 missing/partial，这不是全量对齐完成。逐条查看 `schemaExclusions`，确认都是 schema 确实声明但 upstream inventory 未列出的精确路径；若解析器漏了真实上游路径，应修 Task 1 解析器，而不是加 exclusion。

- [ ] **Step 5: 提交 Task 2**

```bash
git add scripts/checkUpstreamConfigCompatibility.ts tests/upstreamConfigCompatibility.test.ts fixtures/upstream-config/2.1.311/compatibility.yaml
git commit -m "$(cat <<'EOF'
Add upstream configuration compatibility gate

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 普通文件来源的 Hook 局部清洗（TDD）

**Files:**
- Modify: `src/utils/settings/validation.ts`
- Modify: `src/utils/settings/settings.ts`
- Create: `tests/settingsHookCompatibility.test.ts`
- Create: `tests/settingsManagedHookCompatibility.test.ts`

**Interfaces:**
- `filterInvalidHookSettings(data: unknown, filePath: string): ValidationError[]`
- `parseSettingsFile(path, options?: { allowHookEntryRecovery?: boolean })`
- `ValidationError.severity?: 'error' | 'warning'`

- [ ] **Step 1: 写普通来源失败测试**

创建 `tests/settingsHookCompatibility.test.ts`。使用 `mkdtemp(join(tmpdir(),'flash-hook-settings-'))`、`writeFile()`、`resetSettingsCache()`，每个 afterEach 清缓存和临时目录。核心测试如下（`read()` 每次写入唯一文件并调用 parser）：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSettingsFile } from '../src/utils/settings/settings.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'

let dir = ''
let counter = 0
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flash-hook-settings-'))
  resetSettingsCache()
})
afterEach(async () => {
  resetSettingsCache()
  await rm(dir, { recursive: true, force: true })
})
async function read(value: unknown, options?: { allowHookEntryRecovery?: boolean }) {
  const path = join(dir, `settings-${counter++}.json`)
  await writeFile(path, JSON.stringify(value))
  return parseSettingsFile(path, options)
}
const validHook = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'printf ok' }] }]

describe('ordinary settings hook recovery', () => {
  test.each([
    { name: 'unknown event', hooks: { FutureUpstreamEvent: [], PreToolUse: validHook }, expectedPreToolUse: validHook },
    { name: 'event object', hooks: { SessionStart: {}, PreToolUse: validHook }, expectedPreToolUse: validHook },
    { name: 'event number', hooks: { PostToolUse: 42, PreToolUse: validHook }, expectedPreToolUse: validHook },
    { name: 'hooks string', hooks: 'invalid', expectedPreToolUse: undefined },
    { name: 'hooks null', hooks: null, expectedPreToolUse: undefined },
    { name: 'hooks array', hooks: [], expectedPreToolUse: undefined },
  ])('$name preserves valid siblings and warns', async ({ hooks, expectedPreToolUse }) => {
    const result = await read({ hooks, model: 'sonnet' })
    expect(result.settings?.model).toBe('sonnet')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ severity: 'warning' })
    expect(result.errors[0]?.path).toMatch(/^hooks/)
    expect(result.settings?.hooks?.PreToolUse ?? undefined).toEqual(expectedPreToolUse)
  })

  test('known event array contents still use ordinary schema errors', async () => {
    const result = await read({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 42 }] } })
    expect(result.settings).toBeNull()
    expect(result.errors.some(error => error.severity === 'error')).toBe(true)
  })

  test('ordinary field errors still reject the whole source', async () => {
    const result = await read({ model: 42, hooks: { FutureUpstreamEvent: [] } })
    expect(result.settings).toBeNull()
    expect(result.errors.some(error => error.path === 'model' && error.severity === 'error')).toBe(true)
  })

  test('managed opt-out preserves current whole-source rejection', async () => {
    const result = await read({ model: 'sonnet', hooks: { FutureUpstreamEvent: [] } }, { allowHookEntryRecovery: false })
    expect(result.settings).toBeNull()
    expect(result.errors.some(error => error.severity === 'error')).toBe(true)
  })

  test('cache returns the same warning until reset', async () => {
    const path = join(dir, 'cached.json')
    await writeFile(path, JSON.stringify({ hooks: { FutureUpstreamEvent: [] }, model: 'sonnet' }))
    const first = parseSettingsFile(path)
    const second = parseSettingsFile(path)
    expect(second).toEqual(first)
    resetSettingsCache()
    expect(parseSettingsFile(path)).toEqual(first)
  })
})
```

- [ ] **Step 2: 写 managed base/drop-in 集成失败测试**

创建独立 `tests/settingsManagedHookCompatibility.test.ts`，避免 module mock 污染其他测试：

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let loadManagedFileSettings: typeof import('../src/utils/settings/settings.ts').loadManagedFileSettings
let resetSettingsCache: typeof import('../src/utils/settings/settingsCache.ts').resetSettingsCache

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flash-managed-hooks-'))
  mock.module('../src/utils/settings/managedPath.ts', () => ({
    getManagedFilePath: () => dir,
    getManagedSettingsDropInDir: () => join(dir, 'managed-settings.d'),
  }))
  ;({ loadManagedFileSettings } = await import('../src/utils/settings/settings.ts'))
  ;({ resetSettingsCache } = await import('../src/utils/settings/settingsCache.ts'))
  resetSettingsCache()
})
afterEach(async () => {
  resetSettingsCache()
  mock.restore()
  await rm(dir, { recursive: true, force: true })
})

describe('managed hook validation remains unchanged', () => {
  test('managed base rejects an unknown event', async () => {
    await writeFile(join(dir, 'managed-settings.json'), JSON.stringify({ model: 'sonnet', hooks: { FutureUpstreamEvent: [] } }))
    expect(loadManagedFileSettings().settings).toBeNull()
  })

  test('managed drop-in rejects an unknown event without discarding a valid base', async () => {
    await writeFile(join(dir, 'managed-settings.json'), JSON.stringify({ model: 'sonnet' }))
    await mkdir(join(dir, 'managed-settings.d'))
    await writeFile(join(dir, 'managed-settings.d', '10-hooks.json'), JSON.stringify({ hooks: { FutureUpstreamEvent: [] } }))
    const result = loadManagedFileSettings()
    expect(result.settings).toEqual({ model: 'sonnet' })
    expect(result.errors.some(error => error.severity === 'error')).toBe(true)
  })
})
```

若 mock  hoist 导致路径未生效，沿用仓库现有 `mock.module` 相对 specifier 形式调整；不得写 `/Library` 或真实 managed 目录。

- [ ] **Step 3: 运行确认失败**

Run: `bun test ./tests/settingsHookCompatibility.test.ts ./tests/settingsManagedHookCompatibility.test.ts`
Expected: FAIL；当前 parseSettingsFile 只接受一个参数，未知 event 令普通文件 settings=null，severity 尚不存在。

- [ ] **Step 4: 实现局部过滤和来源边界**

在 `validation.ts`：

1. `ValidationError` 增加 `severity?: 'error' | 'warning'`；`formatZodError()` 每项显式 `severity:'error'`。
2. 既有 `filterInvalidPermissionRules()` 的 entry warning 显式 `severity:'warning'`。
3. 从 `src/entrypoints/sdk/coreTypes.js` import `HOOK_EVENTS`，建立 `Set<string>`。
4. 按 spec 第 5.1 节实现 `filterInvalidHookSettings()`。unknown message 使用 `Unknown hook event "${event}" was ignored. Valid events: ${HOOK_EVENTS.join(', ')}`；非对象 hooks message 使用 `"hooks" must be an object mapping event names to matcher arrays; received ${type}. This field was ignored`；非数组 message 使用 `Hook event "${event}" must be an array of matchers; received ${type}. This entry was ignored`。均 `severity:'warning'`、`docLink:'https://code.claude.com/docs/en/hooks'`。invalidValue 只放类型或 event 名，不放 hook command/object 正文。
5. 只 delete 目标字段/entry，不递归 sanitizer，不 clone/改写其他设置，不写文件。

在 `settings.ts`：

1. 两个 parse 返回类型共用内部 `ParseSettingsOptions = { allowHookEntryRecovery?: boolean }`；`settingsCache.ts` 的 `ParsedSettings` 增加 `allowHookEntryRecovery:boolean`。cache key 仍为 path，但 managed 与普通同 path 的选项差异必须处理：写入 `options.allowHookEntryRecovery !== false` 的归一化布尔值，命中前严格比较，不一致视为 miss。返回调用方时只暴露原有 settings/errors，不新增第二套不同步 cache。
2. `parseSettingsFileUncached()` 在权限过滤后、`safeParse()` 前，仅当 `options.allowHookEntryRecovery !== false` 时执行 hook filter；返回 `[...ruleWarnings, ...hookWarnings, ...schemaErrors]`。
3. cached/first return 都保留 errors；settings 仍按现有 clone。
4. `loadManagedFileSettings()` 对 base 和每个 drop-in 调用 `parseSettingsFile(path, { allowHookEntryRecovery:false })`；`getManagedFileSettingsPresence()` 读取 base 时也传 false。MDM、remote、inline 不改。
5. 不修改 `HOOK_EVENTS`，本任务新增事件只存在 inventory/matrix。

- [ ] **Step 5: 运行行为和类型测试**

Run: `bun test ./tests/settingsHookCompatibility.test.ts ./tests/settingsManagedHookCompatibility.test.ts`
Run: `bun run typecheck`
Expected: 全部 PASS。再运行 Task 2 真实 matrix 检查，确认没有把新事件标 aligned。

- [ ] **Step 6: 提交 Task 3**

```bash
git add src/utils/settings/validation.ts src/utils/settings/settings.ts src/utils/settings/settingsCache.ts tests/settingsHookCompatibility.test.ts tests/settingsManagedHookCompatibility.test.ts
git commit -m "$(cat <<'EOF'
Recover valid settings from local hook entry errors

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 区分 Settings Warning 与 Settings Error（TDD）

**Files:**
- Modify: `src/components/InvalidSettingsDialog.tsx`
- Create: `tests/invalidSettingsDialog.test.tsx`

- [ ] **Step 1: 写 Ink 展示失败测试**

创建 `tests/invalidSettingsDialog.test.tsx`，复用 `tests/snapshotUpdateDialog.test.tsx:19-85` 的 `streamPair`、createRoot、AppStateProvider、KeybindingSetup 和 afterEach 清理模式，mount：

```tsx
<InvalidSettingsDialog
  settingsErrors={errors}
  onContinue={onContinue}
  onExit={onExit}
/>
```

测试三组：

```ts
const warning = [{ file: 'settings.json', path: 'hooks.Future', message: 'Unknown hook event was ignored', severity: 'warning' as const }]
const error = [{ file: 'settings.json', path: 'model', message: 'Expected string, but received number', severity: 'error' as const }]
```

1. 只有 warning：输出包含 `Settings Warning`、`Invalid entries were skipped` 和 `valid settings remain active`；不包含 `Settings Error`、`Exit and fix manually`。
2. 只有 error：输出包含 `Settings Error`、`Files with errors are skipped entirely`、`Exit and fix manually`。
3. warning + error：按 error 展示，同时列表包含两个 path。
4. 只有 warning 时 stdin 写 `\r`，等待 40ms，只调用 onContinue，不调用 onExit；另一个 warning-only case 写 Escape（`\u001b`）也只能 Continue，不能退出。

- [ ] **Step 2: 确认失败**

Run: `bun test ./tests/invalidSettingsDialog.test.tsx`
Expected: FAIL；当前固定标题/说明为 Settings Error 且总有 Exit。

- [ ] **Step 3: 实现最小展示修改**

在 `InvalidSettingsDialog.tsx` 计算：

```ts
const hasErrors = settingsErrors.some(error => error.severity !== 'warning')
```

- title 为 `hasErrors ? 'Settings Error' : 'Settings Warning'`。
- warning-only 文案为 `Invalid entries were skipped; valid settings remain active.`；error/mixed 保留原文。
- warning-only options 只有 `{ label:'Continue', value:'continue' }`；error/mixed 保留现有两个选项。
- `Dialog` 的 `onCancel` 在 warning-only 时传 `onContinue`，error/mixed 时保留 `onExit`，避免 Escape 绕过“只提供 Continue”。
- 不改变 main.tsx 的启动时机、dialogLaunchers、ValidationErrorsList 数据结构，不让 warning 触发进程退出。

- [ ] **Step 4: 验证并提交**

Run: `bun test ./tests/invalidSettingsDialog.test.tsx ./tests/settingsHookCompatibility.test.ts ./tests/settingsManagedHookCompatibility.test.ts`
Expected: PASS。

```bash
git add src/components/InvalidSettingsDialog.tsx tests/invalidSettingsDialog.test.tsx
git commit -m "$(cat <<'EOF'
Distinguish recoverable settings warnings from errors

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 全量回归、矩阵审计与 B0 收尾

**Files:**
- Modify only if evidence requires: matrix statuses/notes、B0 spec、本计划 checkbox。
- 不新增 B1 运行时代码。

- [ ] **Step 1: 运行聚焦验证**

```bash
bun test ./tests/upstreamConfigInventory.test.ts
bun test ./tests/upstreamConfigCompatibility.test.ts
bun test ./tests/settingsHookCompatibility.test.ts
bun test ./tests/settingsManagedHookCompatibility.test.ts
bun test ./tests/invalidSettingsDialog.test.tsx
bun scripts/checkUpstreamConfigCompatibility.ts
bun scripts/check-design-docs.ts
```

Expected: 每条命令退出码 0；design docs 允许既有 draft warnings，不允许新增 error。若 `--require-approved` 用于本批两个 approved spec，执行 `bun scripts/check-design-docs.ts --require-approved` 时其他 draft 会按工具规则产生诊断，不把该可选命令作为全库门槛。

- [ ] **Step 2: 运行全量验证**

```bash
bun run test
bun run build
bun run typecheck
bun scripts/check-design-docs.ts
bun scripts/checkUpstreamConfigCompatibility.ts
```

Expected: 全部退出码 0。若失败，记录完整 failing file/error 并修复根因；不能用 tail 的文本表象或重跑偶然通过代替。

- [ ] **Step 3: 审计矩阵没有虚假完成声明**

用一个只读 Bun 脚本断言：

- inventory 的 hook 数量为 33，6 个 B1 新事件 runtime 都不是 aligned。
- 所有 afterBaseline 条目 runtime 为 blocked，不可能是 aligned。
- 所有 matrix aligned 条目六维 evidence、implementation、tests 完整（checker 已强制）。
- deprecated/removed 条目有 lifecycle 和 exclusion/replacement；没有把“不在文档”当 removed。
- 输出 settings/hooks/env 总数及各状态数，写入 B0 spec 的“实施结果”小节；数量以实际生成文件为准，不预先填写。
- `git diff --check` 无 whitespace error；`git status --short` 只包含本批预期文件和进入会话前已有的未跟踪文件。

- [ ] **Step 4: 更新设计登记并提交最终状态**

若实施澄清了接口或测试，不只改代码，需同步 B0 spec；保持 `status:approved`，coverage `groups:[]`，因为 settings/hooks-system 仍拥有运行时代码主归属。

```bash
git add docs/superpowers/specs/2026-11-16-upstream-config-b0-baseline-design.md docs/superpowers/plans/2026-11-16-upstream-config-b0-baseline.md docs/architecture/INDEX.md docs/architecture/coverage/manifest.yaml docs/architecture/coverage/upstream-config-b0-baseline.yaml fixtures/upstream-config/2.1.311/compatibility.yaml
git diff --cached --stat
git commit -m "$(cat <<'EOF'
Complete upstream configuration B0 baseline

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

若前面提交已包含全部代码且最后只有文档/matrix 变化，只 add 实际变化文件；没有变化时不创建空提交。

- [ ] **Step 5: 向用户报告并进入下一批决策**

报告必须包含：固定版本、实际 inventory/matrix 数量、六类状态统计、修改的解析行为、managed 不变边界、每条验证命令的退出码和 commit SHA。明确“B0 完成不等于全量配置对齐，6 个事件运行时属于 B1”。随后为 B1 新建具体 spec/plan，不直接在本计划追加实现。
