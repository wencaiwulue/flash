# External Feature Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the external feature list single-sourced and prove type generation, build artifacts, and environment-independent feature-profile behavior with executable tests.

**Architecture:** Extract one shared feature array consumed by production and verification builds. Add focused characterization tests for schema generation and packaged artifacts, then refactor the profile runner so two different outer environments can be compared without duplicating spawn logic.

**Tech Stack:** Bun 1.3+, TypeScript, Bun test, Bun.build, Zod schemas, existing `scripts/build.ts` and `tests/fixtures/*`.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-11-12-external-feature-profile-design.md`.
- CLI output is `dist/main.js`; SDK output is `dist/sdk.mjs`; declarations go to `dist/types` and match `package.json` exports.
- `USER_TYPE` remains `external`; `CLAUDE_CODE_VERIFY_PLAN` remains `false`.
- Production and verification builds must consume the same feature list and external define. No internal-only feature is added.
- Feature-profile checks run in a standalone Bun child process with `ANTHROPIC_API_KEY=offline-test-placeholder`, `ANTHROPIC_BASE_URL=https://api.anthropic.com`, `ENABLE_TOOL_SEARCH=true`, and `NODE_ENV=production` set after outer environment values.
- Current profile contains 43 tools and zero null entries. Sleep starts disabled and enables with proactive; worker is background and does not include Agent.
- Do not claim model, Cloud OAuth, desktop, or remote-registry validation. Do not record historical execution results.
- Work in `/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs`. Do not push until the user asks for a PR.

## File Structure

- Create `scripts/externalFeatureProfile.ts`: sole source of the external feature array.
- Modify `scripts/build.ts`: consume the shared array for both product bundles.
- Modify `tests/fixtures/verify-enabled-features.ts`: consume the same array for the verification bundle.
- Create `tests/externalFeatures.test.ts`: verify shared-list identity and exact feature membership.
- Create `tests/sdkTypeGeneration.test.ts`: exercise real schema generation and missing-schema failure in an isolated directory.
- Create `tests/buildArtifacts.test.ts`: verify CLI permission, SDK import, and declarations after a real build.
- Modify `tests/enabledFeatures.test.ts`: centralize profile execution and compare two outer environments.

---

### Task 1: Single-Source External Features

**Files:**
- Create: `scripts/externalFeatureProfile.ts`
- Modify: `scripts/build.ts`
- Modify: `tests/fixtures/verify-enabled-features.ts`
- Test: `tests/externalFeatures.test.ts`

**Interfaces:**
- Produces: `EXTERNAL_FEATURES: readonly string[]` imported by production and verification builds.
- Consumes: existing feature literals in `scripts/build.ts` and `tests/fixtures/verify-enabled-features.ts`.

- [ ] **Step 1: Write the failing shared-list test**

Create `tests/externalFeatures.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { EXTERNAL_FEATURES } from '../scripts/externalFeatureProfile.ts'

test('production and verification builds share one exact external feature list', async () => {
  const build = await Bun.file('scripts/build.ts').text()
  const verification = await Bun.file('tests/fixtures/verify-enabled-features.ts').text()
  expect(build).toContain('features: EXTERNAL_FEATURES')
  expect(verification).toContain('features: EXTERNAL_FEATURES')
  expect(EXTERNAL_FEATURES).toEqual([
    'AGENT_MEMORY_SNAPSHOT',
    'AGENT_TRIGGERS',
    'AGENT_TRIGGERS_REMOTE',
    'VOICE_MODE',
    'BRIDGE_MODE',
    'ULTRAPLAN',
    'FILE_PERSISTENCE',
    'KAIROS_BRIEF',
    'MONITOR_TOOL',
    'TEMPLATES',
    'OPEN_RUNNER',
    'OVERFLOW_TEST_TOOL',
    'TERMINAL_PANEL',
    'PROACTIVE',
    'COORDINATOR_MODE',
    'EXPERIMENTAL_SKILL_SEARCH',
    'UDS_INBOX',
    'DAEMON',
    'WORKFLOW_SCRIPTS',
    'CONTEXT_COLLAPSE',
    'DIRECT_CONNECT',
    'BG_SESSIONS',
    'REACTIVE_COMPACT',
    'SSH_REMOTE',
    'BUDDY',
    'FORK_SUBAGENT',
    'HISTORY_SNIP',
    'REVIEW_ARTIFACT',
    'KAIROS',
    'KAIROS_GITHUB_WEBHOOKS',
    'CHICAGO_MCP',
    'COMMIT_ATTRIBUTION',
    'BASH_CLASSIFIER',
    'WEB_BROWSER_TOOL',
  ])
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test tests/externalFeatures.test.ts`

Expected: FAIL because `scripts/externalFeatureProfile.ts` does not exist.

- [ ] **Step 3: Create the shared module**

Create `scripts/externalFeatureProfile.ts`:

```ts
export const EXTERNAL_FEATURES = [
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'VOICE_MODE',
  'BRIDGE_MODE',
  'ULTRAPLAN',
  'FILE_PERSISTENCE',
  'KAIROS_BRIEF',
  'MONITOR_TOOL',
  'OVERFLOW_TEST_TOOL',
  'TERMINAL_PANEL',
  'PROACTIVE',
  'COORDINATOR_MODE',
  'EXPERIMENTAL_SKILL_SEARCH',
  'UDS_INBOX',
  'DAEMON',
  'WORKFLOW_SCRIPTS',
  'CONTEXT_COLLAPSE',
  'REACTIVE_COMPACT',
  'BUDDY',
  'FORK_SUBAGENT',
  'HISTORY_SNIP',
  'REVIEW_ARTIFACT',
  'KAIROS',
  'KAIROS_GITHUB_WEBHOOKS',
  'CHICAGO_MCP',
  'WEB_BROWSER_TOOL',
] as const
```

- [ ] **Step 4: Consume the module in both builds**

Add to `scripts/build.ts`:

```ts
import { EXTERNAL_FEATURES } from './externalFeatureProfile.ts'
```

Replace the complete `features: [...]` literal with:

```ts
    features: [...EXTERNAL_FEATURES],
```

Add to `tests/fixtures/verify-enabled-features.ts`:

```ts
import { EXTERNAL_FEATURES } from '../../scripts/externalFeatureProfile.ts'
```

Replace its complete `features: [...]` literal with:

```ts
  features: [...EXTERNAL_FEATURES],
```

Do not change `define`, loaders, entrypoints, or output names.

- [ ] **Step 5: Run the test and typecheck**

Run:

```bash
bun test tests/externalFeatures.test.ts
bun run typecheck
```

Expected: the shared-list test and typecheck PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/externalFeatureProfile.ts scripts/build.ts tests/fixtures/verify-enabled-features.ts tests/externalFeatures.test.ts
git commit -m "Share external feature definitions"
```

---

### Task 2: Verify Real SDK Type Generation

**Files:**
- Test: `tests/sdkTypeGeneration.test.ts`

**Interfaces:**
- Consumes: `scripts/generate-sdk-types.ts`, `coreSchemas.ts`, and `controlSchemas.ts` through their real relative paths.

- [ ] **Step 1: Add the isolated generation test**

Create `tests/sdkTypeGeneration.test.ts`:

```ts
import { afterEach, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
const temporary = new Set<string>()
afterEach(async () => {
  for (const path of temporary) await rm(path, { recursive: true, force: true })
  temporary.clear()
})

async function prepareGenerator(): Promise<string> {
  const dir = await mkdtemp(join('/tmp', 'sdk-type-generation-'))
  temporary.add(dir)
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await mkdir(join(dir, 'src/entrypoints/sdk'), { recursive: true })
  await copyFile(
    join(root, 'scripts/generate-sdk-types.ts'),
    join(dir, 'scripts/generate-sdk-types.ts'),
  )
  await copyFile(
    join(root, 'src/entrypoints/sdk/controlSchemas.ts'),
    join(dir, 'src/entrypoints/sdk/controlSchemas.ts'),
  )
  await copyFile(
    join(root, 'src/entrypoints/sdk/coreSchemas.ts'),
    join(dir, 'src/entrypoints/sdk/coreSchemas.ts'),
  )
  return dir
}

test('generates real SDK declarations and rejects an empty core schema', async () => {
  const dir = await prepareGenerator()
  const generated = Bun.spawnSync({
    cmd: [process.execPath, 'scripts/generate-sdk-types.ts'],
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(generated.exitCode).toBe(0)
  const core = await readFile(join(dir, 'src/entrypoints/sdk/coreTypes.generated.ts'), 'utf8')
  const control = await readFile(join(dir, 'src/entrypoints/sdk/controlTypes.ts'), 'utf8')
  expect(core).toContain('export type ModelUsage = z.infer<')
  expect(control).toContain("export * from './coreTypes.js'")

  await writeFile(join(dir, 'src/entrypoints/sdk/coreSchemas.ts'), '// no exported schemas\n')
  const rejected = Bun.spawnSync({
    cmd: [process.execPath, 'scripts/generate-sdk-types.ts'],
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr.toString()).toContain('No exported schemas found')
})
```

- [ ] **Step 2: Run the characterization test**

Run: `bun test tests/sdkTypeGeneration.test.ts`

Expected: PASS. The real generator already supports both paths; this test locks the contract rather than adding unrelated behavior. If it fails, fix the test setup or the generator only where the actual behavior differs.

- [ ] **Step 3: Commit Task 2**

```bash
git add tests/sdkTypeGeneration.test.ts
git commit -m "Test SDK type generation contracts"
```

---

### Task 3: Verify Packaged CLI, SDK, and Declarations

**Files:**
- Test: `tests/buildArtifacts.test.ts`

**Interfaces:**
- Consumes: real artifacts produced by `bun run build` and `bun run build:types`.

- [ ] **Step 1: Add the artifact smoke test**

Create `tests/buildArtifacts.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { resolve } from 'path'

const root = resolve(import.meta.dir, '..')

test('packages an executable CLI, importable SDK, and matching declarations', async () => {
  const main = Bun.file(join(root, 'dist/main.js'))
  const sdkFile = Bun.file(join(root, 'dist/sdk.mjs'))
  const declarations = Bun.file(join(root, 'dist/types/entrypoints/agentSdkTypes.d.ts'))
  expect(await main.exists()).toBe(true)
  expect(await main.text()).toStartWith('#!/usr/bin/env bun')
  expect((await main.stat()).mode & 0o111).not.toBe(0)
  expect(await sdkFile.exists()).toBe(true)
  expect(await declarations.exists()).toBe(true)

  const smoke = Bun.spawnSync({
    cmd: [
      process.execPath,
      '-e',
      "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')",
    ],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(smoke.stderr.toString()).toBe('')
  expect(smoke.exitCode).toBe(0)

  const packageJson = await Bun.file(join(root, 'package.json')).json()
  expect(packageJson.exports['.'].import).toBe('./dist/sdk.mjs')
  expect(packageJson.exports['.'].types).toBe('./dist/types/entrypoints/agentSdkTypes.d.ts')
})
```

- [ ] **Step 2: Build and run the smoke test**

Run:

```bash
bun run build
bun test tests/buildArtifacts.test.ts
```

Expected: PASS with real `dist/main.js`, `dist/sdk.mjs`, and declarations. Do not mock the SDK import or artifact filesystem.

- [ ] **Step 3: Commit Task 3**

```bash
git add tests/buildArtifacts.test.ts
git commit -m "Verify CLI and SDK build artifacts"
```

---

### Task 4: Prove Feature Profile Environment Invariance

**Files:**
- Modify: `tests/enabledFeatures.test.ts`

**Interfaces:**
- Produces: `runFeatureProfile(overrides)` returning the parsed profile object and handling child timeout/cleanup.

- [ ] **Step 1: Extract one profile runner**

At the top of `tests/enabledFeatures.test.ts`, below `afterAll`, add:

```ts
async function runFeatureProfile(overrides: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(root, 'tests/fixtures/verify-enabled-features.ts'), outdir],
    cwd: root,
    env: {
      ...process.env,
      ...overrides,
      ANTHROPIC_API_KEY: 'offline-test-placeholder',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ENABLE_TOOL_SEARCH: 'true',
      NODE_ENV: 'production',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill(), 120_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const output = stdout.split('\n').find(line => line.startsWith('FEATURE_PROFILE='))
    expect(output).toBeDefined()
    return JSON.parse(output!.slice('FEATURE_PROFILE='.length))
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
  }
}
```

Replace the body of the existing test with:

```ts
const profile = await runFeatureProfile()
expect(profile.toolCount, JSON.stringify(profile)).toBe(43)
expect(profile.nullCount).toBe(0)
expect(profile.toolNames).toEqual(expect.arrayContaining([
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'Monitor',
  'OverflowTest', 'TerminalCapture', 'Sleep', 'ToolSearch', 'DiscoverSkills',
  'ListPeers', 'Workflow', 'CtxInspect', 'Snip', 'ReviewArtifact',
  'SendUserFile', 'PushNotification', 'SubscribePR', 'WebBrowser',
]))
expect(profile.sleepInitiallyEnabled).toBe(false)
expect(profile.proactiveActive).toBe(true)
expect(profile.sleepWhenActive).toBe(true)
expect(profile.workerType).toBe('worker')
expect(profile.workerBackground).toBe(true)
expect(profile.workerHasBash).toBe(true)
expect(profile.workerHasAgent).toBe(false)
expect(profile.reactiveCompactEnabled).toBe(true)
for (const key of [
  'hasHunterSkill', 'hasProactiveCommand', 'hasPeersCommand',
  'hasRemoteControlServerCommand', 'hasWorkflowsCommand', 'hasBuddyCommand',
  'hasForkCommand', 'hasForceSnipCommand', 'hasAssistantCommand',
  'hasUltraplan', 'hasVoice', 'hasBrief',
]) {
  expect(profile[key]).toBe(true)
}
```

- [ ] **Step 2: Add the two-environment comparison**

Append to the same `describe` block:

```ts
test('produces the same profile under different outer environments', async () => {
  const normal = await runFeatureProfile()
  const overridden = await runFeatureProfile({
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    ENABLE_TOOL_SEARCH: 'false',
  })
  expect(overridden).toEqual(normal)
}, 240_000)
```

This verifies that outer values are applied before the fixed test values and cannot change ToolSearch registration.

- [ ] **Step 3: Run the profile tests**

Run: `bun test tests/enabledFeatures.test.ts`

Expected: both profile tests PASS with 43 tools, zero null entries, and identical profiles. No live API request is required.

- [ ] **Step 4: Commit Task 4**

```bash
git add tests/enabledFeatures.test.ts
git commit -m "Verify feature profile environment invariance"
```

---

### Task 5: Complete Full Verification and Deliver the Plan

**Files:**
- Create: `docs/superpowers/plans/2026-11-12-external-feature-profile.md`

- [ ] **Step 1: Add the plan to the working tree**

Confirm this plan exists at `docs/superpowers/plans/2026-11-12-external-feature-profile.md` and contains no commit mapping or historical execution-result sections.

- [ ] **Step 2: Run the full acceptance sequence**

```bash
bun install --frozen-lockfile
bun run generate:sdk-types
bun run typecheck
bun test tests/externalFeatures.test.ts tests/sdkTypeGeneration.test.ts tests/buildArtifacts.test.ts tests/enabledFeatures.test.ts
bun test
bun run build
bun dist/main.js --version
bun dist/main.js --help
bun -e "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')"
git diff --check
```

Expected: every command exits zero. The profile remains at 43 tools and zero null entries. The legacy commit-level `docs:check` is intentionally excluded: it is superseded by the feature-level documentation workflow and will be replaced in the documentation-tools feature cycle, not used as acceptance for this feature.

- [ ] **Step 3: Commit the implementation plan**

```bash
git add docs/superpowers/plans/2026-11-12-external-feature-profile.md
git commit -m "Plan external feature profile implementation"
```

- [ ] **Step 4: Confirm repository state**

```bash
git status --short --branch
git log --oneline -6
```

Expected: no unstaged implementation or test changes. Do not push or create a PR until the user explicitly requests it.
