# Playwright Chrome Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every isolated Playwright browser is disposed on every connection termination path without closing attached CDP Chrome.

**Architecture:** Introduce explicit per-generation browser ownership around the public MCP `contextGetter`, then coordinate client/server/browser disposal through a retryable close registry. Keep real CDP as a separate detach-only path and prove process-level behavior with real browser fixtures.

**Tech Stack:** Bun 1.3+, TypeScript, Playwright, `@playwright/mcp@0.0.85`, MCP SDK, Bun test, POSIX process groups, existing `tree-kill` and cleanup registry.

## Global Constraints

- Design reference: `docs/superpowers/specs/2026-11-13-playwright-chrome-lifecycle-design.md`.
- Use public Playwright/MCP APIs; do not patch `node_modules` or read private backend fields.
- Keep `createIsolatedBrowserConfig()` and WebBrowser tool schemas compatible.
- Close only browsers created by the current isolated generation. Real CDP Chrome must remain alive with its context, tabs and cookies.
- Do not bulk-kill existing processes or use process-name/profile-pattern matching for cleanup.
- Declare Playwright at the exact version already installed through MCP; do not upgrade browser dependencies.
- Keep Playwright imports type-only at module top level and dynamically load runtimes only in actual browser connection paths, so CLI help does not resolve Playwright package metadata.
- Use exact PID/profile assertions rather than requiring the machine-wide Chrome count to be zero.
- Do not record historical execution results in the spec or plan.

## 实施理由与步骤依据

1. **先写进程级失败测试**：MCP `listTools()` 成功或 action 返回成功并不能证明 browser 已退出。先建立 PID/profile 断言，才能区分 transport 关闭与实际进程回收。
2. **再实现连接所有权**：browser disposer 必须依附于创建它的 connection generation，否则并发重开会引入误关新资源的风险。
3. **随后统一所有关闭入口**：工具、直接 transport close、shutdown 和 idle 使用同一所有权层，避免每个调用方各写一套清理。
4. **最后处理 CDP 与测试 fixture**：真实 CDP 的 detach 语义与 isolated 不同，测试进程树清理也必须独立于生产 browser 所有权验证。
5. **以多轮和全量验证收尾**：单次成功无法暴露代际竞态；重复运行用于发现新增残留，全量测试用于发现其他工具枚举和 CLI/SDK 回归。
6. **回滚以功能为单位**：所有权、关闭入口、测试和直接依赖声明相互关联，不能只删除 disposer 而保留自定义 context factory，否则会引入更隐蔽的泄漏。

## File Structure

- Modify `src/external-stubs/claude-for-chrome-mcp.ts`: isolated browser ownership, close registry, idle/retry semantics, CDP upstream shutdown, and lazy Playwright runtime loading for standalone CLI help.
- Modify `src/tools/WebBrowserTool/WebBrowserTool.ts`: expected-client close and error preservation.
- Modify `tests/openBackends.test.ts`: process-level regressions, direct client close, CDP preservation and fixture process-tree cleanup.
- Modify `package.json` and `bun.lock`: direct Playwright dependency at the installed MCP version.
- Create `docs/superpowers/specs/2026-11-13-playwright-chrome-lifecycle-design.md`: design rationale and behavioral contract.
- Create `docs/superpowers/plans/2026-11-13-playwright-chrome-lifecycle.md`: executable TDD sequence and rollback plan.

---

### Task 1: Add Failing Process-Lifecycle Regression Tests

**Files:**
- Modify: `tests/openBackends.test.ts`

**Interfaces:**
- Produces: isolated root snapshot `{ pid: number; profile: string }` and exact root-exit assertions.
- Consumes: real `getOpenBrowserClient()`, `closeOpenBrowserClient()` and `WebBrowserTool.call()`.

- [ ] **Step 1: Add root discovery that excludes Chrome helpers**

Implement POSIX process snapshots that require both `playwright_chromiumdev_profile-` and `--remote-debugging-pipe`, and exclude `--type=` helper processes:

```ts
type IsolatedBrowserRoot = { pid: number; profile: string }

async function snapshotIsolatedBrowserRoots(): Promise<IsolatedBrowserRoot[]> {
  if (process.platform === 'win32') return []
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='])
  // Parse only browser roots with both markers; helpers with --type= are excluded.
  // Return actual parsed entries rather than a machine-wide process count.
  return parseRoots(stdout)
}
```

Do not fail because another pre-existing browser is present. Compare the before/after sets and identify only the root introduced by the current test.

- [ ] **Step 2: Assert actual root exit after isolated close**

Add the regression around the existing isolated/attached lifecycle test:

```ts
const before = await snapshotIsolatedBrowserRoots()
await WebBrowserTool.call(
  { action: 'browser_navigate', arguments: { url: 'about:blank' } },
  {} as ToolUseContext,
)
const root = await findNewIsolatedBrowserRoot(before)
await closeOpenBrowserClient()
await expectIsolatedBrowserRootExited(root)
```

The exit assertion may poll the exact PID with `ps -p <pid> -o command=` and must verify the profile identity. It must not kill the root to make the test pass.

- [ ] **Step 3: Add direct client-close and browser_close cases**

Use a reopened client for direct transport closure:

```ts
await nextIsolated.close()
await closeOpenBrowserClient()
await expectIsolatedBrowserRootExited(reopenedRoot)
```

Keep the existing `browser_close` action, but assert its root is gone immediately after the tool returns, before `afterEach` runs.

- [ ] **Step 4: Run the tests and verify RED**

Run:

```bash
bun run test tests/openBackends.test.ts
```

Expected: FAIL because MCP transport/server closure leaves the owned isolated Chrome root alive. Do not weaken the assertion to client object identity or a successful `listTools()` result.

---

### Task 2: Implement Per-Generation Browser Ownership

**Files:**
- Modify: `src/external-stubs/claude-for-chrome-mcp.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Test: `tests/openBackends.test.ts`

**Interfaces:**
- Consumes: `createConnection(config, contextGetter)` and public `chromium.launch()`.
- Produces: per-generation `Browser` tracking and an owned disposer consumed by `ManagedConnection.close()`.

- [ ] **Step 1: Declare the exact direct Playwright dependency**

Use the same version already installed by `@playwright/mcp`, then update the lockfile without upgrading:

```bash
bun install
bun install --frozen-lockfile
```

The version must match `@playwright/mcp/package.json`; no new browser channel or version range is introduced.

- [ ] **Step 2: Supply an owned context through the public MCP API**

Create each browser inside the context getter and retain it by generation:

```ts
const browsers = new Set<Browser>()
const pendingContexts = new Set<Promise<BrowserContext>>()
let closing = false

const contextGetter = (): Promise<BrowserContext> => {
  if (closing) return Promise.reject(new Error('Isolated Chrome connection is closing'))
  const context = (async () => {
    const browser = await chromium.launch({
      channel: 'chrome',
      chromiumSandbox: true,
      ...config.browser?.launchOptions,
      handleSIGINT: false,
      handleSIGTERM: false,
    })
    if (closing) {
      await browser.close()
      throw new Error('Isolated Chrome connection is closing')
    }
    browsers.add(browser)
    return browser.newContext(config.browser?.contextOptions)
  })()
  pendingContexts.add(context)
  return context.finally(() => pendingContexts.delete(context))
}
```

Pass `{ ...config, browser: { ...config.browser, isolated: false } }` plus `contextGetter` to `createConnection()`. Do not memoize a resolved or rejected context: MCP backend recreation must be able to launch a replacement.

- [ ] **Step 3: Dispose launched browsers on every setup failure**

Wrap `createConnection`, `server.connect` and client initialization so `dispose()` runs even when setup fails after launch. The disposer first closes available browsers, then waits for pending contexts and closes any late arrivals:

```ts
const dispose = async (): Promise<void> => {
  closing = true
  const errors = await closeOwnedBrowsers()
  await Promise.allSettled([...pendingContexts])
  errors.push(...(await closeOwnedBrowsers()))
  if (errors.length) throw new AggregateError(errors, 'Failed to close isolated Chrome')
}
```

If `newContext()` fails, close that browser before propagating the error. A rejected initialization Promise must not poison later close/reopen calls.

- [ ] **Step 4: Make managed close ordered, bounded and retryable**

Extend `connectInMemory()` with an optional disposer. Close client, server and owned browser in order, using a deadline for each step and attempting all steps before reporting errors. Cache only an in-flight/successful close; a rejected close must be reset so a later caller can retry.

- [ ] **Step 5: Run the focused lifecycle tests**

Run:

```bash
bun run typecheck
bun run test tests/openBackends.test.ts
```

Expected: the normal close and initialization cleanup cases PASS, and no newly created root remains after the test file.

---

### Task 3: Coordinate Tool, Transport, Shutdown and Idle Lifecycles

**Files:**
- Modify: `src/external-stubs/claude-for-chrome-mcp.ts`
- Modify: `src/tools/WebBrowserTool/WebBrowserTool.ts`
- Test: `tests/openBackends.test.ts`

**Interfaces:**
- Produces: `closeOpenBrowserClient(expectedClient?: Client): Promise<void>` and a close registry keyed by connection Promise.
- Consumes: existing `registerCleanup()` and direct `Client.close()` events.

- [ ] **Step 1: Register and share every connection close**

Use a map so concurrent callers share the same close and global cleanup waits for every generation:

```ts
const isolatedCloses = new Map<Promise<ManagedConnection>, Promise<void>>()

async function closeOpenBrowserClient(expectedClient?: Client): Promise<void> {
  const pending = isolatedConnection
  if (pending) {
    if (expectedClient) {
      const connection = await pending.promise.catch(() => undefined)
      if (connection?.client !== expectedClient || isolatedConnection !== pending) return
    }
    isolatedConnection = undefined
    ++isolatedGeneration
    await closeIsolatedConnection(pending.promise)
    return
  }
  await closeResources(
    [...isolatedCloses.keys()].map(pending => () => closeIsolatedConnection(pending)),
  )
}
```

Failed close entries remain retryable. Rejected initialization entries are treated as already-failed setup, not cached forever as a close failure.

- [ ] **Step 2: Route transport-initiated close through the same registry**

After creating the managed connection:

```ts
connection.client.onclose = () => {
  if (isolatedConnection?.generation === generation) {
    isolatedConnection = undefined
    ++isolatedGeneration
  }
  void closeIsolatedConnection(Promise.resolve(connection)).catch(() => undefined)
}
```

The tracked close gives shutdown a way to await the disposal; the rejection handler prevents an unhandled background rejection.

- [ ] **Step 3: Make browser_close expected-client aware**

In `WebBrowserTool.call()`, capture the client used by the action and pass it to close. Preserve both errors if action and cleanup fail:

```ts
try {
  result = await client.callTool({ name: action, arguments: args })
} catch (error) {
  if (action === 'browser_close') {
    try {
      await closeOpenBrowserClient(client)
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Browser action and cleanup both failed')
    }
  }
  throw error
}
if (action === 'browser_close') await closeOpenBrowserClient(client)
```

- [ ] **Step 4: Preserve idle and graceful-shutdown behavior**

Register `closeOpenBrowserClient` once through the cleanup registry. Give each browser an idle timer, refresh it around actual `client.callTool()` activity, and clear it on disconnect/disposal. A disconnected browser must be removed from the owned set so the next backend recreation launches a fresh context.

- [ ] **Step 5: Verify direct, concurrent and repeated close**

Run the focused file repeatedly and compare exact root sets:

```bash
bun run test tests/openBackends.test.ts
```

Expected: direct `client.close()`, tool close, repeated close and reopen all PASS; the old generation cannot close the replacement and no new root survives.

---

### Task 4: Separate CDP Detach from Fake Chrome Process-Tree Cleanup

**Files:**
- Modify: `src/external-stubs/claude-for-chrome-mcp.ts`
- Modify: `tests/openBackends.test.ts`

**Interfaces:**
- Consumes: CDP upstream client/server close, POSIX process groups and Windows `tree-kill`.
- Produces: awaited upstream detach and bounded Fake Chrome TERM→KILL cleanup.

- [ ] **Step 1: Await and retry CDP upstream cleanup**

Replace fire-and-forget upstream closure with a cached Promise that resets after failure. `proxy.close()` awaits both its original close and the shared upstream close. Keep `browser_close` disabled for real CDP and never add an owned-browser disposer to this path.

- [ ] **Step 2: Strengthen attached-Chrome preservation assertions**

Record the Fake Chrome PID and assert it remains alive after rejected `browser_close`, detach and reconnect. Retain the existing default-context, tab and cookie assertions; these distinguish correct detach from accidentally closing all Chrome.

- [ ] **Step 3: Implement owned process-tree termination**

Spawn Fake Chrome detached only on POSIX. Signal its exact negative process-group ID; on Windows use `tree-kill`:

```ts
if (process.platform === 'win32') {
  await treeKillWithTimeout(child.pid!, 'SIGTERM', 5_000)
} else {
  process.kill(-child.pid!, 'SIGTERM')
}
```

Wait for the process group rather than only the root's `close` event, escalate to SIGKILL after the deadline, and delete the profile only after tree exit. A missing spawn PID is already a no-process case and must not prevent profile deletion.

- [ ] **Step 4: Make teardown exhaustive and interruption-safe**

Attempt client, child, profile and fixture cleanup even when an earlier step rejects, then aggregate errors. Track live Fake Chrome children in a `Set`; a test-process `exit` hook sends SIGKILL only to still-owned POSIX groups. Non-OK CDP startup responses must also set the final startup error.

- [ ] **Step 5: Run backend and type checks**

Run:

```bash
bun run typecheck
bun run test tests/openBackends.test.ts
```

Expected: attached Chrome survives while isolated/Fake resources are reclaimed; startup and teardown failures remain visible instead of being swallowed.

---

### Task 5: Complete Acceptance, Documentation and Rollback Review

**Files:**
- Create: `docs/superpowers/specs/2026-11-13-playwright-chrome-lifecycle-design.md`
- Create: `docs/superpowers/plans/2026-11-13-playwright-chrome-lifecycle.md`

- [ ] **Step 1: Verify the Superpowers documents independently explain the feature**

Confirm the spec covers root cause, why this architecture, rejected alternatives, goals/non-goals, interfaces, data flow, failure semantics and acceptance criteria. Confirm this plan explains implementation ordering and includes exact paths, TDD steps, commands, migration and rollback. Do not add commit mappings or historical test/CI/live results.

- [ ] **Step 2: Run the complete acceptance sequence**

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test tests/openBackends.test.ts
bun run test
bun dist/main.js --version
bun dist/main.js --help
bun -e "const sdk = await import('./dist/sdk.mjs'); if (typeof sdk.query !== 'function' || typeof sdk.createSdkMcpServer !== 'function') throw new Error('Invalid SDK exports')"
git diff --check
```

Also run the backend test with an empty Playwright browser cache and repeat it to check for late or duplicate creation. Compare exact before/after root sets rather than terminating any surviving process to force success.

- [ ] **Step 3: Review migration behavior**

No user data or profile migration is required. The direct Playwright declaration must remain lockfile-compatible with MCP. Existing isolated contexts remain ephemeral; no session state is moved to the attached CDP browser.

- [ ] **Step 4: Review rollback behavior**

Rollback must revert the context factory, close registry, tool-close changes, upstream sequencing, direct dependency declaration and test changes as one coherent unit, followed by `bun install --frozen-lockfile`. Restoring the previous MCP-only factory restores its known disposal limitation, so the process-level regressions should remain as evidence of that defect rather than being deleted or skipped.

If a production hotfix must stop new isolated launches before a complete rollback, disable the existing `WEB_BROWSER_TOOL` registration through the normal external feature build rather than killing user browsers or leaving a partially owned context implementation. Real CDP detach behavior must remain unchanged.

- [ ] **Step 5: Commit the documentation**

```bash
git add docs/superpowers/specs/2026-11-13-playwright-chrome-lifecycle-design.md docs/superpowers/plans/2026-11-13-playwright-chrome-lifecycle.md
git commit -m "Document Playwright Chrome lifecycle design"
```
