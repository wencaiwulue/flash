# Design Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 69 个子系统审计发现分批转化为可验证的代码、测试、coverage 和 spec 整改，优先处理两个 P1，再解决状态隔离、生命周期、协议契约和剩余结构问题。

**Architecture:** 每个阶段独立分支、独立 PR、独立回滚。先复现并修复 CI 基线，再按“契约确认 → 失败测试 → 最小实现 → 增量审查 → 整改台账”的顺序推进。原始发现和统计只追加整改证据，不重写历史；默认增量审计，只有核心模型大改或广泛漂移才重新全审。

**Tech Stack:** Bun 1.3+、TypeScript strict、React/Ink、Bun test、proper-lockfile、Playwright、YAML、Markdown、GitHub Actions。

## Global Constraints

- 基线：`origin/main` 已包含 PR #16 的 69 子系统审计和三视图。当前工作分支为 `design-remediation`；每个阶段从最新 `origin/main` 新建独立分支。
- 所有代码行为变更先完成三层证据对齐：官方文档 → 本机上游二进制 `strings` → 本仓库 external-stubs 契约，并写入对应 spec 的决策表。
- 每个 PR 必须包含 Finding ID、主责/关联 spec、变更契约、测试场景、实际命令和退出码、mock/offline/live 边界。
- 原始发现、历史统计和 rejected 记录不得删除；只追加 `open → in-review → verified` 或 `blocked` 的整改证据。
- 新建/大幅修订 spec 必须包含：架构与资源边界图、关键流程与失败路径、核心对象生命周期七列表。
- `draft → approved` 只能在正文整改和用户审阅后执行，并同步 frontmatter、manifest、coverage 和 INDEX。
- 不把 mock、离线检查、strings 或测试文件存在写成 live 通过；私有协议不得声称兼容。
- 测试使用 `bun run test`，以总退出码和无 `Failed test files` 为准；类型使用 `bun run typecheck`，构建使用 `bun run build`。
- 每个任务先写失败测试并确认失败原因，再写最小实现；不得通过删除测试、降低断言或扩大 smoke skip 来通过。
- 每个提交以 `Co-Authored-By: Kimi <noreply@moonshot.cn>` 结尾。
- 回滚以阶段为单位：若阶段引入回归，先执行 `git revert --no-edit HEAD` 回退该阶段最后一个提交；若该阶段有多个提交，按 PR 中记录的逆序逐个 revert，不重写 main 历史。

## 实施理由与步骤依据

先处理 CI 基线，避免把已有浏览器不稳定性误判为整改回归。两个 P1 都是局部、可独立证明的缺陷，先完成可快速形成信任的修复。Skills、Workflow、AppState 具有明确状态机，随后处理可复用这些测试方法。Context/Memory 涉及跨会话状态和恢复，必须晚于状态契约整改。Session/协议涉及跨进程副作用，放在状态隔离之后。最后清理 coverage、补测试和批准 spec，避免在行为仍变化时冻结文档。

## File Structure

- `src/utils/secureStorage/`：Keychain 缓存、跨进程版本元数据和读取路径。
- `scripts/live-model-validation.ts`：standalone 初始化与凭据检查。
- `src/skills/loadSkillsDir.ts`：条件技能、动态目录、缓存和 watcher 生命周期。
- `src/tools/WorkflowTool/executor.ts`：skip/retry 状态机。
- `src/state/store.ts`：订阅通知和重入队列。
- `src/services/contextCollapse/`、`src/services/compact/`：会话级压缩状态。
- `src/services/SessionMemory/`、`src/memdir/`、`src/services/extractMemories/`：cursor、删除失效和路径边界。
- `src/utils/sessionStorage.ts`：JSONL 并发写入和恢复。
- `docs/architecture/coverage/`：剩余文件的唯一主责。
- `docs/superpowers/specs/`：当前行为、决策表、三视图和证据。
- `docs/status/design-docs-completeness-audit/README.md`：整改台账，不改写原发现。

## 共享测试辅助接口

以下辅助接口在各任务测试文件内实现，禁止用未定义的通用 mock 代替真实行为：

- `createIsolatedKeychainFixture()`：在临时 `CLAUDE_CONFIG_DIR` 中创建 fake `security` 可执行脚本，返回 `{ env, securityReadCount }`；只模拟 Keychain 响应，不访问真实凭据。
- `simulateOtherProcessTokenUpdate(env, token)`：使用独立 `Bun.spawn` 进程环境写入新 token 和 cache-version 标记，模拟真正的跨进程写入。
- `writeCachedToken(env, token)`：通过 fixture 的 fake `security` 写入凭据并预热缓存，不额外增加 `securityReadCount`。
- `readTokenThroughCache(env)`：调用生产读取路径并返回当前缓存/存储结果。
- `createFakeHelper({ exitAfterMs })`：Task 0 的进程替身，提供 `kill/waitForExit/removeAllListeners/running/exitCode`，模拟延迟退出和清理超时。
- `createSkillLifecycleController(options)`：Task 3 的生产控制器，接收 `watcherFactory`、目录配置和时钟；`activeConditionalNames` 暴露当前条件技能集合。
- `createBoundedSkillCache(options)`：Task 3 的生产缓存工厂，接收 `ttlMs`、`maxEntries` 和时钟，提供 `put/get/dispose/size`。
- `createWorkflow(stepIds)`：使用真实 `WorkflowExecution` 和可控 runner 创建 DAG；测试辅助方法只负责注入失败与自定义 skip 消息。
- `createMemoryFixture()`：创建临时 memory 根目录、消息文件和 sidecar，提供 `setCursor/restart/deleteMemoryFile/getLastSummarizedMessageId`。
- `createSessionContext(sessionId)`：Task 5 的生产上下文工厂，隔离 collapse 与 microcompact 状态，并提供 `collapse.stage/stats`、`microcompact.registerToolResult/pendingCacheEdits`。
- `createSessionFixture()`：创建临时 session JSONL 和 `readJsonLines()` 解析辅助，模拟真实磁盘恢复输入。
- `spawnAppendWorker(session, workerId, count)`：通过 `Bun.spawn` 启动真实独立写进程，逐条追加带 UUID/parentUuid 的 JSONL 消息。
- `fakeWatcher`：提供 `emit(event, path)`、`close()` 和事件记录，验证 watcher 生命周期而不依赖真实秒级等待。
- `makeSkill()`：返回只含 name/content 的最小技能夹具，不读取远程服务。
- `makeCollapse(sessionId)` / `makeToolResult(sessionId)`：生成只带当前会话 UUID 的压缩段和工具结果，验证跨会话不串状态。
- `advanceTime(ms)`：操作注入的虚拟时钟，不修改系统时间。
- `Helper`：Task 0 的进程接口，包含 `kill()`、`waitForExit()`、`running`、`exitCode`、`removeAllListeners()`。

---

### Task 0: 稳定真实浏览器 CI 基线

**Files:**
- Modify: `src/external-stubs/claude-for-chrome-mcp.ts`
- Test: `tests/openBackends.test.ts`
- Document: `docs/external-stubs/verification.md`

**Interfaces:**
- Consumes: 当前真实浏览器启动、导航和 `cleanup()` 路径。
- Produces: 可重复的启动/导航/清理证据；只有实际缺陷才产生代码修改。

- [ ] **Step 1: 复现并分类失败**

Run:

```bash
bun test tests/openBackends.test.ts
```

Expected: 本地可重复结果。若本地通过，在 Linux CI 复现；记录是启动超时、导航超时、清理超时、浏览器缺失还是 runner 资源竞争。禁止直接把超时改成 skip。

- [ ] **Step 2: 先写清理回归**

若确认是清理未等待进程退出，添加形如以下测试，使用假进程而非真实浏览器：

```ts
import { expect, test } from 'bun:test'

test('cleanup waits for the helper to exit and still times out bounded', async () => {
  const helper = createFakeHelper({ exitAfterMs: 50 })
  const result = await runBoundedHelperCleanup(helper, 200)
  expect(result.timedOut).toBe(false)
  expect(helper.exitCode).toBe(0)
  expect(helper.running).toBe(false)
})
```

Expected before implementation: 当前清理路径在 helper 退出前返回或抛出未处理超时。

- [ ] **Step 3: 最小化清理修复**

仅在证据表明清理缺陷时修改实现：

```ts
async function runBoundedHelperCleanup(helper: Helper, timeoutMs: number) {
  const timeout = setTimeout(() => helper.kill(), timeoutMs)
  try {
    const exit = await helper.waitForExit()
    return { timedOut: false, ...exit }
  } finally {
    clearTimeout(timeout)
    helper.removeAllListeners()
  }
}
```

不得通过重试次数增加、跳过导航断言或掩盖 `Browser resource cleanup timed out` 来消除失败。若最终证明是 runner 环境问题，只更新验证记录，不修改产品逻辑。

- [ ] **Step 4: 验证基线并提交**

```bash
bun test tests/openBackends.test.ts
bun run test
bun run typecheck
bun run build
```

Expected: 全部退出 0；CI 的同一真实浏览器用例通过，且没有新增未处理清理错误。提交 `Stabilize browser backend smoke tests` 并关联 `docs/external-stubs/verification.md`。

---

### Task 1: 修复 B3-auth-01 跨进程 Keychain 缓存陈旧

**Files:**
- Modify: `src/utils/secureStorage/macOsKeychainHelpers.ts`
- Modify: `src/utils/secureStorage/macOsKeychainStorage.ts`
- Modify: `src/utils/secureStorage/keychainPrefetch.ts`
- Create: `tests/macOsKeychainHelpers.test.ts`
- Document: `docs/superpowers/specs/2026-11-12-auth-design.md`

**Interfaces:**
- Produces: 轻量跨进程缓存版本探测；不得每次读取都调用 `security`。
- Produces: `touchKeychainCacheVersion()` 和 `isKeychainCacheVersionCurrent(cachedVersion)` 内部契约。

- [ ] **Step 1: 写跨进程失效失败测试**

使用隔离 `CLAUDE_CONFIG_DIR` 和 fake security helper，不访问真实 Keychain：

```ts
import { expect, test } from 'bun:test'

test('another process cache-version update invalidates a cached token', async () => {
  const env = await createIsolatedKeychainFixture()
  await writeCachedToken(env, 'old-token')
  await simulateOtherProcessTokenUpdate(env, 'new-token')
  const result = await readTokenThroughCache(env)
  expect(result).toBe('new-token')
  expect(env.securityReadCount).toBe(1)
})
```

Run: `bun test tests/macOsKeychainHelpers.test.ts`

Expected: 旧实现仍返回 `old-token`，证明 30 秒 TTL 造成跨进程陈旧。

- [ ] **Step 2: 实现共享版本标记**

在配置目录维护小型 cache-version 文件，所有写入/清除路径原子更新它；读取缓存前只读取这个不含凭据的标记，不调用 `security`：

```ts
import { randomUUID } from 'crypto'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'

function getKeychainCacheVersionPath(): string {
  return join(getClaudeConfigHomeDir(), '.keychain-cache-version.json'
  )
}

export function touchKeychainCacheVersion(): void {
  const marker = getKeychainCacheVersionPath()
  const temporary = `${marker}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify({ version: randomUUID() }), { mode: 0o600 })
  renameSync(temporary, marker)
}

export function isKeychainCacheVersionCurrent(cachedVersion: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(getKeychainCacheVersionPath(), 'utf8'))
    return marker.version === cachedVersion
  } catch {
    return false
  }
}
```

缓存状态新增 `cacheVersion` 字段；`update()`、`clearKeychainCache()` 和外部文件替换必须更新 marker。`readAsync()` 在捕获版本后重新验证，防止迟到的旧结果覆盖新数据。保留现有 generation 和 in-flight 去重；marker 损坏或缺失时回退真实存储读取，不信任缓存。

- [ ] **Step 3: 验证双进程、回退和性能测试**

```bash
bun test tests/macOsKeychainHelpers.test.ts
```

覆盖：另一进程更新 marker、marker 不存在、marker 损坏、迟到读取、连续读取不增加 `security` 调用、明文 fallback 不泄密。

- [ ] **Step 4: 更新 spec 与台账并提交**

在 auth spec 记录版本文件生命周期、并发和失败语义。PR 写 `B3-auth-01`，台账在验证后为 verified。

```bash
bun run test
bun run typecheck
bun run build
git add src/utils/secureStorage tests/macOsKeychainHelpers.test.ts docs/superpowers/specs/2026-11-12-auth-design.md docs/status/design-docs-completeness-audit/README.md
git commit -m "Fix cross-process Keychain cache invalidation" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
```

---

### Task 2: 修复 B7-test-validation-06 初始化顺序

**Files:**
- Modify: `scripts/live-model-validation.ts`
- Create: `tests/liveModelValidation.test.ts`
- Document: `docs/superpowers/specs/2026-11-12-test-validation-design.md`

**Interfaces:**
- Produces: `validateCredentialSources(env): 'api_key' | 'bearer' | null`，互斥时抛出明确错误；`main()` 仅在 `import.meta.main` 时执行。

- [ ] **Step 1: 写四种凭据组合测试**

```ts
import { expect, test } from 'bun:test'

const cases = [
  [{}, null],
  [{ ANTHROPIC_API_KEY: 'key' }, 'api_key'],
  [{ ANTHROPIC_AUTH_TOKEN: 'token' }, 'bearer'],
]

test.each(cases)('resolves credential source after config initialization', async (env, expected) => {
  await enableConfigs()
  expect(validateCredentialSources(env)).toBe(expected)
})

test('rejects simultaneous key and bearer without printing secrets', () => {
  expect(() => validateCredentialSources({
    ANTHROPIC_API_KEY: 'key',
    ANTHROPIC_AUTH_TOKEN: 'token',
  })).toThrow('mutually exclusive')
})
```

Expected: 当前代码在 `enableConfigs()` 前检查，settings-only 环境被错误跳过。

- [ ] **Step 2: 最小重构初始化**

将 `enableConfigs()` 移到凭据检查之前，并把环境判断提取为纯函数：

```ts
export function validateCredentialSources(
  env: NodeJS.ProcessEnv,
): 'api_key' | 'bearer' | null {
  const hasKey = Boolean(env.ANTHROPIC_API_KEY)
  const hasToken = Boolean(env.ANTHROPIC_AUTH_TOKEN)
  if (hasKey && hasToken) {
    throw new Error('ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are mutually exclusive')
  }
  return hasKey ? 'api_key' : hasToken ? 'bearer' : null
}

export async function main() {
  enableConfigs()
  const source = validateCredentialSources(process.env)
  if (!source) {
    console.log('MODEL_LIVE_SKIPPED')
    return
  }
  const model = getMainLoopModel()
  const toolContext = context(model)
  const workflow = parseWorkflowDefinition({
    name: 'live-flow',
    description: 'live model validation',
    steps: [{ id: 'respond', prompt: 'Return only WORKFLOW_LIVE_OK' }],
  })
  const { done } = startWorkflowTask({
    workflow,
    input: '',
    context: toolContext as never,
    canUseTool: hasPermissionsToUseTool,
  })
  const workflowResult = await done
  if (workflowResult.status !== 'completed') {
    throw new Error(`Workflow failed: ${workflowResult.error ?? workflowResult.status}`)
  }
  console.log('WORKFLOW_LIVE_OK')
  // Sleep/proactive/context-collapse/reactive 检查继续按原顺序执行
}
```

使用 `if (import.meta.main) await main()` 避免测试导入时发起真实请求。

- [ ] **Step 3: 运行离线矩阵和真实 live 验证**

```bash
bun test tests/liveModelValidation.test.ts
bun scripts/live-model-validation.ts
```

Expected: 离线矩阵全部通过；真实 live 只记录实际可用凭据路径的结果，未运行 live 的环境写 `MODEL_LIVE_SKIPPED`，不宣称 live 通过。

- [ ] **Step 4: 提交**

更新 test-validation spec 和 `B7-test-validation-06` 台账。

```bash
bun run test
bun run typecheck
bun run build
git add scripts/live-model-validation.ts tests/liveModelValidation.test.ts docs/superpowers/specs/2026-11-12-test-validation-design.md docs/status/design-docs-completeness-audit/README.md
git commit -m "Fix live validation credential initialization" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
```

---

### Task 3: 完成 Skills 生命周期整改

**Files:**
- Modify: `src/skills/loadSkillsDir.ts`
- Modify: `src/services/skillSearch/remoteSkillLoader.ts`
- Create: `tests/skillsLifecycle.test.ts`
- Document: `docs/superpowers/specs/2026-11-12-skills-design.md`

**Interfaces:**
- Produces: 可注入 watcher factory、条件技能重校验、组合缓存 key 和有界远程缓存。
- Produces: 统一清理函数，关闭 watcher 并释放缓存。

- [ ] **Step 1: 写四个失败场景**

```ts
test('conditional skill is removed when its directory disappears', async () => {
  const controller = createSkillLifecycleController({ watcherFactory: fakeWatcher })
  await controller.activate('conditional-skill')
  await fakeWatcher.emit('unlinkDir', 'conditional-skill')
  expect(controller.activeConditionalNames.has('conditional-skill')).toBe(false)
})

test('cache key distinguishes additional dirs and environment', () => {
  expect(skillCacheKey({ cwd: '/repo', additionalDirs: [], remote: false }))
    .not.toBe(skillCacheKey({ cwd: '/repo', additionalDirs: ['/team'], remote: false }))
})

test('remote cache evicts expired entries and closes watcher', async () => {
  const cache = createBoundedSkillCache({ ttlMs: 10, maxEntries: 1 })
  await cache.put('old', makeSkill())
  await advanceTime(11)
  expect(await cache.get('old')).toBeUndefined()
  await cache.dispose()
  expect(cache.size).toBe(0)
})
```

Expected: 当前无失效、无 watcher、仅以 cwd 为 key、无清理策略。

- [ ] **Step 2: 实现最小生命周期控制器**

把 watcher 创建和清理放进同一所有者；目录删除/变化时重跑发现与条件评估，不简单清空全部缓存。组合 key 至少包含 cwd、additional dirs 和远程/构建开关。远程缓存采用 TTL + 最大条数，dispose 同时停止 watcher 并清理暂存下载。

- [ ] **Step 3: 运行生命周期与并发测试**

```bash
bun test tests/skillsLifecycle.test.ts
```

覆盖：删除、重建、重命名、并发发现、缓存交错完成、additional dirs、远程过期、dispose 幂等。

- [ ] **Step 4: 提交**

更新 skills spec 的失效/缓存/watcher 生命周期和三视图，并关联 `B3-skills-01/02/04/05`。

```bash
bun run test
bun run typecheck
bun run build
git add src/skills tests/skillsLifecycle.test.ts docs/superpowers/specs/2026-11-12-skills-design.md docs/status/design-docs-completeness-audit/README.md
git commit -m "Complete skill lifecycle management" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
```

---

### Task 4: 修复 Workflow skip/retry 与 AppState 重入语义

**Files:**
- Modify: `src/tools/WorkflowTool/executor.ts`
- Modify: `src/state/store.ts`
- Test: `tests/workflow.test.ts`
- Create: `tests/appStateStore.test.ts`
- Document: `docs/superpowers/specs/2026-11-12-workflow-design.md`
- Document: `docs/superpowers/specs/2026-11-12-app-state-design.md`

**Interfaces:**
- Produces: `WorkflowAgentState.skipCause?: 'user' | 'dependency'`，不再以错误字符串识别重置来源。
- Produces: 保持广播通知语义的 FIFO 重入队列，避免递归调用栈失控。

- [ ] **Step 1: 写非默认 skip 错误和重入测试**

```ts
test('retry resets only dependency-propagated skips with custom messages', () => {
  const execution = createWorkflow(['a', 'b', 'c'])
  execution.fail('a')
  execution.skipDependentsWithCustomMessage('b', 'custom skip reason')
  expect(execution.retry('a')).toBe(true)
  expect(execution.getState().agents.b.status).toBe('pending')
  expect(execution.getState().agents.c.status).toBe('pending')
})

test('nested setState is delivered once in FIFO order without recursion overflow', () => {
  const store = createStore(0)
  const seen: number[] = []
  store.subscribe(() => {
    seen.push(store.getState())
    if (store.getState() < 2) store.setState(value => value + 1)
  })
  store.setState(value => value + 1)
  expect(seen).toEqual([1, 2])
})
```

Expected: 当前依赖精确错误字符串导致状态卡住；嵌套通知可递归。

- [ ] **Step 2: 实现 skipCause 和通知队列**

`skip()` 设置 `skipCause: 'user'`；`propagateSkips()` 设置 `skipCause: 'dependency'`；`resetDependents()` 仅重置 `status === 'skipped' && skipCause === 'dependency'`。保持手动 skip 不被 retry 连带重置。

`createStore()` 使用 `isNotifying` 和 FIFO 队列：通知过程中产生的更新入队，在当前通知循环结束后依次处理，不抑制任何合法通知。

- [ ] **Step 3: 运行状态机回归**

```bash
bun test tests/workflow.test.ts tests/appStateStore.test.ts
```

覆盖：默认/自定义 skip 消息、手动 skip、反向依赖声明、skip→retry、旧 runner 晚完成、嵌套更新顺序和退订。

- [ ] **Step 4: 提交**

关联 `B5-workflow-02`、`B4-app-state-01`，更新两个 spec 的状态机和生命周期。

```bash
bun run test
bun run typecheck
bun run build
git add src/tools/WorkflowTool/executor.ts src/state/store.ts tests/workflow.test.ts tests/appStateStore.test.ts docs/superpowers/specs/2026-11-12-workflow-design.md docs/superpowers/specs/2026-11-12-app-state-design.md docs/status/design-docs-completeness-audit/README.md
git commit -m "Fix workflow retry and app state notification semantics" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
```

---

### Task 5: 隔离 Context/Memory 状态并修复恢复边界

**Files:**
- Modify: `src/services/contextCollapse/store.ts`
- Modify: `src/services/contextCollapse/index.ts`
- Modify: `src/services/compact/microCompact.ts`
- Modify: `src/services/SessionMemory/sessionMemoryUtils.ts`
- Modify: `src/services/extractMemories/extractMemories.ts`
- Modify: `src/memdir/paths.ts`
- Modify: `src/memdir/teamMemPaths.ts`
- Test: `tests/contextCollapse.test.ts`
- Create: `tests/sessionMemory.test.ts`
- Create: `tests/memoryPaths.test.ts`
- Document: `docs/superpowers/specs/2026-11-12-context-compaction-design.md`
- Document: `docs/superpowers/specs/2026-11-12-memory-design.md`

**Interfaces:**
- Produces: 会话级 `ContextCollapseState` 和 `CachedMicrocompactState`，由 ToolUseContext/QueryEngine 注入，不再共享模块级可变状态。
- Produces: Session Memory 状态 sidecar、删除失效和真实路径执行层校验。

- [ ] **Step 1: 写多会话和重启失败测试**

```ts
test('two sessions never share collapse or cached-microcompact state', async () => {
  const a = createSessionContext('a')
  const b = createSessionContext('b')
  await a.collapse.stage(makeCollapse('a'))
  await a.microcompact.registerToolResult(makeToolResult('a'))
  expect(b.collapse.stats.stagedSpans).toBe(0)
  expect(b.microcompact.pendingCacheEdits).toBeNull()
})

test('restart restores memory cursor and deleted files invalidate it', async () => {
  const env = await createMemoryFixture()
  await env.setCursor('message-2')
  await env.restart()
  expect(env.getLastSummarizedMessageId()).toBe('message-2')
  await env.deleteMemoryFile('topic.md')
  await env.restart()
  expect(env.getLastSummarizedMessageId()).toBeUndefined()
})
```

Expected: 当前模块级状态共享，cursor 仅内存保存，删除后没有失效。

- [ ] **Step 2: 实现会话状态所有权和持久化 cursor**

将 collapse/microcompact 的可变状态改为实例，并沿 ToolUseContext 传递；`restoreFromEntries()` 只恢复当前 sessionId。保留 generation、staged/commit、恢复和取消语义，不改压缩阈值。

Session Memory 使用原子 sidecar 保存 cursor；sidecar 缺失时重新初始化，引用文件不存在时使 cursor 失效。路径权限快速候选检查与执行层 realpath 校验分离，越界读取和写入都拒绝。

- [ ] **Step 3: 运行隔离、恢复和安全测试**

```bash
bun test tests/contextCollapse.test.ts tests/sessionMemory.test.ts tests/memoryPaths.test.ts tests/reactiveCompact.test.ts
```

覆盖：交错会话、fork、reset-during-persistence、重启 cursor、删除文件、目录/文件 symlink、合法内部链接和越界链接。

- [ ] **Step 4: 提交**

关联 `B1-context-compaction-02/03`、`X-memory-02/03`、`X-context-01`，更新两份 spec 的状态所有权和恢复图。

```bash
bun run test
bun run typecheck
bun run build
git add src/services/contextCollapse src/services/compact/microCompact.ts src/services/SessionMemory src/services/extractMemories src/memdir tests/contextCollapse.test.ts tests/sessionMemory.test.ts tests/memoryPaths.test.ts docs/superpowers/specs/2026-11-12-context-compaction-design.md docs/superpowers/specs/2026-11-12-memory-design.md docs/status/design-docs-completeness-audit/README.md
git commit -m "Isolate context and memory session state" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
```

---

### Task 6: 完成 Session 与协议并发契约

**Files:**
- Modify: `src/utils/sessionStorage.ts`
- Modify: `src/utils/sessionStoragePortable.ts`
- Create: `tests/sessionConcurrency.test.ts`
- Create: `tests/protocolContracts.test.ts`
- Document: `docs/superpowers/specs/2026-11-12-session-persistence-design.md`
- Document: `docs/external-stubs/contracts/open-chrome.md`

**Interfaces:**
- Produces: 每个 session 文件的短锁队列，锁只覆盖追加/元数据更新，不覆盖模型调用或长读取。
- Produces: sandbox/bridge/tool API 的离线契约矩阵，不承诺私有 wire 兼容。

- [ ] **Step 1: 写双进程追加和恢复测试**

```ts
test('two processes append complete JSONL records without interleaving', async () => {
  const session = await createSessionFixture()
  await Promise.all([
    spawnAppendWorker(session, 'worker-a', 50),
    spawnAppendWorker(session, 'worker-b', 50),
  ])
  const lines = await session.readJsonLines()
  expect(lines).toHaveLength(100)
  expect(new Set(lines.map(line => line.uuid)).size).toBe(100)
  expect(lines.every(line => line.parentUuid === undefined || line.parentUuid)).toBe(true)
})
```

Expected: 当前无跨进程锁时可能出现覆盖、丢失或恢复链不一致。

- [ ] **Step 2: 实现短锁与恢复校验**

使用现有 `proper-lockfile`，每个 session 文件一个锁；追加期间持有，等待/退避有上限，崩溃可清理 stale lock。恢复只接受完整 JSONL 行和可解析 UUID 链，尾部不完整记录进入明确恢复分支，不静默接受。

协议测试只验证本仓库公开契约：错误形状、重试、超时、重定向、disabled/stub 分支，不连接私有服务。

- [ ] **Step 3: 运行并发与协议测试**

```bash
bun test tests/sessionConcurrency.test.ts tests/protocolContracts.test.ts tests/sdkSessions.test.ts tests/openBackends.test.ts
```

覆盖：双写者、锁超时、stale lock、部分写入、重复 UUID、损坏尾行、恢复、SDK fork，以及浏览器缺失与真实错误的分类差异。

- [ ] **Step 4: 提交**

关联 `B2-session-persistence-03`、`B2-bridge-03`、`B2-shell-tools-03`、`B2-tool-framework-03`，更新 session 和协议契约。

```bash
bun run test
bun run typecheck
bun run build
git add src/utils/sessionStorage.ts src/utils/sessionStoragePortable.ts tests/sessionConcurrency.test.ts tests/protocolContracts.test.ts docs/superpowers/specs/2026-11-12-session-persistence-design.md docs/external-stubs/contracts/open-chrome.md docs/status/design-docs-completeness-audit/README.md
git commit -m "Complete session and protocol concurrency contracts" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
```

---

### Task 7: 清理剩余 coverage 并补齐关键回归

**Files:**
- Modify: `docs/architecture/coverage/native-installer.yaml`
- Modify: `docs/architecture/coverage/webbrowser-bundled-support.yaml`
- Create: `tests/contextCompaction.test.ts`
- Create: `tests/memory.test.ts`
- Test: `tests/skillsLifecycle.test.ts`
- Test: `tests/sessionConcurrency.test.ts`

**Interfaces:**
- Produces: `scripts/install.sh`、`tests/installScript.test.ts` → native-installer；`tests/claudeInChromeWiring.test.ts` → webbrowser-bundled-support。
- Produces: 关键模块直接测试和真实证据边界。

- [ ] **Step 1: 先运行结构检查证明缺失**

```bash
bun scripts/check-design-docs.ts
```

Expected: 报告上述三个 `UNCOVERED_FILE`，不得将它们加入生成文件排除。

- [ ] **Step 2: 更新唯一 coverage 主责**

将安装脚本和安装测试加入 `native-installer` 合适组；将 bundled wiring 测试加入 `webbrowser-bundled-support` 的 tests 组。保持每个文件只有一个主责。

- [ ] **Step 3: 添加关键失败场景测试**

至少覆盖：压缩 PTL/附件恢复/长会话、memory cursor/路径/提取锁、Skills 失效与缓存、Session 双写与恢复。每个测试必须有可观察不变量，不能只验证 mock 调用次数。

```bash
bun test tests/contextCompaction.test.ts tests/memory.test.ts tests/skillsLifecycle.test.ts tests/sessionConcurrency.test.ts
```

Expected: 新测试先证明遗漏，再随实现通过；mock/offline/live 分别记录。

- [ ] **Step 4: 验证结构并提交**

```bash
bun scripts/check-design-docs.ts
bun run test
bun run typecheck
bun run build
```

Expected: `UNCOVERED_FILE` 为 0；警告只剩 69 个 `DRAFT_SPEC`。提交 `Complete subsystem coverage and regression tests`。

---

### Task 8: 用户审阅、spec 批准与持续增量审计

**Files:**
- Modify: `docs/superpowers/specs/*.md`（仅本次实际整改的 spec）
- Modify: `docs/architecture/coverage/manifest.yaml`
- Modify: `docs/architecture/coverage/*.yaml`
- Modify: `docs/architecture/INDEX.md`
- Modify: `docs/status/design-docs-completeness-audit/README.md`

**Interfaces:**
- Produces: 用户逐批批准后的 spec 状态和最终整改台账。
- Produces: 后续每次提交可复用的增量审查记录。

- [ ] **Step 1: 逐批审阅行为和文档**

每个批次必须能回答：所有者、创建、共享、持久化、重置、取消、恢复、失败和验证边界。三视图必须与当前实现一致，未解决问题不得标为 fixed。

- [ ] **Step 2: 仅在用户明确批准后改状态**

对获得批准的 spec 同步修改 frontmatter、manifest、coverage status 和 INDEX。不得批量把 69 个 spec 改为 approved。

- [ ] **Step 3: 运行最终门禁**

```bash
bun scripts/check-design-docs.ts
bun run test
bun run typecheck
bun run build
git diff --check
```

Expected: 全部退出 0；coverage 无遗漏；所有 spec 仍具有三视图和统一生命周期表。若有 approved spec，再运行严格模式并记录真实结果。

- [ ] **Step 4: 完成整改台账并选择后续节奏**

保留原发现和历史统计，为每个 PR 记录 Finding ID、链接、验证证据和剩余 blocked/unconfirmed 项。后续只做增量审计；核心 context/query/session/memory 模型大改、上游大版本、广泛归属重组或定期复审时才重新全审。

```bash
git add docs/superpowers/specs docs/architecture docs/status/design-docs-completeness-audit/README.md
git commit -m "Approve remediated subsystem specifications" -m "Co-Authored-By: Kimi <noreply@moonshot.cn>"
```

## 最终完成定义

1. 两个 P1 均有实现和可复核验证。
2. Skills、Workflow、AppState、Context/Memory、Session 的高影响状态问题均有明确契约、实现和回归。
3. 三个剩余 `UNCOVERED_FILE` 均有唯一主责，结构检查不再出现 uncovered。
4. 每个整改 PR 都有 Finding ID、spec、测试、退出码、证据边界和回滚路径。
5. 没有产品行为被错误标为已修复，没有 mock/offline 被写成 live，没有私有协议被宣称兼容。
6. spec 只在用户审阅后批准，原始发现和 rejected 记录始终保留。
