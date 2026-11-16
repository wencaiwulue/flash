# Chrome 集成 bundled 前置分流实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bundled 独立二进制下 Chrome 集成在接线段前置分流（显式请求→警告、默认配置→静默跳过），使 CLI 在任何 chrome 配置下都能正常启动，对齐上游 Claude Code 的三级结构。

**Architecture:** 唯一新增逻辑是 `setup.ts` 里的纯函数 `chromeWiringBundledAction(enable, bundled, explicit) → 'warn'|'skip'|'none'`（TDD 全矩阵单测）；`main.tsx` 接线段消费它并置 `enableClaudeInChrome = false`，让 onboarding/setup 下游自动继承；通知 hook 与 `/chrome` 面板各自加 bundled 守卫/原因行。不删上游同款的 catch 硬退出，不改 `shouldEnableClaudeInChrome`。

**Tech Stack:** Bun 1.3+、TypeScript、`bun:test`、React/Ink（仅面板 JSX）。

## Global Constraints

来自已批准规格 `docs/superpowers/specs/2026-11-15-chrome-bundled-wiring-design.md`，每个任务隐式继承：

- `shouldEnableClaudeInChrome` 签名与逻辑**零改动**。
- `src/main.tsx:2370` 的 catch `process.exit(1)` **保留不动**（上游同款，语义为"意外失败"）。
- 警告文案逐字使用：`Warning: Open Chrome CDP is not available in standalone builds; continuing without browser tools. Run from source to use it.`（单行，含结尾换行）。
- debug 文案逐字使用：`[Claude in Chrome] Skipping chrome wiring: not available in standalone builds`。
- `explicit` 定义：`chromeFlag === true || isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)`。
- 不修改 `src/external-stubs/claude-for-chrome-mcp.ts`、`~/.claude.json`、sidecar 相关任何文件。
- 提交信息以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。
- 工作分支：`chrome-bundled-wiring`（从 main 新建）。

## 实施理由与步骤依据

依赖顺序：先落可单测的决策纯函数（Task 1，TDD），因为 main.tsx/hook/面板三个消费者都依赖它的确切签名与返回值；然后 main.tsx 接线段（Task 2，核心行为变更，靠 typecheck + Task 4 集成验证兜底——main.tsx 六千行无单测基建）；hook 与面板（Task 3）是独立 UI 适配，可并行但顺序执行避免冲突；最后 pty 集成验收（Task 4）覆盖单测无法触及的 bundled 运行时（测试进程 `Bun.main` 是真实路径，恒为非 bundled，所以 bundled 行为只能人工/pty 验证）。

## File Structure

- Modify: `src/utils/claudeInChrome/setup.ts` — 文件末尾追加 `ChromeWiringAction` 类型与 `chromeWiringBundledAction`
- Create: `tests/claudeInChromeWiring.test.ts` — 8 组合决策矩阵单测
- Modify: `src/main.tsx:2338-2340` — 接线段前置分流；`:212-215` 附近 import 区加 `chromeWiringBundledAction`
- Modify: `src/hooks/useChromeExtensionNotification.tsx:12-16` — bundled 早退
- Modify: `src/commands/chrome/chrome.tsx` — `isBundled` 原因行 + Select 条件 + import
- 不修改：`src/external-stubs/**`、`src/utils/claudeInChrome/browserTools.ts`、`.github/**`

---

### Task 1: `chromeWiringBundledAction` 决策纯函数（TDD）

**Files:**
- Create: `tests/claudeInChromeWiring.test.ts`
- Modify: `src/utils/claudeInChrome/setup.ts`（文件末尾追加）

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces: `export type ChromeWiringAction = 'warn' | 'skip' | 'none'` 与 `export function chromeWiringBundledAction(enable: boolean, bundled: boolean, explicit: boolean): ChromeWiringAction`。Task 2 按 `chromeWiringBundledAction` 名字、三参数顺序、三返回值消费。

- [ ] **Step 1: 写失败测试**

创建 `tests/claudeInChromeWiring.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { chromeWiringBundledAction } from '../src/utils/claudeInChrome/setup.js'

describe('chromeWiringBundledAction', () => {
  test('non-bundled always wires (none)', () => {
    expect(chromeWiringBundledAction(true, false, true)).toBe('none')
    expect(chromeWiringBundledAction(true, false, false)).toBe('none')
    expect(chromeWiringBundledAction(false, false, true)).toBe('none')
    expect(chromeWiringBundledAction(false, false, false)).toBe('none')
  })

  test('bundled + not enabled = none', () => {
    expect(chromeWiringBundledAction(false, true, true)).toBe('none')
    expect(chromeWiringBundledAction(false, true, false)).toBe('none')
  })

  test('bundled + enabled + explicit = warn', () => {
    expect(chromeWiringBundledAction(true, true, true)).toBe('warn')
  })

  test('bundled + enabled + default-config = skip', () => {
    expect(chromeWiringBundledAction(true, true, false)).toBe('skip')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/claudeInChromeWiring.test.ts 2>&1 | tail -5`
Expected: FAIL — `chromeWiringBundledAction` 未导出（导入报错/undefined is not a function）。

- [ ] **Step 3: 最小实现**

`src/utils/claudeInChrome/setup.ts` 文件末尾追加：

```ts
export type ChromeWiringAction = 'warn' | 'skip' | 'none'

/**
 * Pre-flight gating for the chrome wiring section in main.tsx, mirroring
 * upstream's skip-before-setup tiers: known-doomed environments must never
 * reach the setup try/catch, whose hard exit is reserved for unexpected
 * failures. Explicit requests warn; default-config enables skip silently.
 */
export function chromeWiringBundledAction(
  enable: boolean,
  bundled: boolean,
  explicit: boolean,
): ChromeWiringAction {
  if (!enable || !bundled) return 'none'
  return explicit ? 'warn' : 'skip'
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/claudeInChromeWiring.test.ts 2>&1 | tail -3`
Expected: 4 pass。

- [ ] **Step 5: Commit**

```bash
git add tests/claudeInChromeWiring.test.ts src/utils/claudeInChrome/setup.ts
git commit -m "Add chromeWiringBundledAction gating decision

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: main.tsx 接线段前置分流

**Files:**
- Modify: `src/main.tsx:2338-2340`（接线段）
- Modify: `src/main.tsx:212-215`（setup.js import 块）

**Interfaces:**
- Consumes: Task 1 的 `chromeWiringBundledAction(enable, bundled, explicit): ChromeWiringAction`；既有 `isInBundledMode`（`main.tsx:419` 已导入）、`isEnvTruthy`（`main.tsx:222` 已导入）、`logForDebugging`（main.tsx 已用）。
- Produces: 接线段之后 `enableClaudeInChrome` 为 `let` 变量，bundled 分流后为 `false`；下游消费者（setup 分支 `:2342`、`showSetupScreens` 调用 `:3253`）零改动继承。Task 3/4 依赖"bundled 下 onboarding 不弹、setup 不进入"这一行为。

- [ ] **Step 1: 修改 import**

`src/main.tsx:212-215` 现有：

```ts
  setupClaudeInChrome,
  shouldEnableClaudeInChrome,
```

在同一段 setup.js import 块中加入 `chromeWiringBundledAction`（保持字母序，置于 `setupClaudeInChrome` 之前）：

```ts
  chromeWiringBundledAction,
  setupClaudeInChrome,
  shouldEnableClaudeInChrome,
```

- [ ] **Step 2: 改写接线段**

`src/main.tsx:2338-2340` 现有：

```ts
      const enableClaudeInChrome = shouldEnableClaudeInChrome(chromeOpts.chrome)
      const autoEnableClaudeInChrome =
        !enableClaudeInChrome && (await shouldAutoEnableClaudeInChrome())
```

改为（`autoEnableClaudeInChrome` 行保持在分流之后、原顺序不变；stderr 输出用 `process.stderr.write` + 结尾换行，与紧邻的 `:2328` policy 警告同款惯例）：

```ts
      let enableClaudeInChrome = shouldEnableClaudeInChrome(chromeOpts.chrome)
      const chromeWiringAction = chromeWiringBundledAction(
        enableClaudeInChrome,
        isInBundledMode(),
        chromeOpts.chrome === true ||
          isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC),
      )
      if (chromeWiringAction === 'warn') {
        process.stderr.write(
          'Warning: Open Chrome CDP is not available in standalone builds; ' +
            'continuing without browser tools. Run from source to use it.\n',
        )
      } else if (chromeWiringAction === 'skip') {
        logForDebugging(
          '[Claude in Chrome] Skipping chrome wiring: not available in standalone builds',
        )
      }
      if (chromeWiringAction !== 'none') enableClaudeInChrome = false
      const autoEnableClaudeInChrome =
        !enableClaudeInChrome && (await shouldAutoEnableClaudeInChrome())
```

注意：stderr 输出统一用 `process.stderr.write('...\n')`（与紧邻的 `:2328` policy 警告同款惯例），文案逐字使用 Global Constraints 中的版本。

- [ ] **Step 3: 类型检查与回归**

Run: `bun run typecheck 2>&1 | tail -3`
Expected: 无错误。

Run: `bun test tests/claudeInChromeWiring.test.ts 2>&1 | tail -3`
Expected: 4 pass（消费端未破坏导出）。

- [ ] **Step 4: Commit**

```bash
git add src/main.tsx
git commit -m "Pre-flight skip chrome wiring in bundled builds

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 通知 hook 与 /chrome 面板适配

**Files:**
- Modify: `src/hooks/useChromeExtensionNotification.tsx:12-16`
- Modify: `src/commands/chrome/chrome.tsx`（import 区、`ClaudeInChromeMenu` 内、`Select` 条件）

**Interfaces:**
- Consumes: 既有 `isInBundledMode`（`src/utils/bundledMode.js`）。
- Produces: 行为契约——bundled 下启动通知不显示；`/chrome` 面板显示 `Open Chrome CDP is not available in standalone builds.` 错误行且无 Select 菜单。Task 4 的 pty 验收依赖该契约。

- [ ] **Step 1: hook bundled 早退**

`src/hooks/useChromeExtensionNotification.tsx:12-16` 现有：

```ts
export function useChromeExtensionNotification(): void {
  useStartupNotification(async () => {
    if (!shouldEnableClaudeInChrome(getChromeFlag())) return null
```

改为：

```ts
import { isInBundledMode } from '../utils/bundledMode.js'
import { shouldEnableClaudeInChrome } from '../utils/claudeInChrome/setup.js'
```

```ts
export function useChromeExtensionNotification(): void {
  useStartupNotification(async () => {
    if (isInBundledMode()) return null
    if (!shouldEnableClaudeInChrome(getChromeFlag())) return null
```

- [ ] **Step 2: /chrome 面板原因行与菜单条件**

`src/commands/chrome/chrome.tsx` import 区（`:5` 附近）加：

```ts
import { isInBundledMode } from '../../utils/bundledMode.js'
```

`ClaudeInChromeMenu` 组件体开头（`const mcpClients = ...` 之前）加：

```ts
  const isBundled = isInBundledMode()
```

紧随 `{isWSL && (...WSL error line...)}`（`:100-104` 附近）之后加：

```tsx
        {isBundled && (
          <Text color="error">
            Open Chrome CDP is not available in standalone builds.
          </Text>
        )}
```

`Select` 渲染条件 `{!isWSL && (` 改为 `{!isWSL && !isBundled && (`。

- [ ] **Step 3: 类型检查**

Run: `bun run typecheck 2>&1 | tail -3`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useChromeExtensionNotification.tsx src/commands/chrome/chrome.tsx
git commit -m "Gate chrome notification and /chrome panel in bundled builds

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: pty 集成验收与回归

**Files:**
- 无代码修改（验收任务；发现问题回对应任务修复后重跑）

**Interfaces:**
- Consumes: Task 1-3 全部产物。
- Produces: 规格第 6 节验收结果的执行记录。

- [ ] **Step 1: 全量回归**

Run: `bun run test 2>&1 | tail -3`
Expected: 全绿（运行器逐文件执行，最后无 "Failed test files" 输出且退出码 0）。

- [ ] **Step 2: 构建 bundled 二进制**

Run: `bun run build:binary 2>&1 | tail -3`
Expected: 产出独立二进制（默认输出目录 `build/release/`，`build-binary.ts:351`；以命令输出中的实际路径为准，记录备用）。

- [ ] **Step 3: pty 三场景验证（每场景用 `script -q /dev/null <cmd>` 分配伪终端，30 秒后 kill）**

场景 A（配置默认启用，用户机器 `~/.claude.json` 已含 `claudeInChromeDefaultEnabled: true`；`$BIN` 为 Step 2 记录的二进制路径）：

```bash
script -q /dev/null "$BIN" > /tmp/pty-a.out 2>&1 & sleep 25; pkill -f 'claude-code'
grep -c "Failed to run with Claude in Chrome" /tmp/pty-a.out   # 预期 0
grep -c "Warning: Open Chrome CDP" /tmp/pty-a.out              # 预期 0（静默跳过）
```

场景 B（显式 `--chrome`）：

```bash
script -q /dev/null "$BIN" --chrome > /tmp/pty-b.out 2>&1 & sleep 25; pkill -f 'claude-code'
grep -c "Warning: Open Chrome CDP is not available in standalone builds" /tmp/pty-b.out   # 预期 1
grep -c "Failed to run with Claude in Chrome" /tmp/pty-b.out                              # 预期 0
```

场景 C（`/chrome` 面板）：场景 A 启动的会话中手动输入 `/chrome` 不便自动化，改为源码方式面板冒烟：

```bash
bun run typecheck && grep -n "not available in standalone builds" src/commands/chrome/chrome.tsx   # 面板文案存在
```

面板渲染的最终确认在真实交互会话中人工执行一次（启动 bundled 二进制 → 输入 `/chrome` → 确认错误行显示、无菜单）。

- [ ] **Step 4: 非 bundled 回归确认**

Run: `bun run build 2>&1 | tail -2 && bun dist/main.js --version`
Expected: 版本输出正常（如 `1.0.1 (flash)`）。

- [ ] **Step 5: 结果记录**

若全部通过：无提交，任务结束。若有失败：修复后 `git add -A && git commit -m "Fix chrome bundled wiring acceptance findings

Co-Authored-By: Claude <noreply@anthropic.com>"` 并重跑 Step 1-4。
