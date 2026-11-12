# SDK Query, Sessions, and Checkpointing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining contract gaps in parallel transcript recovery, control metadata, and query cleanup while preserving the existing SDK implementation and its test baseline.

**Architecture:** Keep production modules stable unless a test exposes a defect. Add focused tests for pure DAG recovery, metadata notifications, and `query.return()` cleanup, then validate existing rewind tests and the full build. This is contract completion, not a rewrite of SDK query/session code.

**Tech Stack:** Bun 1.3+, TypeScript, Bun test, existing `src/utils/sdkQuery.ts`, `sessionChainRecovery.ts`, `sdkControl.ts`, and `fileCheckpointing.ts`.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-11-12-sdk-query-sessions-design.md`.
- Do not introduce another query implementation, shadow session state, global checkpoint configuration, or remote protocol dependency.
- `recoverOrphanedParallelToolResults()` remains pure and shared by CLI and SDK; it does not read analytics or AppState.
- `makeSnapshot()` and `rewindFiles()` remain associated by user message UUID. Dry run must not write files.
- Do not add model calls, real OAuth, real Cloud calls, or commit mappings. Do not record historical execution results.
- Work in `/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs`. Do not push until the user explicitly asks for a PR.
- Existing merge-related test failures must not be hidden by deleting unrelated tests or changing their assertions. Focused fixes and full-suite results must be reported separately.

## Why This Implementation Order

1. **Pure DAG contracts first**: session recovery has no external state, so it isolates algorithmic errors before lifecycle behavior is tested.
2. **Control metadata second**: flags and model changes affect `getMainLoopModel()` and session metadata. Proving they share state prevents false settings results.
3. **Query cleanup third**: only after identity and state semantics are fixed can we verify that `return()` releases persistence and cleanup resources in the right order.
4. **Full verification last**: the full suite and build are necessary to catch integration regressions; they are not a substitute for the focused contract tests.

## File Structure

- Create `tests/sessionChainRecovery.test.ts`: direct anchor, ordering, unrelated-group, and idempotence coverage.
- Modify `tests/sdkControls.test.ts`: verify null deletion and model metadata notifications with state restoration.
- Create `tests/sdkQueryLifecycle.test.ts`: verify `query.return()` invokes cleanup and session flush exactly once.
- Keep `tests/sdkRewind.test.ts` as the existing checkpoint/rewind regression suite.

---

### Task 1: Lock Parallel DAG Recovery Semantics

**Files:**
- Create: `tests/sessionChainRecovery.test.ts`

**Interfaces:**
- Consumes: `recoverOrphanedParallelToolResults(messages, chain, seen)` and its `{chain, recoveredCount}` result.
- Produces: deterministic coverage for anchor selection, stable ordering, unrelated groups, and idempotence.

- [ ] **Step 1: Add the focused DAG test**

Create `tests/sessionChainRecovery.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { recoverOrphanedParallelToolResults } from '../src/utils/sessionChainRecovery.ts'

function assistant(uuid: string, id: string, timestamp?: string) {
  return {
    type: 'assistant',
    uuid: uuid as never,
    parentUuid: 'user-root' as never,
    timestamp,
    message: { id },
  }
}

function toolResult(uuid: string, parentUuid: string, timestamp?: string) {
  return {
    type: 'user',
    uuid: uuid as never,
    parentUuid: parentUuid as never,
    timestamp,
    message: { content: [{ type: 'tool_result', tool_use_id: parentUuid }],
  }
}

test('recovers siblings after the last on-chain anchor with stable order and no unrelated groups', () => {
  const a1 = assistant('a1', 'msg-1', '2026-01-01')
  const a2 = assistant('a2', 'msg-1', '2026-01-01')
  const a3 = assistant('a3', 'msg-1', '2026-01-01')
  const r1 = toolResult('r1', 'a1', '2026-01-01')
  const r2 = toolResult('r2', 'a2', '2026-01-01')
  const unrelated = assistant('x1', 'other', '2020-01-01')
  const unrelatedResult = toolResult('rx', 'x1', '2020-01-01')
  const next = { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: 'next' } }
  const messages = new Map([
    ['a1', a1], ['a2', a2], ['a3', a3], ['r1', r1], ['r2', r2],
    ['x1', unrelated], ['rx', unrelatedResult], ['u2', next],
  ])
  const chain = [a1, a2, next]
  const seen = new Set(['a1', 'a2', 'u2'])

  const result = recoverOrphanedParallelToolResults(messages, chain, seen)
  expect(result.recoveredCount).toBe(3)
  expect(result.chain.map(message => message.uuid)).toEqual([
    'a1', 'a2', 'a3', 'r1', 'r2', 'u2',
  ])
  expect(result.chain).not.toContain(unrelated)
  expect(result.chain).not.toContain(unrelatedResult)

  const allSeen = new Set(result.chain.map(message => message.uuid))
  expect(recoverOrphanedParallelToolResults(messages, result.chain, allSeen).recoveredCount).toBe(0)
})
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/sessionChainRecovery.test.ts`

Expected: PASS if the anchor and ordering contract is correct. If it fails, fix the implementation or the test only after checking the actual group order.

- [ ] **Step 3: Commit the DAG contract test**

```bash
git add tests/sessionChainRecovery.test.ts
git commit -m "Test parallel session DAG recovery"
```

---

### Task 2: Verify Flag Deletion and Model Metadata Notifications

**Files:**
- Modify: `tests/sdkControls.test.ts`

**Interfaces:**
- Consumes: `applySdkFlagSettings`, `getFlagSettingsInline`, `setFlagSettingsInline`, `getMainLoopModel`, `setMainLoopModelOverride`, and `notifySessionMetadataChanged`.

- [ ] **Step 1: Add the focused control test**

Append to `tests/sdkControls.test.ts`:

```ts
test('deletes null flags and emits model metadata changes with the applied model', async () => {
  const notifications: Array<{ model: string }> = []
  mock.module('../src/utils/sessionState.ts', () => ({
    notifySessionMetadataChanged: (value: { model: string }) => {
      notifications.push(value)
    },
  }))
  const { applySdkFlagSettings } = await import('../src/utils/sdkControl.ts')
  const {
    getFlagSettingsInline,
    setFlagSettingsInline,
    getMainLoopModel,
    setMainLoopModelOverride,
  } = await import('../src/bootstrap/state.ts')

  const originalModel = getMainLoopModel()
  const originalFlags = getFlagSettingsInline()
  try {
    setMainLoopModelOverride('model-a')
    setFlagSettingsInline({ removeMe: true, keepMe: 'yes' })
    applySdkFlagSettings({ removeMe: null, model: 'model-b' })
    expect(getFlagSettingsInline()?.removeMe).toBeUndefined()
    expect(getFlagSettingsInline()?.keepMe).toBe('yes')
    expect(getMainLoopModel()).toBe('model-b')

    applySdkFlagSettings({ model: null })
    expect(getMainLoopModel()).toBe(originalModel)
    expect(notifications).toEqual([
      { model: 'model-b' },
      { model: originalModel },
    ])
  } finally {
    setMainLoopModelOverride(originalModel)
    setFlagSettingsInline(originalFlags ?? {})
  }
})
```

Also add `mock` to the existing `bun:test` import: `import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'`.

- [ ] **Step 2: Run the control tests**

Run: `bun test tests/sdkControls.test.ts`

Expected: PASS with null-key deletion, `keepMe` preservation, model override reset, and notifications for both the new model and restored model. Restore all state in `finally`.

- [ ] **Step 3: Commit the control contract test**

```bash
git add tests/sdkControls.test.ts
git commit -m "Verify SDK control metadata updates"
```

---

### Task 3: Verify Query Return Cleanup

**Files:**
- Create: `tests/sdkQueryLifecycle.test.ts`

**Interfaces:**
- Consumes: `createSdkQuery()` and its `return()` method, `runCleanupFunctions`, and `flushSessionStorage`.

- [ ] **Step 1: Add the cleanup test**

Create `tests/sdkQueryLifecycle.test.ts`:

```ts
import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'

test('query.return runs cleanup and session flush exactly once', async () => {
  const calls: string[] = []
  mock.module('../src/utils/cleanupRegistry.ts', () => ({
    runCleanupFunctions: async () => {
      calls.push('cleanup')
    },
  }))
  mock.module('../src/utils/sessionStorage.ts', () => ({
    flushSessionStorage: async () => {
      calls.push('flush')
    },
  }))
  const { createSdkQuery } = await import('../src/utils/sdkQuery.ts')
  const home = await mkdtemp(join('/tmp', 'sdk-query-lifecycle-'))
  try {
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
    process.env.ANTHROPIC_API_KEY = 'offline-test-placeholder'
    const query = createSdkQuery({
      prompt: (async function* () {})(),
      options: { tools: [] },
    })
    await query.return(undefined)
    await query.return(undefined)
    expect(calls).toEqual(['cleanup', 'flush'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the lifecycle test**

Run: `bun test tests/sdkQueryLifecycle.test.ts`

Expected: PASS with `cleanup` and `flush` each exactly once despite two `return()` calls. If it fails, inspect the cached cleanup promise rather than calling cleanup repeatedly.

- [ ] **Step 3: Commit the lifecycle test**

```bash
git add tests/sdkQueryLifecycle.test.ts
git commit -m "Verify SDK query cleanup lifecycle"
```

---

### Task 4: Full Verification and Regression Triage

**Files:**
- No production changes unless a focused test proves a defect.
- Keep `tests/sdkRewind.test.ts` and all existing tests.

- [ ] **Step 1: Run focused SDK and checkpoint contracts**

```bash
bun test tests/sessionChainRecovery.test.ts tests/sdkControls.test.ts tests/sdkQueryLifecycle.test.ts tests/sdkRewind.test.ts
```

Expected: all focused tests pass. A failure must identify the contract, input, and expected state; do not weaken assertions.

- [ ] **Step 2: Run full engineering verification**

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

Expected: zero TypeScript errors, zero test failures, and successful CLI/SDK/declaration builds. If unrelated failures occur, record the file and error separately from this feature's focused tests. Do not delete unrelated tests, change their expected values, or report the feature as fully verified.

- [ ] **Step 3: Commit only after the full result is green**

If the full suite fails, stop here and resolve the failure before committing. Once green:

```bash
git add tests/sessionChainRecovery.test.ts tests/sdkControls.test.ts tests/sdkQueryLifecycle.test.ts docs/superpowers/plans/2026-11-12-sdk-query-sessions.md
git commit -m "Complete SDK query and session verification"
```

Do not push or create a PR until the user explicitly asks for it.
