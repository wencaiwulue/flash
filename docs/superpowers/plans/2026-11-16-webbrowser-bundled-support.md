# Bundled WebBrowser 进程内支持实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bundled 与 dist 两种产物形态下 WebBrowser 工具真正可用（构建插件内联 playwright-core 数据读取），并用 release 冒烟 + pty 启动冒烟把该崩溃类问题变成自动化门禁。

**Architecture:** 新增 `scripts/playwrightInlinePlugin.ts`（Bun 构建插件，onLoad 拦截 playwright-core/lib/*.js，把 `require(join(packageRoot, "package.json"/"browsers.json"))` 内联为编译期常量），经 `createBuildOptions()` 挂入全部 Bun.build；`src/main.tsx` 加 env 门控的 `FLASH_SMOKE_TOOL` 测试通道，`scripts/build-binary.ts` 冒烟在 node_modules 隐藏态下端到端调用 WebBrowser；测试套件加 dist 形态 pty 启动冒烟。

**Tech Stack:** Bun 1.3+（Bun.build plugins + compile）、TypeScript、`bun:test`。

## Global Constraints

来自已批准规格 `docs/superpowers/specs/2026-11-16-webbrowser-bundled-support-design.md`，每个任务隐式继承：

- **不修改 `node_modules` 内任何文件**；一切转换在构建插件内完成。
- `WEB_BROWSER_TOOL` 保持在 `EXTERNAL_FEATURES` 中，不改 feature profile。
- 不改 `src/external-stubs/claude-for-chrome-mcp.ts` 的既有逻辑（chrome-cdp sidecar 路径与 ws 限制注释不动）。
- 冒烟测试通道仅由 `FLASH_SMOKE_TOOL` 环境变量激活；未设时 CLI 行为与现状逐字节一致。
- 提交信息以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。
- 工作分支：`webbrowser-bundled-support`（已存在，spec 已提交）。
- Chrome 缺失语义：launch 的 browser-not-found 类错误 → 警告跳过；其余错误 → 冒烟失败、构建失败。

## 实施理由与步骤依据

依赖顺序：Task 1 的插件是其余一切的前提（没有内联，bundled 必崩）；Task 2 的冒烟通道依赖 Task 1 才能在真实二进制里成功，其负例验证（临时移除插件→冒烟必须失败）同时是 Task 1 的集成验收；Task 3 与 Task 1/2 无代码依赖，仅依赖 dist 产物存在；Task 4 收尾登记与文档。插件代码以实验验证脚本 `/tmp/exp-inbin/build.ts`（2026-11-16 e2e 通过）为基准移植，正则模式经真实 coreBundle.js 验证命中。

## File Structure

- Create: `scripts/playwrightInlinePlugin.ts` — 插件 + 可单测的内联转换函数
- Modify: `scripts/build.ts` — `createBuildOptions()` 增加 plugins
- Create: `tests/playwrightInlinePlugin.test.ts` — 绊线 + 单元 + 透传
- Modify: `src/main.tsx:874-879` — main() 最早期 FLASH_SMOKE_TOOL 分支
- Modify: `scripts/build-binary.ts:216-233` — smokeTestBinary 追加工具冒烟
- Create: `tests/interactiveStartup.test.ts` — pty 启动冒烟
- Modify: `docs/external-stubs/contracts/open-chrome.md` — bundled 支持声明
- Modify: `docs/architecture/coverage/manifest.yaml` + Create: `docs/architecture/coverage/webbrowser-bundled-support.yaml`
- 不修改：`scripts/externalFeatureProfile.ts`、`src/external-stubs/**`、`src/tools/WebBrowserTool/**`

---

### Task 1: 构建插件与接入（TDD）

**Files:**
- Create: `scripts/playwrightInlinePlugin.ts`
- Modify: `scripts/build.ts`
- Test: `tests/playwrightInlinePlugin.test.ts`

**Interfaces:**
- Consumes: 磁盘上 `node_modules/playwright-core/{package.json,browsers.json}`（构建期真实文件）。
- Produces: `createPlaywrightInlinePlugin(): BunPlugin`（供 build.ts 消费）；`inlinePlaywrightDataReads(source, packageJsonText, browsersJsonText): Promise<{contents: string, inlined: string[]}>`（供测试与插件共用，inlined 元素为 `'package.json'`/`'browsers.json'`）。Task 2 依赖"插件已挂入 compile 构建"这一事实。

- [ ] **Step 1: 写失败测试**

创建 `tests/playwrightInlinePlugin.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inlinePlaywrightDataReads } from '../scripts/playwrightInlinePlugin.ts'

const coreBundlePath = resolve(import.meta.dir, '../node_modules/playwright-core/lib/coreBundle.js')
const PKG_PATTERN = /require\([A-Za-z_$][\w$]*(?:\.default)?\.join\(packageRoot, "package\.json"\)\)/
const BRW_PATTERN = /require\([A-Za-z_$][\w$]*(?:\.default)?\.join\(packageRoot, "browsers\.json"\)\)/

describe('playwrightInlinePlugin', () => {
  test('tripwire: current playwright-core still contains the two require patterns', async () => {
    const source = await readFile(coreBundlePath, 'utf8')
    expect(source).toMatch(PKG_PATTERN)
    expect(source).toMatch(BRW_PATTERN)
  })

  test('inlines both data reads; result evaluates to the inlined objects', async () => {
    const pkg = JSON.stringify({ name: 'playwright-core', version: 'test' })
    const browsers = JSON.stringify({ browsers: [{ name: 'chromium' }] })
    const synthetic =
      'const a = require(path.join(packageRoot, "package.json"));\n' +
      'const b = require(path8.default.join(packageRoot, "browsers.json"));'
    const { contents, inlined } = await inlinePlaywrightDataReads(synthetic, pkg, browsers)
    expect(inlined).toEqual(['package.json', 'browsers.json'])
    const [a, b] = new Function(`${contents}\nreturn [a, b]`)() as [
      { name: string },
      { browsers: { name: string }[] },
    ]
    expect(a.name).toBe('playwright-core')
    expect(b.browsers[0]?.name).toBe('chromium')
  })

  test('passthrough: text without the patterns is returned unchanged', async () => {
    const source = 'export const x = require("other")'
    const { contents, inlined } = await inlinePlaywrightDataReads(source, '{}', '{}')
    expect(contents).toBe(source)
    expect(inlined).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test ./tests/playwrightInlinePlugin.test.ts 2>&1 | tail -5`
Expected: FAIL — `inlinePlaywrightDataReads` 未导出（模块不存在，导入报错）。

- [ ] **Step 3: 实现插件**

创建 `scripts/playwrightInlinePlugin.ts`（正则模式与实验验证脚本 /tmp/exp-inbin/build.ts 一致）：

```ts
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BunPlugin } from 'bun'

// playwright-core reads its own package.json / browsers.json at runtime via
// dynamic require(join(packageRoot, ...)). Bun's compiler bakes __dirname to
// the build machine's absolute path, so a compiled binary would always crash
// with `ResolveMessage: Cannot find module '<build-host>/.../package.json'`.
// This plugin inlines those two reads as build-time literals. It must be
// attached to every Bun.build call (dist and compile) — see build.ts.
const TARGET_FILES = /playwright-core[\\/]lib[\\/](coreBundle|package|serverRegistry)\.js$/
const IDENT = '[A-Za-z_$][\\w$]*(?:\\.default)?'
const PKG_RE = new RegExp(`require\\((${IDENT})\\.join\\(packageRoot, "package\\.json"\\)\\)`, 'g')
const BRW_RE = new RegExp(`require\\((${IDENT})\\.join\\(packageRoot, "browsers\\.json"\\)\\)`, 'g')

export type InlineResult = { contents: string; inlined: string[] }

export async function inlinePlaywrightDataReads(
  source: string,
  packageJsonText: string,
  browsersJsonText: string,
): Promise<InlineResult> {
  const inlined: string[] = []
  let contents = source.replace(PKG_RE, () => {
    inlined.push('package.json')
    return JSON.stringify(JSON.parse(packageJsonText))
  })
  contents = contents.replace(BRW_RE, () => {
    inlined.push('browsers.json')
    return browsersJsonText.trim()
  })
  return { contents, inlined }
}

export function createPlaywrightInlinePlugin(): BunPlugin {
  return {
    name: 'inline-playwright-data-reads',
    setup(build) {
      build.onLoad({ filter: TARGET_FILES }, async args => {
        const source = await readFile(args.path, 'utf8')
        const coreRoot = resolve(args.path, '..', '..')
        const packageJsonText = await readFile(resolve(coreRoot, 'package.json'), 'utf8')
        const browsersJsonPath = resolve(coreRoot, 'browsers.json')
        let browsersJsonText: string
        try {
          browsersJsonText = await readFile(browsersJsonPath, 'utf8')
        } catch {
          // Per spec §4.1: warn and inline an empty registry rather than
          // failing the build — the launch path does not read browsers.json.
          console.warn(
            `[playwrightInlinePlugin] ${browsersJsonPath} not found; inlining empty registry`,
          )
          browsersJsonText = '{}'
        }
        const { contents, inlined } = await inlinePlaywrightDataReads(
          source,
          packageJsonText,
          browsersJsonText,
        )
        if (inlined.length > 0) {
          console.log(`[playwrightInlinePlugin] ${args.path}: inlined ${inlined.join(', ')}`)
        }
        return { contents, loader: 'js' }
      })
    },
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test ./tests/playwrightInlinePlugin.test.ts 2>&1 | tail -3`
Expected: 3 pass（绊线断言同时验证了正则与真实 coreBundle.js 匹配）。

- [ ] **Step 5: 挂入 createBuildOptions**

`scripts/build.ts` 顶部 import 区加：

```ts
import { createPlaywrightInlinePlugin } from './playwrightInlinePlugin.ts'
```

`createBuildOptions` 返回类型 `Pick<Bun.BuildConfig, 'target' | 'format' | 'features' | 'define' | 'loader'>` 改为追加 `| 'plugins'`，返回对象中 `loader: {...}` 之后加：

```ts
    plugins: [createPlaywrightInlinePlugin()],
```

- [ ] **Step 6: 全量回归**

Run: `bun run test 2>&1 | tail -3`
Expected: 退出码 0，无 "Failed test files"。

Run: `bun run build 2>&1 | grep -c "playwrightInlinePlugin.*inlined"`
Expected: ≥1（dist 构建日志出现内联记录）。

- [ ] **Step 7: Commit**

```bash
git add scripts/playwrightInlinePlugin.ts scripts/build.ts tests/playwrightInlinePlugin.test.ts
git commit -m "Inline playwright-core data reads via build plugin

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: FLASH_SMOKE_TOOL 测试通道与 release 冒烟集成

**Files:**
- Modify: `src/main.tsx:874-879`（main() 开头）
- Modify: `scripts/build-binary.ts:216-233`（smokeTestBinary）

**Interfaces:**
- Consumes: `getAllBaseTools()`（`src/tools.ts`，main.tsx 已可达）；Task 1 的插件（compile 构建不再崩）。
- Produces: 冒烟协议——env `FLASH_SMOKE_TOOL=<tool name>` + `FLASH_SMOKE_INPUT=<JSON>` 激活；stdout 一行 `{"ok":true,"result":...}`（exit 0）或 `{"ok":false,"error":"..."}`（exit 1）；变量未设时行为不变。Task 4 负例验证依赖该协议。

- [ ] **Step 1: main() 开头加冒烟分支**

`src/main.tsx:874-879` 现有：

```ts
export async function main() {
  profileCheckpoint('main_function_start')

  // SECURITY: Prevent Windows from executing commands from current directory
```

在 `profileCheckpoint('main_function_start')` 之后、`NoDefaultCurrentDirectoryInExePath` 之前插入：

```ts
  // Test-only smoke channel: run a tool end-to-end inside the real binary
  // without model/UI. Activated exclusively by FLASH_SMOKE_TOOL; used by the
  // release smoke in scripts/build-binary.ts to catch bundled-runtime
  // regressions (e.g. playwright ResolveMessage) as build failures.
  const smokeToolName = process.env.FLASH_SMOKE_TOOL
  if (smokeToolName) {
    const { getAllBaseTools } = await import('./tools.js')
    const tools = await getAllBaseTools()
    const tool = tools.find(candidate => candidate?.name === smokeToolName)
    if (!tool) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: `tool not found: ${smokeToolName}` })}\n`,
      )
      process.exit(1)
    }
    try {
      const smokeInput = JSON.parse(process.env.FLASH_SMOKE_INPUT ?? '{}') as never
      const smokeResult = await tool.call(
        smokeInput,
        {} as never,
        async () => ({ behavior: 'allow' as const, updatedInput: smokeInput }),
        {} as never,
      )
      process.stdout.write(`${JSON.stringify({ ok: true, result: smokeResult })}\n`)
      process.exit(0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
      process.exit(1)
    }
  }
```

- [ ] **Step 2: 类型检查**

Run: `bun run typecheck 2>&1 | tail -3`
Expected: 无错误。若 `tool.call` 参数类型报错，按 `src/Tool.ts:379-384` 的 `ToolDef.call` 签名调整 cast（保持 4 个位置参数 + 可选 onProgress）。

- [ ] **Step 3: 源码形态冒烟通道冒烟**

Run:
```bash
FLASH_SMOKE_TOOL=NoSuchTool bun src/entrypoints/cli.tsx; echo "exit=$?"
```
Expected: stdout 一行 `{"ok":false,"error":"tool not found: NoSuchTool"}`，`exit=1`，且无 Ink UI 输出。

Run:
```bash
bun src/entrypoints/cli.tsx --version
```
Expected: `0.0.1 (flash)`（未设变量时行为不变）。

- [ ] **Step 4: release 冒烟集成**

`scripts/build-binary.ts` 的 `smokeTestBinary`（`:216-233`）在 `--help` 检查之后追加：

```ts
  // End-to-end tool smoke inside the real standalone binary (node_modules is
  // hidden by the caller). Catches bundled-runtime regressions like the
  // playwright-core ResolveMessage crash that `--version` cannot see.
  const smokeInput = JSON.stringify({
    action: 'browser_navigate',
    arguments: { url: 'data:text/html,<title>smoke-ok</title>' },
  })
  const smoke = spawnSync([binaryPath], {
    env: {
      ...env,
      FLASH_SMOKE_TOOL: 'WebBrowser',
      FLASH_SMOKE_INPUT: smokeInput,
    },
  })
  const smokeStdout = smoke.stdout.toString()
  const smokeLine = smokeStdout.split('\n').find(line => line.startsWith('{"ok":'))
  if (!smokeLine) {
    throw new Error(
      `Tool smoke produced no result line (exit=${smoke.exitCode}): ${smokeStdout.slice(0, 2000)}`,
    )
  }
  const smokeResult = JSON.parse(smokeLine) as { ok: boolean; error?: string }
  if (!smokeResult.ok) {
    const errorText = smokeResult.error ?? ''
    const browserMissing =
      /Executable doesn't exist/.test(errorText) ||
      (/chrome|chromium|channel/i.test(errorText) &&
        /not found|doesn't exist|No such file/i.test(errorText))
    if (browserMissing) {
      console.warn('Smoke skip: Chrome not available on this machine')
      return
    }
    throw new Error(`Tool smoke failed: ${errorText.slice(0, 2000)}`)
  }
  if (!smokeStdout.includes('smoke-ok')) {
    throw new Error('Tool smoke navigated but did not observe the expected page title')
  }
```

注意：`spawn` 已在该文件使用（检查其 import —— 文件顶部从哪来）；若只有 `spawn`（Bun.spawn 形式）没有 `spawnSync`，改用与既有 `--version` 检查相同的 `spawn(...)` + `assertCommandSucceeded` 风格：先 `await new Response(smoke.stdout).text()` 收集 stdout 再判定，复用既有辅助函数，不引入新 import 风格。

- [ ] **Step 5: 构建并验证正例**

Run: `bun run build:binary 2>&1 | tail -5`
Expected: 构建成功；冒烟日志无 "Smoke skip"（本机已装 Chrome）；无 Tool smoke failed。

- [ ] **Step 6: 验证负例（崩溃类必须挡发布）**

临时禁用插件再构建（验证失败语义）：

```bash
# 注释掉 plugins 行
sed -i.bak 's|plugins: \[createPlaywrightInlinePlugin()\],|// plugins disabled for negative test|' scripts/build.ts
bun run build:binary 2>&1 | tail -3
mv scripts/build.ts.bak scripts/build.ts   # 恢复（macOS/BSD sed -i.bak 通用）
```

Expected: 构建失败，错误含 `Tool smoke failed` 且 error 文本含 `Cannot find module`（ResolveMessage 类）。
完成后必须 `git status` 确认 scripts/build.ts 干净、`bun test ./tests/playwrightInlinePlugin.test.ts` 仍绿。

- [ ] **Step 7: 全量回归与提交**

Run: `bun run test 2>&1 | tail -3`
Expected: 全绿。

```bash
git add src/main.tsx scripts/build-binary.ts
git commit -m "Add FLASH_SMOKE_TOOL channel and release tool smoke gate

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: pty 交互启动冒烟测试

**Files:**
- Create: `tests/interactiveStartup.test.ts`

**Interfaces:**
- Consumes: `dist/main.js`（可能不存在——存在才测）；`script -q /dev/null`（macOS/Linux pty）。
- Produces: 启动冒烟契约——dist 形态 pty 启动 20s 内出现版本横幅 `flash v<semver>`，输出不含崩溃标记。

- [ ] **Step 1: 写测试**

创建 `tests/interactiveStartup.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const distMain = join(import.meta.dir, '..', 'dist', 'main.js')
const CRASH_MARKERS = ['ResolveMessage', 'MODULE_NOT_FOUND', 'Cannot find module']

describe.skipIf(
  process.platform === 'win32' || !existsSync(distMain),
  'needs a unix pty and a prior bun run build',
)('interactive startup smoke', () => {
  test('dist build renders the version banner without crashing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'flash-pty-home-'))
    const proc = Bun.spawn(
      ['script', '-q', '/dev/null', process.execPath, distMain],
      {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    let output = ''
    const timer = setTimeout(() => proc.kill(), 20_000)
    const decoder = new TextDecoder()
    const stdoutStream = proc.stdout.getReader()
    try {
      while (output.length < 64_000) {
        const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 500))
        const chunk = await Promise.race([stdoutStream.read(), timeout])
        if (chunk === 'timeout' || chunk.done) break
        output += decoder.decode(chunk.value, { stream: true })
        if (/flash v\d+\.\d+\.\d+/.test(output)) break
      }
    } finally {
      clearTimeout(timer)
      stdoutStream.releaseLock()
      proc.kill()
      await proc.exited
    }
    expect(output).toMatch(/flash v\d+\.\d+\.\d+/)
    for (const marker of CRASH_MARKERS) {
      expect(output).not.toContain(marker)
    }
  })
})
```

- [ ] **Step 2: 构建后运行确认通过**

Run: `bun run build 2>&1 | tail -1 && bun test ./tests/interactiveStartup.test.ts 2>&1 | tail -3`
Expected: 1 pass（横幅匹配、无崩溃标记）。

- [ ] **Step 3: 无 dist 时确认 skip**

Run: `mv dist/main.js /tmp/main.js.bak && bun test ./tests/interactiveStartup.test.ts 2>&1 | tail -3; mv /tmp/main.js.bak dist/main.js`
Expected: skipped（非 fail）。

- [ ] **Step 4: 全量回归与提交**

Run: `bun run test 2>&1 | tail -3`
Expected: 全绿。

```bash
git add tests/interactiveStartup.test.ts
git commit -m "Add pty interactive startup smoke test

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 契约文档、manifest 登记与端到端验收

**Files:**
- Modify: `docs/external-stubs/contracts/open-chrome.md`
- Modify: `docs/architecture/coverage/manifest.yaml`
- Create: `docs/architecture/coverage/webbrowser-bundled-support.yaml`
- 无代码修改（验收任务；发现问题回对应任务修复后重跑）

**Interfaces:**
- Consumes: Task 1-3 全部产物。
- Produces: 规格第 6 节验收结果执行记录。

- [ ] **Step 1: 契约文档修订**

`docs/external-stubs/contracts/open-chrome.md` 末尾追加一节（保持该文档既有中文风格）：

```markdown
## N. bundled 形态支持（2026-11-16）

bundled/独立二进制下 isolated 浏览器路径（WebBrowser 工具）已支持，实现方式为构建插件
`scripts/playwrightInlinePlugin.ts` 在编译期内联 playwright-core 的 package.json/browsers.json
运行时读取（Bun 编译会把 `__dirname` 烘焙为构建机绝对路径，不内联则必崩 ResolveMessage）。

已知限制：
- 需要用户机器安装 Google Chrome（`channel: 'chrome'`）；未安装时工具调用报错，属预期行为。
- chrome-cdp 真实 Chrome 路径仍走 Node sidecar（Bun ws 握手限制，见上文），bundled 下不可用，
  由 `chromeWiringBundledAction` 前置分流（warn/skip）。
- `webp_codec.wasm`（截图 diff/图像比对）与 playwright CLI（install/trace-viewer）不在支持范围。
- playwright 升级需确认 `tests/playwrightInlinePlugin.test.ts` 绊线仍通过。

release 构建通过 `FLASH_SMOKE_TOOL` 冒烟在真实二进制内端到端验证该路径（崩溃类错误会挡发布；
Chrome 缺失仅警告跳过）。
```

（`N` 取文档现有最大节号 +1，插入前先看文档节号。）

- [ ] **Step 2: manifest 登记**

`docs/architecture/coverage/manifest.yaml` 的 `specs:` 列表末尾追加：

```yaml
  - id: webbrowser-bundled-support
    spec: docs/superpowers/specs/2026-11-16-webbrowser-bundled-support-design.md
    coverage: docs/architecture/coverage/webbrowser-bundled-support.yaml
    batch: 5
    status: draft
```

创建 `docs/architecture/coverage/webbrowser-bundled-support.yaml`（格式对齐 build-feature-profile.yaml）：

```yaml
schema_version: 1
spec_id: webbrowser-bundled-support
spec: ../../superpowers/specs/2026-11-16-webbrowser-bundled-support-design.md
status: draft
groups:
  - id: build-plugin
    kind: script
    section: 4
    summary: playwright-core 数据读取编译期内联构建插件
    files:
      - scripts/playwrightInlinePlugin.ts
      - scripts/build.ts
  - id: smoke-channel
    kind: source
    section: 4
    summary: FLASH_SMOKE_TOOL 测试通道与 release 工具冒烟
    files:
      - src/main.tsx
      - scripts/build-binary.ts
  - id: tests
    kind: test
    section: 4
    summary: 插件绊线/单元测试与 pty 交互启动冒烟
    files:
      - tests/playwrightInlinePlugin.test.ts
      - tests/interactiveStartup.test.ts
```

Run: `bun scripts/check-design-docs.ts 2>&1 | tail -3`
Expected: 0 errors（warnings 与现状一致即可）。

- [ ] **Step 3: bundled 端到端验收**

Run: `bun run build:binary 2>&1 | tail -3`，记录产物路径 `$BIN`（build/release/ 下 flash-v*-darwin-arm64 之外若有多平台产物，用本机 target 的那个）。

Run: `strings "$BIN" | grep -c "$HOME/GolandProjects/claude-code/node_modules"`（或构建机绝对路径特征 `/Users/runner/work/flash/flash`）
Expected: 0（无烘焙构建机路径）。

Run: `FLASH_SMOKE_TOOL=WebBrowser FLASH_SMOKE_INPUT='{"action":"browser_navigate","arguments":{"url":"data:text/html,<title>e2e-ok</title>"}}' "$BIN"; echo "exit=$?"`
Expected: stdout 含 `"ok":true` 与 `e2e-ok`，`exit=0`。

- [ ] **Step 4: dist 端到端验收**

Run: `FLASH_SMOKE_TOOL=WebBrowser FLASH_SMOKE_INPUT='{"action":"browser_navigate","arguments":{"url":"data:text/html,<title>e2e-dist-ok</title>"}}' bun dist/main.js; echo "exit=$?"`
Expected: 同上（`e2e-dist-ok`）。

Run: `bun dist/main.js --version`
Expected: `0.0.1 (flash)`。

- [ ] **Step 5: 全量回归与结果记录**

Run: `bun run test 2>&1 | tail -3`
Expected: 全绿。

全部通过则任务结束（无提交，文档提交见 Step 6）；有失败回对应任务修复后重跑。

- [ ] **Step 6: 提交文档**

```bash
git add docs/external-stubs/contracts/open-chrome.md docs/architecture/coverage/manifest.yaml docs/architecture/coverage/webbrowser-bundled-support.yaml
git commit -m "Register bundled WebBrowser support in contract doc and coverage manifest

Co-Authored-By: Claude <noreply@anthropic.com>"
```
