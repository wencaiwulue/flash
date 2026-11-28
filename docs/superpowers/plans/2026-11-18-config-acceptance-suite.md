# 集成测试子项目 2（config-acceptance 套件）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `tests/integration/config-acceptance/` 配置对齐行为验收套件：33 事件 hook 矩阵、来源优先级、解析容错、env/迁移键验收，双形态（dist/源码）执行。

**Architecture:** 表驱动 fixtures（YAML）+ 断言引擎（读表生成 bun test，`blocked-by-batch:X` 条目生成 skip 行）；双形态 launcher 注入（dist 形态 CI 必跑，源码形态经 `USER_TYPE=ant` + `CLAUDE_CODE_MANAGED_SETTINGS_PATH` 注入 managed，仅本地）。hook 断言统一用沙箱内标记文件 + mock 请求录制。

**Tech Stack:** Bun、YAML（`yaml` 包已有）、bun:test、既有支撑设施（mock-anthropic/pty-driver/sandbox/dist-fixture/stripAnsi）。

**依据：** `docs/superpowers/specs/2026-11-18-config-acceptance-suite-design.md`（approved）。

## Global Constraints

- 33 事件全量 fixture；27 个既有事件（`src/entrypoints/sdk/coreTypes.ts:25` 的 `HOOK_EVENTS`）真实断言；6 个新事件（UserPromptExpansion/PostToolBatch/MessageDisplay/DirectoryAdded/PreModelSwitch/PostModelSwitch）`blocked-by-batch:B1` skip。
- B0 三类 hook 局部清洗条目 `blocked-by-batch:B0` skip（运行时未实现，`src/schemas/hooks.ts:212` 仍为 partialRecord）。
- 双形态：CI 只跑 dist 形态；源码形态仅本地（`--form=source`），在 dist 形态下输出 `SKIP [form:source]` 行。
- 不改动产品源码（src/）；runner 仅加 `--form` 透传。
- 测试判定看退出码 + 无 "Failed test files"；每个 skip 必须有原因行。
- 命名遵守 flash 排除清单；测试证据不记录真实凭据。
- 沙箱 env 已含 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`；REPL ready 信号 `/effort`；权限对话框态下 `/exit`/SIGINT 无效（用 `session.kill()` 收尾）。
- 5xx 触发 ~10 次指数退避（>3min）；终态失败用不可重试 4xx。

## 已确认事实（实施者免探针）

- `HOOK_EVENTS`（coreTypes.ts:25-53，27 个）：PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged。
- `ALWAYS_EMITTED_HOOK_EVENTS = ['SessionStart', 'Setup']`（src/utils/hooks/hookEvents.ts:18）。
- `HookMatcherSchema = { matcher?: string, hooks: [{ type: 'command', command: string }] }`（src/schemas/hooks.ts:194）。
- settings.json 的 hooks 段：`{ "hooks": { "<Event>": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "..." }] }] } }`。
- `MAX_THINKING_TOKENS` 消费者：`src/utils/thinking.ts:148`（>0 启用 thinking）→ 可经 mock 录制的请求体 thinking 字段观察。
- `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` 无消费者（alignment 路线 1.1 节）→ 目标断言 + skip。
- mock 请求体含 `model`；haiku 辅助请求用 `setRouter` 按 model 路由（PR #18 已交付）。
- 迁移键清单（`src/tools/ConfigTool/supportedSettings.ts` `source: 'global'` 的键）：theme、editorMode、verbose、preferredNotifChannel、autoCompactEnabled、fileCheckpointingEnabled、showTurnDuration、terminalProgressBarEnabled、todoFeatureEnabled。

---

### Task 1: runner `--form` 透传 + 双形态 launcher + SKIP 行 helper

**Files:**
- Modify: `scripts/test-integration.ts`
- Create: `tests/integration/config-acceptance/form/launcher.ts`
- Test: `tests/integration/config-acceptance/form/launcher.test.ts`

**Interfaces:**
- Consumes: 既有 `distMainPath()`（support/dist-fixture.ts）。
- Produces:
  - runner 接受 `--form=dist|source`（默认 dist），值为 `source` 时设置 env `FLASH_IT_FORM=source` 传给测试子进程（runner 本身不改测试发现逻辑）
  - `createFormLauncher(form: 'dist' | 'source', opts): Launcher`，`Launcher` 接口：
    ```ts
    export interface Launcher {
      form: 'dist' | 'source'
      // 以该形态 spawn print 模式一轮对话，返回与 print-mode 相同结构的 { out, err, code }
      runPrint(args: string[], sandbox: Sandbox, mockUrl: string): Promise<{ out: string; err: string; code: number }>
      // 以该形态 spawn PTY REPL（源码形态注入 managed 路径 env）
      spawnRepl(opts: { sandbox: Sandbox; mockUrl: string; cols?: number; rows?: number }): Promise<PtySession>
      // 管理路径 env（源码形态返回注入所需 env 片段；dist 形态返回 null）
      managedEnv(sandbox: Sandbox): Record<string, string> | null
    }
    ```
  - `skipLine(kind: string, id: string): string` — 统一 skip 行：`SKIP [${kind}] ${id}`（kind ∈ `blocked-by-batch:B0` | `blocked-by-batch:B1` | `blocked-by-prereq:<reason>` | `form:source`）

- [ ] **Step 1: 写失败测试 `tests/integration/config-acceptance/form/launcher.test.ts`**

```ts
import { describe, test, expect } from 'bun:test'
import { skipLine, createFormLauncher } from './launcher.ts'

describe('skipLine', () => {
  test('formats skip reason line', () => {
    expect(skipLine('blocked-by-batch:B1', 'hook:UserPromptExpansion')).toBe('SKIP [blocked-by-batch:B1] hook:UserPromptExpansion')
    expect(skipLine('form:source', 'managed:vs-user')).toBe('SKIP [form:source] managed:vs-user')
  })
})

describe('createFormLauncher', () => {
  test('source form exposes managed env pointing at sandbox', async () => {
    const { createSandbox } = await import('../../support/sandbox.ts')
    const sandbox = await createSandbox()
    try {
      const launcher = createFormLauncher('source')
      const env = launcher.managedEnv(sandbox)
      expect(env).not.toBeNull()
      expect(env!.USER_TYPE).toBe('ant')
      expect(env!.CLAUDE_CODE_MANAGED_SETTINGS_PATH).toBe(sandbox.managedDir)
      expect(launcher.form).toBe('source')
    } finally {
      await sandbox.cleanup()
    }
  })

  test('dist form has no managed env', async () => {
    const { createSandbox } = await import('../../support/sandbox.ts')
    const sandbox = await createSandbox()
    try {
      const launcher = createFormLauncher('dist')
      expect(launcher.managedEnv(sandbox)).toBeNull()
    } finally {
      await sandbox.cleanup()
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/integration/config-acceptance/form/launcher.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 沙箱增加 managedDir（Modify `tests/integration/support/sandbox.ts`）**

在 `createSandbox` 返回对象中追加托管目录（幂等小改，不动既有行为）：

```ts
// Sandbox 接口与返回值追加：
export interface Sandbox {
  home: string
  project: string
  managedDir: string            // 新增：源码形态 managed 注入目录
  env: Record<string, string>
  cleanup(): Promise<void>
}
```

`createSandbox` 内：

```ts
const managedDir = join(home, 'managed-settings')
await mkdir(managedDir, { recursive: true })
// 返回值加 managedDir
```

- [ ] **Step 4: 实现 `tests/integration/config-acceptance/form/launcher.ts`**

```ts
import { join } from 'path'
import { distMainPath } from '../../support/dist-fixture.ts'
import { spawnPty, type PtySession } from '../../support/pty-driver.ts'
import { MOCK_API_KEY } from '../../support/mock-anthropic.ts'
import { stripAnsi } from '../../support/ansi.ts'
import type { Sandbox } from '../../support/sandbox.ts'

export type Form = 'dist' | 'source'

export interface PrintResult { out: string; err: string; code: number }

export interface Launcher {
  form: Form
  runPrint(args: string[], sandbox: Sandbox, mockUrl: string): Promise<PrintResult>
  spawnRepl(opts: { sandbox: Sandbox; mockUrl: string; cols?: number; rows?: number }): Promise<PtySession>
  managedEnv(sandbox: Sandbox): Record<string, string> | null
}

export function skipLine(kind: string, id: string): string {
  return `SKIP [${kind}] ${id}`
}

const repoRoot = join(import.meta.dir, '..', '..', '..', '..')

async function sourceCliPath(): Promise<string> {
  return join(repoRoot, 'src', 'entrypoints', 'cli.tsx')
}

function baseChildEnv(sandbox: Sandbox, mockUrl: string, form: Form): Record<string, string> {
  const env: Record<string, string> = {
    ...sandbox.env,
    ANTHROPIC_API_KEY: MOCK_API_KEY,
    ANTHROPIC_BASE_URL: mockUrl,
  }
  if (form === 'source') {
    env.USER_TYPE = 'ant'
    env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = sandbox.managedDir
  }
  return env
}

export function createFormLauncher(form: Form): Launcher {
  return {
    form,
    async runPrint(args, sandbox, mockUrl) {
      const entry = form === 'dist' ? await distMainPath() : await sourceCliPath()
      const proc = Bun.spawn([process.execPath, entry, ...args], {
        cwd: sandbox.project,
        env: baseChildEnv(sandbox, mockUrl, form),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = await new Response(proc.stdout).text()
      const err = await new Response(proc.stderr).text()
      const code = await proc.exited
      return { out: stripAnsi(out), err: stripAnsi(err), code }
    },
    async spawnRepl(opts) {
      const entry = form === 'dist' ? await distMainPath() : await sourceCliPath()
      return spawnPty({
        cmd: [process.execPath, entry],
        cwd: opts.sandbox.project,
        cols: opts.cols,
        rows: opts.rows,
        env: baseChildEnv(opts.sandbox, opts.mockUrl, form),
      })
    },
    managedEnv(sandbox) {
      if (form !== 'source') return null
      return { USER_TYPE: 'ant', CLAUDE_CODE_MANAGED_SETTINGS_PATH: sandbox.managedDir }
    },
  }
}
```

- [ ] **Step 5: runner 加 `--form` 透传（Modify `scripts/test-integration.ts`）**

`supportedOptions` 加 `'--form='`；解析处：

```ts
const form = args.find(arg => arg.startsWith('--form='))?.split('=')[1] ?? 'dist'
if (form !== 'dist' && form !== 'source') {
  console.error(`Invalid --form=${form} (supported: dist, source)`)
  process.exit(2)
}
```

子进程 env 透传（`Bun.spawn` 的 env 改为）：

```ts
    env: { ...process.env, FLASH_IT_FORM: form },
```

并在 `--form=source` 时打印提示行 `--form=source: managed-injection tests require USER_TYPE=ant; they skip in dist form`。

- [ ] **Step 6: 运行确认通过 + 全套件回归**

```bash
bun test tests/integration/config-acceptance/form/launcher.test.ts
bun run test:integration --no-build
```

Expected: launcher 3 pass；全套件退出码 0。

- [ ] **Step 7: Commit**

```bash
git add scripts/test-integration.ts tests/integration/support/sandbox.ts tests/integration/config-acceptance/form/
git commit -m "Add form launchers and skip-line helper for config-acceptance suite

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 引擎核心（fixture 加载校验 + hook 矩阵生成骨架）

**Files:**
- Create: `tests/integration/config-acceptance/engine/entries.ts`
- Test: `tests/integration/config-acceptance/engine/engine.test.ts`
- Create: `tests/integration/config-acceptance/fixtures/hooks.yaml`（本任务先放 3 条 tool_call 条目占位验证引擎，Task 3-8 补全 33 条）

**Interfaces:**
- Produces:
  ```ts
  export type EntryStatus = 'active' | `blocked-by-batch:${string}` | `blocked-by-prereq:${string}` | 'form:source'
  export interface HookEntry {
    id: string                    // `hook:<Event>`
    event: string
    status: EntryStatus
    trigger: string               // 场景构造器键
    matcher: string
    exit_semantics: 'block' | 'allow' | 'nonblock'
    expected_effect: Record<string, unknown>
  }
  export function loadHookEntries(yamlPath: string): HookEntry[]   // 校验失败抛含条目 id 的 Error
  export function isBlocked(status: EntryStatus): boolean
  ```

- [ ] **Step 1: 写 fixtures/hooks.yaml（先 3 条）**

```yaml
- event: PreToolUse
  status: active
  trigger: tool_call_unsafe_block
  matcher: '*'
  exit_semantics: block
  expected_effect:
    tool_executed: false
    hook_fired: true
- event: PostToolUse
  status: active
  trigger: tool_call_safe
  matcher: '*'
  exit_semantics: nonblock
  expected_effect:
    tool_executed: true
    hook_fired: true
- event: UserPromptExpansion
  status: blocked-by-batch:B1
  trigger: none
  matcher: '*'
  exit_semantics: nonblock
  expected_effect: {}
```

- [ ] **Step 2: 写失败测试 `engine/engine.test.ts`**

```ts
import { describe, test, expect } from 'bun:test'
import { loadHookEntries, isBlocked } from './entries.ts'
import { join } from 'path'

const hooksYaml = join(import.meta.dir, '..', 'fixtures', 'hooks.yaml')

describe('loadHookEntries', () => {
  test('loads entries with ids and preserves order', () => {
    const entries = loadHookEntries(hooksYaml)
    expect(entries.length).toBe(3)
    expect(entries[0].id).toBe('hook:PreToolUse')
    expect(entries[2].id).toBe('hook:UserPromptExpansion')
    expect(entries[0].trigger).toBe('tool_call_unsafe_block')
  })

  test('unknown trigger throws with entry id', () => {
    // 临时写一个坏 fixture
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'ca-bad-'))
    const bad = join(dir, 'bad.yaml')
    await writeFile(bad, `- event: PreToolUse\n  status: active\n  trigger: bogus_trigger\n  matcher: '*'\n  exit_semantics: block\n  expected_effect: {}\n`)
    try {
      expect(() => loadHookEntries(bad)).toThrow(/hook:PreToolUse/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('isBlocked classifies statuses', () => {
    expect(isBlocked('active')).toBe(false)
    expect(isBlocked('blocked-by-batch:B0')).toBe(true)
    expect(isBlocked('blocked-by-prereq:mcp-elicit-server')).toBe(true)
    expect(isBlocked('form:source')).toBe(true)
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `bun test tests/integration/config-acceptance/engine/engine.test.ts`
Expected: FAIL（entries.ts 不存在）。

- [ ] **Step 4: 实现 `engine/entries.ts`**

```ts
import { parse } from 'yaml'

export type EntryStatus =
  | 'active'
  | `blocked-by-batch:${string}`
  | `blocked-by-prereq:${string}`
  | 'form:source'

export interface HookEntry {
  id: string
  event: string
  status: EntryStatus
  trigger: string
  matcher: string
  exit_semantics: 'block' | 'allow' | 'nonblock'
  expected_effect: Record<string, unknown>
}

// trigger 场景构造器注册表由 scenarios.ts 维护；加载期只校验非空 + 类型
const KNOWN_TRIGGER_PREFIX = 'tool_call|permission_prompt|print_turn|repl_|subagent|none'

export function isBlocked(status: EntryStatus): boolean {
  return status !== 'active'
}

export function loadHookEntries(yamlPath: string): HookEntry[] {
  const raw = parse(await_read(yamlPath)) as Array<Record<string, unknown>>
  return raw.map((item, index) => {
    const event = require_string(item, 'event', index)
    const entry: HookEntry = {
      id: `hook:${event}`,
      event,
      status: require_status(item, index),
      trigger: require_string(item, 'trigger', index),
      matcher: typeof item.matcher === 'string' ? item.matcher : '*',
      exit_semantics: require_exit(item, index),
      expected_effect: (item.expected_effect as Record<string, unknown>) ?? {},
    }
    if (entry.trigger !== 'none' && !new RegExp(`^(${KNOWN_TRIGGER_PREFIX})`).test(entry.trigger)) {
      throw new Error(`${entry.id}: unknown trigger "${entry.trigger}"`)
    }
    return entry
  })
}

// ---- helpers（同步读 + 校验，错误信息必须含条目 id）----
function await_read(path: string): string {
  return require('fs').readFileSync(path, 'utf8')
}
function require_string(item: Record<string, unknown>, key: string, index: number): string {
  const v = item[key]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`entry #${index}: missing "${key}"`)
  return v
}
function require_status(item: Record<string, unknown>, index: number): EntryStatus {
  const v = item.status
  if (
    v === 'active' || v === 'form:source' ||
    (typeof v === 'string' && (v.startsWith('blocked-by-batch:') || v.startsWith('blocked-by-prereq:')))
  ) return v as EntryStatus
  throw new Error(`entry #${index}: invalid status "${String(v)}"`)
}
function require_exit(item: Record<string, unknown>, index: number): 'block' | 'allow' | 'nonblock' {
  const v = item.exit_semantics
  if (v === 'block' || v === 'allow' || v === 'nonblock') return v
  throw new Error(`entry #${index}: invalid exit_semantics "${String(v)}"`)
}
```

注意：`await_read` 用 `require('fs')` 同步读是为让 `loadHookEntries` 保持同步（engine.test 的 toThrow 断言需要同步抛错）。若仓库 ESM 环境下 `require` 不可用，改用 `readFileSync` 顶层 import：

```ts
import { readFileSync } from 'node:fs'
// await_read 改为：return readFileSync(path, 'utf8')
```

- [ ] **Step 5: 运行确认通过**

Run: `bun test tests/integration/config-acceptance/engine/engine.test.ts`
Expected: 3 pass。

- [ ] **Step 6: Commit**

```bash
git add tests/integration/config-acceptance/engine/ tests/integration/config-acceptance/fixtures/hooks.yaml
git commit -m "Add fixture entry loader with validation for hook matrix

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: hook 触发场景构造器（tool_call 系列）

**Files:**
- Create: `tests/integration/config-acceptance/engine/scenarios.ts`
- Modify: `tests/integration/config-acceptance/fixtures/hooks.yaml`（PreToolUse/PostToolUse/PostToolUseFailure 三条目定稿）
- Test: `tests/integration/config-acceptance/hooks-matrix.test.ts`（本任务先覆盖 3 条目）

**Interfaces:**
- Consumes: `Launcher`（Task 1）、`loadHookEntries/isBlocked`（Task 2）、`createMockAnthropic/MOCK_API_KEY`、`createSandbox`（含 managedDir）。
- Produces:
  ```ts
  export type ScenarioKey =
    | 'tool_call_safe' | 'tool_call_unsafe_block' | 'tool_call_fail'
    | 'permission_prompt' | 'permission_denied'
    | 'print_turn' | 'repl_compact' | 'repl_config_change' | 'repl_file_change'
    | 'subagent' | 'none'
  export interface ScenarioResult {
    hookFired: boolean
    marker: Record<string, unknown> | null   // hook stdin JSON（解析后）
    toolExecuted: boolean                     // 由标记文件或输出推断
    extra?: Record<string, unknown>
  }
  export async function runHookScenario(
    scenario: ScenarioKey,
    ctx: { launcher: Launcher; mock: MockAnthropic; sandbox: Sandbox; hookCommand: string },
  ): Promise<ScenarioResult>
  ```
  `hookCommand` 是写标记的 shell 命令模板（引擎生成）：`cat > '<marker path>'`（stdin JSON 落盘）；block 场景为 `cat > '<marker path>'; exit 2`。

**场景语义（已验证机制）：**

- `tool_call_safe`：mock 主请求返回 tool_use `Bash echo MARKER_SAFE`（安全命令自动放行）；hook 命令 exit 0 写 stdin。断言：标记存在（hook_fired）+ 标记 JSON 含 `tool_name:"Bash"` + stdout 含 MARKER_SAFE（tool_executed）。
- `tool_call_unsafe_block`：tool_use `Bash touch blocked.txt`；hook `exit 2`（PreToolUse block 语义）。断言：标记存在 + `sandbox.project/blocked.txt` 不存在（tool_executed=false）+ 请求录制中出现 tool_result is_error（block 拒绝回传模型）。**注意**：Task 12 实测"拒绝权限"不发新请求，但 PreToolUse hook exit 2 是另一机制（程序化拒绝）——先探针：若实测同样不发新请求，则断言改为仅"文件不存在 + hook_fired"，并在 expected_effect 中去掉 model_sees_denial。
- `tool_call_fail`：tool_use `Bash exit 7`；PostToolUseFailure hook 断言标记 JSON 含错误指示。
- `permission_prompt` / `permission_denied`：复用 PR #18 permissions.test.ts 已验证机制（`touch` 触发提示；'1'+Enter 批准；'3'+Enter 拒绝 → "instead?"）。
- `print_turn`：launcher.runPrint 单轮；hook 断言标记文件（SessionStart/Setup/UserPromptSubmit/Stop/InstructionsLoaded 等生命周期事件共用，hook 命令把事件名追加到同一标记以区分多次触发）。
- `repl_compact` / `repl_config_change` / `repl_file_change` / `subagent`：Task 5-7 逐个落地（本任务先在 scenarios.ts 中留类型占位并 throw `scenario not implemented yet` —— 不是占位符：Task 3 的 yaml 条目只用已实现的 scenario 键）。

- [ ] **Step 1: 定稿 hooks.yaml 前三条目（替换 Task 2 占位）**

```yaml
- event: PreToolUse
  status: active
  trigger: tool_call_unsafe_block
  matcher: '*'
  exit_semantics: block
  expected_effect:
    hook_fired: true
    tool_executed: false
- event: PostToolUse
  status: active
  trigger: tool_call_safe
  matcher: '*'
  exit_semantics: nonblock
  expected_effect:
    hook_fired: true
    tool_executed: true
    marker_has_tool_name: true
- event: PostToolUseFailure
  status: active
  trigger: tool_call_fail
  matcher: '*'
  exit_semantics: nonblock
  expected_effect:
    hook_fired: true
    marker_has_error: true
```

- [ ] **Step 2: 实现场景构造器（scenarios.ts 的 tool_call 三场景 + 探针步骤）**

```ts
import { join } from 'path'
import { spawnPty, type PtySession } from '../../support/pty-driver.ts'
import { stripAnsi } from '../../support/ansi.ts'
import type { Launcher } from '../form/launcher.ts'
import type { MockAnthropic } from '../../support/mock-anthropic.ts'
import type { Sandbox } from '../../support/sandbox.ts'

export type ScenarioKey =
  | 'tool_call_safe' | 'tool_call_unsafe_block' | 'tool_call_fail'
  | 'permission_prompt' | 'permission_denied'
  | 'print_turn' | 'repl_compact' | 'repl_config_change' | 'repl_file_change'
  | 'subagent' | 'none'

export interface ScenarioContext {
  launcher: Launcher
  mock: MockAnthropic
  sandbox: Sandbox
  hookCommand: string      // 完整 shell 命令（引擎拼好，含 marker 路径）
}

export interface ScenarioResult {
  hookFired: boolean
  marker: Record<string, unknown> | null
  toolExecuted: boolean
  stdout: string
}

export async function runHookScenario(scenario: ScenarioKey, ctx: ScenarioContext): Promise<ScenarioResult> {
  switch (scenario) {
    case 'tool_call_safe': return toolCallScenario(ctx, { command: 'echo HOOK_TOOL_SAFE', executable: true, hookFails: false })
    case 'tool_call_unsafe_block': return toolCallScenario(ctx, { command: 'touch blocked.txt', executable: false, hookFails: true })
    case 'tool_call_fail': return toolCallScenario(ctx, { command: 'exit 7', executable: false, hookFails: false, isFailureEvent: true })
    default:
      throw new Error(`scenario "${scenario}" not implemented yet`)
  }
}

async function toolCallScenario(
  ctx: ScenarioContext,
  opts: { command: string; executable: boolean; hookFails: boolean; isFailureEvent?: boolean },
): Promise<ScenarioResult> {
  const { launcher, mock, sandbox, hookCommand } = ctx
  const markerPath = join(sandbox.home, 'hook-marker.json')
  const eventsFile = join(sandbox.home, 'hook-events-seen.txt')
  // hook 配置写入 sandbox user settings（createSandbox 的 userSettings 选项在场景内直接写文件）
  const settings = {
    hooks: {
      // 引擎按条目 event 写对应段；这里由调用方（hooks-matrix.test.ts）传入实际 event
    },
  }
  void settings // 实际写入由测试入口完成（见 hooks-matrix.test.ts），场景函数只负责执行与断言收集

  // 1) mock：haiku 路由已由测试入口 setRouter；主请求返回 tool_use，随后终态文本
  const toolUse = { type: 'tool_use' as const, id: 'toolu_hook_1', name: 'Bash', input: { command: opts.command, description: 'hook scenario' } }
  mock.enqueue(toolUse, toolUse, { type: 'text', text: 'HOOK_SCENARIO_DONE' }, { type: 'text', text: 'HOOK_SCENARIO_DONE' })

  // 2) print 模式执行（携带 --settings 指向含 hooks 的文件由测试入口通过 args 传入）
  const { out, code } = await launcher.runPrint(['-p', 'run it'], sandbox, mock.url)

  // 3) 收集：标记文件（hook stdin JSON）+ 事件名清单
  const markerRaw = await Bun.file(markerPath).text().catch(() => null)
  let marker: Record<string, unknown> | null = null
  if (markerRaw) {
    try { marker = JSON.parse(markerRaw) } catch { marker = { raw: markerRaw } }
  }
  const eventsSeen = (await Bun.file(eventsFile).text().catch(() => '')).split('\n').filter(Boolean)
  const toolExecuted = opts.executable
    ? out.includes('HOOK_TOOL_SAFE')
    : !(await Bun.file(join(sandbox.project, opts.command.split(' ')[1] ?? 'blocked.txt')).exists())

  return { hookFired: eventsSeen.length > 0 || marker !== null, marker, toolExecuted, stdout: out }
}
```

**实现说明（必须遵守）**：hook 命令模板由 `hooks-matrix.test.ts` 生成（`sh -c 'cat > marker; echo <Event> >> events-seen'`），写入 sandbox 的 user settings（`createSandbox({ userSettings: { hooks: {...} } })`）；场景函数专注执行与收集。若 print 模式下 hook 的触发有额外前提（探针确认），把前提写进 scenarios.ts 注释。

**探针步骤（Step 2 之后、断言定稿前执行）**：PreToolUse exit 2 是否把拒绝回传模型（请求录制出现 tool_result）？

```bash
bun -e '
// 与 scenarios.toolCallScenario 相同流程，hook 命令 exit 2，观察第二个 /v1/messages 请求
// 期望输出：第二请求的最后消息是否含 tool_result/is_error；据此定稿 expected_effect'
```

- [ ] **Step 3: 写 hooks-matrix.test.ts（先覆盖 3 条目）**

```ts
import { describe, test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { loadHookEntries, isBlocked, type HookEntry } from './engine/entries.ts'
import { runHookScenario } from './engine/scenarios.ts'
import { createFormLauncher, skipLine, type Launcher } from './form/launcher.ts'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic.ts'
import { createSandbox, type Sandbox } from '../support/sandbox.ts'

const FORM = (process.env.FLASH_IT_FORM ?? 'dist') as 'dist' | 'source'
const hooksYaml = join(import.meta.dir, 'fixtures', 'hooks.yaml')

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

function routeHaikuAux(mock: MockAnthropic): void {
  mock.setRouter(request => {
    const model = (request.body as Record<string, unknown> | null)?.model
    return typeof model === 'string' && model.includes('haiku')
      ? { type: 'text', text: 'HAIKU_AUX_OK' }
      : null
  })
}

// 每条目独立沙箱；hook 命令写 stdin JSON 到 marker 并把事件名追加到 events-seen
function hookSettingsFor(event: string, sandboxHome: string, exit2: boolean): Record<string, unknown> {
  const markerPath = join(sandboxHome, 'hook-marker.json')
  const eventsFile = join(sandboxHome, 'hook-events-seen.txt')
  const body = `cat > '${markerPath}'; echo '${event}' >> '${eventsFile}'`
  const cmd = exit2 ? `${body}; exit 2` : body
  return {
    hooks: {
      [event]: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }],
    },
  }
}

async function runEntry(entry: HookEntry): Promise<void> {
  const launcher = createFormLauncher(FORM)
  const mock = await createMockAnthropic()
  const sandbox = await createSandbox({
    userSettings: hookSettingsFor(entry.event, launcher.managedEnv ? '' : '', false), // 实际传参见下
  })
  toClose.push({ sandbox, mock })
  routeHaikuAux(mock)
  // （hookSettingsFor 的 exit2 参数取 entry.exit_semantics === 'block'；sandboxHome 取 sandbox.home）
  const result = await runHookScenario(entry.trigger as never, { launcher, mock, sandbox, hookCommand: '' })
  for (const [key, expected] of Object.entries(entry.expected_effect)) {
    if (key === 'hook_fired') expect(result.hookFired, `${entry.id} hook_fired`).toBe(expected)
    if (key === 'tool_executed') expect(result.toolExecuted, `${entry.id} tool_executed`).toBe(expected)
    if (key === 'marker_has_tool_name') expect((result.marker as Record<string, unknown> | null)?.tool_name, `${entry.id} marker.tool_name`).toBe('Bash')
    if (key === 'marker_has_error') expect(JSON.stringify(result.marker), `${entry.id} marker error`).toMatch(/error|is_error/i)
  }
}

describe('hook matrix', () => {
  const entries = loadHookEntries(hooksYaml)
  for (const entry of entries) {
    if (isBlocked(entry.status)) {
      test.skip(`${entry.id} (${entry.status})`, () => {})
      // skip 行必须在输出可见：bun test 的 test.skip 会标 skip；引擎额外 console.log 原因
      console.log(skipLine(entry.status, entry.id))
      continue
    }
    test(`${entry.id} [${entry.trigger}]`, { timeout: 120_000 }, async () => {
      await runEntry(entry)
    })
  }
})
```

（落地时按注释整理 `runEntry` 的传参：`hookSettingsFor(entry.event, sandbox.home, entry.exit_semantics === 'block')`；`userSettings` 用其返回值。）

- [ ] **Step 4: 运行确认通过**

```bash
bun test tests/integration/config-acceptance/hooks-matrix.test.ts
bun run test:integration --no-build
```

Expected: 3 active 条目 pass（或探针后调整 expected_effect）；全套件退出码 0。

- [ ] **Step 5: Commit**

```bash
git add tests/integration/config-acceptance/
git commit -m "Add hook matrix engine scenarios for tool_call triggers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: hook 矩阵补全（permission/turn 生命周期条目，共 11 事件）

**Files:**
- Modify: `tests/integration/config-acceptance/fixtures/hooks.yaml`（追加 Notification, PermissionRequest, PermissionDenied, UserPromptSubmit, SessionStart, SessionEnd, Stop, StopFailure, Setup, InstructionsLoaded）
- Modify: `tests/integration/config-acceptance/engine/scenarios.ts`（实现 `permission_prompt`/`permission_denied`/`print_turn`）
- Modify: `tests/integration/config-acceptance/hooks-matrix.test.ts`（场景 → 断言映射扩展）

**Interfaces:** Consumes Task 3 全部；Produces：scenario `permission_prompt`/`permission_denied`/`print_turn`。

**事件 → 场景映射（写入 yaml）：**

| event | trigger | 要点 |
|---|---|---|
| Notification | permission_prompt | touch 触发提示时 Notification 附带消息；标记 JSON 含 message 字段（探针定字段名） |
| PermissionRequest | permission_prompt | 提示出现即触发 |
| PermissionDenied | permission_denied | '3'+Enter 拒绝后触发（探针：是否触发及 stdin 字段） |
| UserPromptSubmit | print_turn | stdin 含 prompt 字段 |
| SessionStart | print_turn | ALWAYS_EMITTED；stdin 含 source（探针定值） |
| SessionEnd | print_turn | print 结束时是否触发探针；不触发改 `blocked-by-prereq:session-end-print` 并记录 |
| Stop | print_turn | 回合结束触发 |
| StopFailure | 探针 | mock 400 错误路径是否触发；不触发 `blocked-by-prereq:stop-failure-observability` |
| Setup | print_turn | ALWAYS_EMITTED |
| InstructionsLoaded | print_turn | 启动装载指令时触发（探针确认 print 模式是否触发） |

- [ ] **Step 1: 探针不确定项（SessionEnd/StopFailure/PermissionDenied/Notification 字段名/InstructionsLoaded）**——探针脚本模式同 Task 3，输出记录进报告
- [ ] **Step 2: yaml 追加条目 + scenarios 实现三场景**
- [ ] **Step 3: hooks-matrix.test.ts 断言映射扩展**（`marker_has_message`/`marker_has_prompt`/`marker_has_source` 等，探针定字段）
- [ ] **Step 4: 运行**：`bun test tests/integration/config-acceptance/hooks-matrix.test.ts`（13 active + 0 skip 此阶段）；全套件退出码 0
- [ ] **Step 5: Commit**

```bash
git add tests/integration/config-acceptance/
git commit -m "Extend hook matrix with permission and turn lifecycle events

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: hook 矩阵补全（compact/config/file/cwd，5 事件）

**Files:** 同 Task 4 模式（yaml + scenarios + 映射）

| event | trigger | 场景 |
|---|---|---|
| PreCompact / PostCompact | repl_compact | PTY REPL 一轮对话后 `/compact\r`（探针：命令名与触发行为；标记文件断言） |
| ConfigChange | repl_config_change | REPL 存活期间改写 sandbox user settings.json（探针：是否触发） |
| FileChanged | repl_file_change | 探针：监听机制（会话内文件变更是否触发）；不触发 → `blocked-by-prereq:file-watch-observability` |
| CwdChanged | 探针 | 不触发 → `blocked-by-prereq:cwd-change-observability` |

- [ ] Steps: 探针 → yaml + scenarios → 映射 → 运行（18 active）→ Commit `Extend hook matrix with compact and change-monitoring events`

---

### Task 6: hook 矩阵补全（subagent/task/team，5 事件）+ prereq/B1 skip（8 事件）→ 33 收口

**Files:** 同前模式

| event | trigger | 处理 |
|---|---|---|
| SubagentStart / SubagentStop | subagent | mock 主请求返回 Task tool_use（subagent_type 探针定），子请求走同一 mock；标记断言 |
| TaskCreated / TaskCompleted | 探针 | Task 工具是否产生任务事件；不触发 → `blocked-by-prereq:task-tool-observability` |
| TeammateIdle | `blocked-by-prereq:teammate-mode` | 无离线 teammate 场景 |
| Elicitation / ElicitationResult | `blocked-by-prereq:mcp-elicit-server` | 需 MCP elicitation 服务端（子项目 3 mock MCP 落地后点亮） |
| WorktreeCreate / WorktreeRemove | 探针（/worktree 命令?）；否则 `blocked-by-prereq:worktree-ui` |
| 6 个新事件 | `blocked-by-batch:B1` |

- [ ] Steps: 探针 → yaml 补全至 33 条 → 映射 → 引擎计数门（测试断言 `entries.length === 33`）→ 运行（27 中 active 数 + 显式 skip 行）→ Commit `Complete 33-event hook matrix with prereq and batch skips`

---

### Task 7: 来源优先级（sources.yaml + source-engine + sources.test.ts）

**Files:**
- Create: `fixtures/sources.yaml`、`engine/source-engine.ts`、`sources.test.ts`
- Test: 同文件

**Interfaces:**
```ts
// engine/source-engine.ts
export interface SourceEntry {
  id: string                          // `source:user-vs-project` 等
  status: EntryStatus
  form: 'dist' | 'source'             // 条目所需形态
  layers: Record<string, Record<string, unknown>>  // { user: {...}, project: {...} } 各来源 settings 片段
  expect_key: string                  // 'model'
  expect_value: unknown               // 预期胜出值
}
export function loadSourceEntries(yamlPath): SourceEntry[]
export async function runSourceEntry(entry, launcher, mock, sandbox): Promise<unknown>  // 返回请求录制中观察到的胜出值
```

sources.yaml 条目（8 dist + 2 source）：user-vs-project、local-vs-project、local-vs-user、flag-vs-user、project-alone、user-alone、managed-vs-user(source)、managed-vs-flag(source)。键用 `model`（请求体可观察）；flag 来源经 runPrint args 传 `--settings <沙箱临时文件>`（探针确认 flag settings 的注入方式与覆盖关系）。

- [ ] Steps: yaml（8+2 条，实际值写死）→ engine → test（dist 条目真实跑；source 条目在 dist 形态 skipLine('form:source', id)）→ 三轮稳定 → Commit `Add source precedence acceptance tests with request-recorded assertions`

---

### Task 8: 解析容错（tolerance.yaml + tolerance.test.ts）

**Files:** `fixtures/tolerance.yaml`、`tolerance.test.ts`（无独立引擎，直写测试读表）

条目（spec 4.3 表）：3 个 B0 blocked（未知事件/已知事件非数组/hooks 非对象 → `blocked-by-batch:B0` skip，但 fixture 里写全目标断言参数）；2 个 active（`model: 42` 整来源失效——断言该来源的 model 不生效而兄弟来源生效；未知顶层键 passthrough 不致命——断言对话正常完成）；1 个 managed fail-closed（form:source，Task 9 覆盖，此处 skipLine('form:source')）。

- [ ] Steps: yaml → test 直写（active 条目用 launcher.runPrint + 请求录制断言 model 未被污染）→ 运行 → Commit `Add settings tolerance acceptance tests with B0 blocked markers`

---

### Task 9: env 键与迁移键（env-keys.yaml / migration-keys.yaml + 两个 test）

**Files:** `fixtures/env-keys.yaml`、`fixtures/migration-keys.yaml`、`env-keys.test.ts`、`migration-keys.test.ts`

- env-keys 条目：
  - `MAX_THINKING_TOKENS`（active）：env 设 1024 → 断言请求体 thinking 配置存在且 budget 反映（探针定字段路径：`thinking.type`/`budget_tokens`）；unset → 断言无 thinking 配置。消费者证据：src/utils/thinking.ts:148。
  - `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`（`blocked-by-batch:B1` 或对齐批次）：目标断言写入 fixture（超限 subagent 数被拒绝），skip。
- migration-keys 条目（9 键中选运行时可观察的，其余条目标 `blocked-by-prereq:no-observable-runtime` 并写明原因）：
  - `model`（global source）→ 请求体 model 断言
  - `verbose` → PTY 输出 detail（探针定可观察差异）
  - 其余（theme/editorMode/preferredNotifChannel/autoCompactEnabled/fileCheckpointingEnabled/showTurnDuration/terminalProgressBarEnabled/todoFeatureEnabled）逐个探针定观察手段；无观察手段的如实标记 blocked-by-prereq（在条目 comment 里写证据路径）

- [ ] Steps: yaml → tests → 运行 → Commit `Add env key and migration key acceptance tests`

---

### Task 10: managed 安全策略（form:source 专属）

**Files:** `managed-security.test.ts`（读 tolerance.yaml 的 `form:source` 条目 + sources.yaml 的 managed 条目）

- 机制：`createFormLauncher('source')` + `launcher.managedEnv(sandbox)` 注入；写 `sandbox.managedDir/managed-settings.json` 各场景（正常覆盖 / 损坏 JSON / 危险 permissions）
- 断言按上游证据（managed 安全降级规则）：损坏时不回退宽松（探针记录实际行为并断言；若 flash 行为与上游证据冲突，记录为发现并按实际行为断言 + 注释证据）
- dist 形态下整个文件 skip（`test.skip` + skipLine('form:source', 'managed-security')）

- [ ] Steps: 探针（源码形态跑三种 managed 场景）→ 测试 → `--form=source` 本地验证 → dist 形态验证 skip 行 → Commit `Add managed settings security acceptance tests for source form`

---

### Task 11: 收口验证 + 计数门 + 文档

**Files:**
- Modify: `engine/engine.test.ts`（计数门：`loadHookEntries` 长度 === 33）
- Modify: `README.md` / `README.zh-CN.md`（命令表追加 `--form=source` 说明行，双语成对）

- [ ] Step 1: 计数门 + 全套件 3 轮
```bash
bun test tests/integration/config-acceptance/engine/engine.test.ts
bun run test:integration  # 3 次，均退出码 0
bun scripts/test-integration.ts --suite=config-acceptance --form=source  # 本地（ant 门控环境）
```
- [ ] Step 2: README 双语行
```markdown
| `bun scripts/test-integration.ts --suite=config-acceptance --form=source` | Run managed-source acceptance tests in source form (requires USER_TYPE=ant override; local only). |
```
（zh：`| ... | 以源码形态运行 managed 来源验收测试（需 USER_TYPE=ant 覆盖；仅本地）。 |`）
- [ ] Step 3: Commit `Add config-acceptance count gate and document source form`

## Self-Review 记录

- **Spec 覆盖**：spec §3 结构 → Task 1-2；§4.1 hooks 33 → Task 2-6（含计数门）；§4.2 sources → Task 7；§4.3 tolerance → Task 8/10；§4.4 env/migration → Task 9；§5 引擎+单测 → Task 2/3；§6 验收标准 1-6 → Task 11（计数门/3 轮/--form=source/≤10min 由场景复用 print 会话保障）；runner `--form` → Task 1。
- **计划对 spec 的两处细化**（非冲突）：①trigger 枚举从 spec 的 6 类细化为 11 个场景键（spec 枚举是场景族的分组，计划给出可执行键）；②新增 `blocked-by-prereq:<reason>` 状态（spec 只定义 blocked-by-batch 与 form:source）——用于"场景前提不具备"（MCP elicitation、teammate 模式等），与"批次未实现"语义分离；skip 行格式一致。
- **占位符**：无 TBD；探针步骤均给出探针目标、决策规则与 fallback 标记；不确定字段名以"探针定字段"显式标注并要求记录进报告。
- **类型一致性**：Launcher/runPrint/spawnRepl/managedEnv（Task 1）被 Task 3-10 引用；HookEntry/loadHookEntries/isBlocked（Task 2）被 Task 3-6/11 引用；ScenarioKey/runHookScenario（Task 3）被 Task 4-6 扩展。
