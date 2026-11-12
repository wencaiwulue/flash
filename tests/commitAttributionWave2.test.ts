import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { AppState } from '../src/state/AppStateStore.ts'
import type { HookCallback, HookCallbackContext } from '../src/types/hooks.ts'
import type { HookInput } from '../src/entrypoints/agentSdkTypes.ts'
import {
  clearRegisteredHooks,
  getOriginalCwd,
  getRegisteredHooks,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../src/bootstrap/state.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { execFileNoThrowWithCwd } from '../src/utils/execFileNoThrow.ts'
import {
  buildPRTrailers,
} from '../src/utils/attributionTrailer.ts'
import {
  createEmptyAttributionState,
  restoreAttributionStateFromSnapshots,
  stateToSnapshotMessage,
  trackFileModification,
} from '../src/utils/commitAttribution.ts'
import {
  clearAttributionCaches,
  flushAttributionPersistence,
  registerAttributionHooks,
} from '../src/utils/attributionHooks.ts'
import {
  installPrepareCommitMsgHook,
  persistAttributionStateForGit,
  runPrepareCommitMsgAttribution,
  uninstallPrepareCommitMsgHook,
} from '../src/utils/postCommitAttribution.ts'

const recordAttributionSnapshot = mock(async () => {})
mock.module('../src/utils/sessionStorage.ts', () => ({
  recordAttributionSnapshot,
}))

let root = ''
let previousCwd = ''
let previousArgv1 = ''
let previousEnv: Record<string, string | undefined> = {}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'global-gitconfig'),
  }
}

async function git(args: string[], cwd = root): Promise<string> {
  const result = await execFileNoThrowWithCwd('git', args, {
    cwd,
    env: gitEnv(),
    timeout: 20_000,
  })
  expect(result.code).toBe(0)
  return result.stdout.trim()
}

function hookContext(): {
  context: HookCallbackContext
  state: () => AppState
} {
  let appState = getDefaultAppState()
  return {
    state: () => appState,
    context: {
      getAppState: () => appState,
      updateAttributionState: updater => {
        const attribution = updater(appState.attribution)
        if (attribution !== appState.attribution) {
          appState = { ...appState, attribution }
        }
      },
    },
  }
}

function registeredCallback(
  event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
  matcher: string,
): HookCallback {
  const found = getRegisteredHooks()?.[event]?.find(
    candidate => candidate.matcher === matcher,
  )
  const callback = found?.hooks[0]
  if (!callback || callback.type !== 'callback') throw new Error('Hook not registered')
  return callback
}

async function invoke(
  callback: HookCallback,
  input: HookInput,
  context: HookCallbackContext,
  id = 'tool-1',
): Promise<void> {
  await callback.callback(input, id, undefined, undefined, context)
}

function baseInput(
  event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
  toolName: string,
  toolInput: unknown,
  toolResponse?: unknown,
): HookInput {
  return {
    session_id: 'wave2-test',
    transcript_path: join(root, 'transcript.jsonl'),
    cwd: root,
    hook_event_name: event,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-1',
    ...(event === 'PostToolUse'
      ? { tool_response: toolResponse }
      : event === 'PostToolUseFailure'
        ? { tool_use_error: 'failed', is_interrupt: false }
        : {}),
  } as HookInput
}

beforeAll(() => {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: '1.0.0',
      BUILD_TIME: '',
      PACKAGE_URL: '',
      NATIVE_PACKAGE_URL: '',
      VERSION_CHANGELOG: '',
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
    },
  })
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'commit-attribution-wave2-'))
  previousCwd = getOriginalCwd()
  previousArgv1 = process.argv[1]!
  previousEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  }
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.HOME = join(root, 'home')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = join(root, 'global-gitconfig')
  await mkdir(process.env.HOME, { recursive: true })
  setOriginalCwd(root)
  setCwdState(root)
  setProjectRoot(root)
  clearRegisteredHooks()
  clearAttributionCaches()
  recordAttributionSnapshot.mockClear()
})

afterEach(async () => {
  clearAttributionCaches()
  clearRegisteredHooks()
  setOriginalCwd(previousCwd)
  setCwdState(previousCwd)
  setProjectRoot(previousCwd)
  process.argv[1] = previousArgv1
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

test('registration is idempotent and Write validates output before tracking', async () => {
  await git(['init'])
  registerAttributionHooks()
  registerAttributionHooks()
  expect(getRegisteredHooks()?.PostToolUse).toHaveLength(3)
  const callback = registeredCallback('PostToolUse', 'Write')
  const { context, state } = hookContext()
  const filePath = join(root, 'created.txt')
  await writeFile(filePath, 'new content')
  const validInput = { file_path: filePath, content: 'new content' }
  const validOutput = {
    type: 'create',
    filePath,
    content: 'new content',
    structuredPatch: [],
    originalFile: null,
  }
  await invoke(
    callback,
    baseInput('PostToolUse', 'Write', validInput, validOutput),
    context,
  )
  expect(state().attribution.fileStates.get('created.txt')?.claudeContribution).toBe(
    11,
  )
  expect(recordAttributionSnapshot).toHaveBeenCalledTimes(1)
  await flushAttributionPersistence()

  await invoke(
    callback,
    baseInput('PostToolUse', 'Write', validInput, { filePath }),
    context,
  )
  expect(recordAttributionSnapshot).toHaveBeenCalledTimes(1)
  expect(state().attribution.sessionBaselines.has('created.txt')).toBeTrue()
})

test('Bash pre/post pairs bulk create, modify and delete; failure and clear skip', async () => {
  await git(['init'])
  await git(['config', 'user.name', 'Wave2 Test'])
  await git(['config', 'user.email', 'wave2@example.invalid'])
  await writeFile(join(root, 'modify.txt'), 'committed')
  await git(['add', 'modify.txt'])
  await git(['commit', '-m', 'baseline'])
  // Make the existing file visible to the bounded pre-command candidate set.
  await writeFile(join(root, 'modify.txt'), 'before')
  await writeFile(join(root, 'delete.txt'), 'delete me')

  registerAttributionHooks()
  const pre = registeredCallback('PreToolUse', 'Bash')
  const post = registeredCallback('PostToolUse', 'Bash')
  const failure = registeredCallback('PostToolUseFailure', 'Bash')
  const { context, state } = hookContext()
  await invoke(pre, baseInput('PreToolUse', 'Bash', { command: 'edit' }), context)
  await writeFile(join(root, 'modify.txt'), 'after')
  await writeFile(join(root, 'created.txt'), 'created')
  await rm(join(root, 'delete.txt'))
  await invoke(
    post,
    baseInput('PostToolUse', 'Bash', { command: 'edit' }, { stdout: '' }),
    context,
  )
  expect(state().attribution.fileStates.get('modify.txt')?.claudeContribution).toBeGreaterThan(0)
  expect(state().attribution.fileStates.get('created.txt')?.claudeContribution).toBe(7)
  expect(state().attribution.fileStates.get('delete.txt')?.claudeContribution).toBe(9)

  await invoke(pre, baseInput('PreToolUse', 'Bash', { command: 'fail' }), context, 'failed-tool')
  await invoke(
    failure,
    baseInput('PostToolUseFailure', 'Bash', { command: 'fail' }),
    context,
    'failed-tool',
  )
  await writeFile(join(root, 'created.txt'), 'not tracked after failure')
  await invoke(
    post,
    baseInput('PostToolUse', 'Bash', { command: 'fail' }, { stdout: '' }),
    context,
    'failed-tool',
  )
  expect(state().attribution.fileStates.get('created.txt')?.contentHash).not.toBe('')

  clearAttributionCaches()
  await invoke(pre, baseInput('PreToolUse', 'Bash', { command: 'clear' }), context, 'cleared')
  clearAttributionCaches()
  await writeFile(join(root, 'created.txt'), 'also not tracked')
  await invoke(
    post,
    baseInput('PostToolUse', 'Bash', { command: 'clear' }, { stdout: '' }),
    context,
    'cleared',
  )
  expect(state().attribution.fileStates.get('created.txt')?.claudeContribution).toBe(7)
})

test('HEAD reconciliation advances commit counters once only after a commit', async () => {
  await git(['init'])
  await git(['config', 'user.name', 'Wave2 Test'])
  await git(['config', 'user.email', 'wave2@example.invalid'])
  await writeFile(join(root, 'base.txt'), 'base')
  await git(['add', 'base.txt'])
  await git(['commit', '-m', 'baseline'])
  registerAttributionHooks()
  const pre = registeredCallback('PreToolUse', 'Bash')
  const post = registeredCallback('PostToolUse', 'Bash')
  const { context, state } = hookContext()
  Object.assign(state().attribution, {
    promptCount: 3,
    permissionPromptCount: 2,
    escapeCount: 1,
  })
  await invoke(pre, baseInput('PreToolUse', 'Bash', { command: 'commit' }), context)
  const startingHead = state().attribution.startingHeadSha
  expect(startingHead).toBe(await git(['rev-parse', 'HEAD']))
  expect(state().attribution.promptCountAtLastCommit).toBe(0)

  await writeFile(join(root, 'base.txt'), 'committed')
  await git(['add', 'base.txt'])
  await git(['commit', '-m', 'successful commit'])
  await invoke(
    post,
    baseInput('PostToolUse', 'Bash', { command: 'commit' }, { stdout: '' }),
    context,
  )
  expect(state().attribution.promptCountAtLastCommit).toBe(3)
  expect(state().attribution.permissionPromptCountAtLastCommit).toBe(2)
  expect(state().attribution.escapeCountAtLastCommit).toBe(1)
  expect(state().attribution.startingHeadSha).not.toBe(startingHead)
  const snapshots = recordAttributionSnapshot.mock.calls.length
  await invoke(
    post,
    baseInput('PostToolUse', 'Bash', { command: 'commit' }, { stdout: '' }),
    context,
  )
  expect(recordAttributionSnapshot.mock.calls.length).toBe(snapshots)
})

test('full snapshots restore baselines once without cross-snapshot inflation', () => {
  let state = createEmptyAttributionState()
  state = trackFileModification(state, 'a.txt', 'old', 'new', false, 1)
  state.sessionBaselines.set('a.txt', { contentHash: 'baseline', mtime: 1 })
  state.startingHeadSha = 'abc123'
  const first = stateToSnapshotMessage(state, randomUUID())
  state = trackFileModification(state, 'a.txt', 'new', 'newer', false, 2)
  const second = stateToSnapshotMessage(state, randomUUID())
  const restored = restoreAttributionStateFromSnapshots([first, second])
  expect(restored.fileStates.get('a.txt')?.claudeContribution).toBe(
    state.fileStates.get('a.txt')?.claudeContribution,
  )
  expect(restored.sessionBaselines.get('a.txt')?.contentHash).toBe('baseline')
  expect(restored.startingHeadSha).toBe('abc123')
  expect(second.sessionBaselines?.['a.txt']?.contentHash).toBe('baseline')
})

test('public trailers are ordered, numeric, non-negative and path-free', () => {
  const state = createEmptyAttributionState()
  Object.assign(state, {
    promptCount: 4,
    promptCountAtLastCommit: 1,
    permissionPromptCount: 2,
    permissionPromptCountAtLastCommit: 3,
    escapeCount: 1,
    escapeCountAtLastCommit: 0,
  })
  const trailers = buildPRTrailers(
    {
      version: 1,
      summary: {
        claudePercent: 67,
        claudeChars: 20,
        humanChars: 10,
        surfaces: ['cli/internal-secret-model'],
      },
      files: { '/private/secret.ts': { claudeChars: 20, humanChars: 0, percent: 100, surface: 'secret' } },
      surfaceBreakdown: {},
      excludedGenerated: [],
      sessions: ['session-secret'],
    },
    state,
  )
  expect(trailers).toEqual([
    'Claude-Code-Contribution: 67',
    'Claude-Code-Prompts: 3',
    'Claude-Code-Escapes: 1',
  ])
  expect(trailers.join('\n')).not.toContain('secret')
  expect(buildPRTrailers(
    { version: 1, summary: { claudePercent: 0, claudeChars: 0, humanChars: 0, surfaces: [] }, files: {}, surfaceBreakdown: {}, excludedGenerated: [], sessions: [] },
    createEmptyAttributionState(),
  )).toEqual([])
})

describe('prepare-commit-msg installation', () => {
  beforeEach(async () => {
    await git(['init'])
    await git(['config', 'user.name', 'Wave2 Test'])
    await git(['config', 'user.email', 'wave2@example.invalid'])
    process.argv[1] = resolve(process.cwd(), 'src/entrypoints/cli.tsx')
  })

  test('preserves an executable user hook, markers, managed trailers and uninstall', async () => {
    const hooks = join(root, '.git', 'hooks')
    const userHook = join(hooks, 'prepare-commit-msg')
    await writeFile(userHook, '#!/bin/sh\nprintf "user-marker\\nClaude-Code-Contribution: 1\\nX-User-Trailer: keep\\n" >> "$1"\n')
    const { chmod } = await import('fs/promises')
    await chmod(userHook, 0o755)
    const first = await readFile(userHook, 'utf8')
    await Promise.all(
      Array.from({ length: 4 }, () => installPrepareCommitMsgHook(root)),
    )
    const managed = await readFile(userHook, 'utf8')
    await installPrepareCommitMsgHook(root)
    expect(await readFile(userHook, 'utf8')).toBe(managed)
    expect((await stat(join(hooks, 'prepare-commit-msg.claude-user'))).mode & 0o111).toBeGreaterThan(0)

    const filePath = join(root, 'tracked.txt')
    await writeFile(filePath, 'new content')
    let state = createEmptyAttributionState()
    state = trackFileModification(state, 'tracked.txt', '', 'new content', false)
    state.promptCount = 2
    await persistAttributionStateForGit(stateToSnapshotMessage(state, randomUUID()))
    await git(['add', 'tracked.txt'])
    await writeFile(join(root, '.git', 'COMMIT_EDITMSG'), 'subject\n')
    await runPrepareCommitMsgAttribution(root, '.git/COMMIT_EDITMSG')
    expect(await readFile(join(root, '.git', 'COMMIT_EDITMSG'), 'utf8')).toContain('Co-Authored-By:')
    await git(['commit', '-m', 'subject'])
    const message = await git(['log', '-1', '--pretty=%B'])
    expect(message).toContain('user-marker')
    expect(message).toContain('Co-Authored-By:')
    expect(message).toContain('Claude-Code-Contribution: 100')
    expect(message).toContain('Claude-Code-Prompts: 2')
    expect(message).toContain('X-User-Trailer: keep')
    expect(message.match(/Claude-Code-Contribution:/g)).toHaveLength(1)

    await uninstallPrepareCommitMsgHook(root)
    expect(await readFile(userHook, 'utf8')).toBe(first)
  })

  test('a failing user hook stops the commit before Claude attribution', async () => {
    const hooks = join(root, '.git', 'hooks')
    await writeFile(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\nexit 23\n')
    const { chmod } = await import('fs/promises')
    await chmod(join(hooks, 'prepare-commit-msg'), 0o755)
    await installPrepareCommitMsgHook(root)
    await writeFile(join(root, 'file.txt'), 'content')
    let state = createEmptyAttributionState()
    state = trackFileModification(state, 'file.txt', '', 'content', false)
    await persistAttributionStateForGit(stateToSnapshotMessage(state, randomUUID()))
    await git(['add', 'file.txt'])
    const result = await execFileNoThrowWithCwd('git', ['commit', '-m', 'blocked'], {
      cwd: root,
      env: gitEnv(),
      timeout: 20_000,
    })
    expect(result.code).not.toBe(0)
    const message = await readFile(join(root, '.git', 'COMMIT_EDITMSG'), 'utf8')
    expect(message).not.toContain('Co-Authored-By:')
    expect(message).not.toContain('Claude-Code-Contribution:')
  })

  test('honors core.hooksPath and refuses to overwrite a second user backup', async () => {
    await git(['config', 'core.hooksPath', 'custom-hooks'])
    await installPrepareCommitMsgHook(root)
    const hook = join(root, 'custom-hooks', 'prepare-commit-msg')
    expect((await stat(hook)).mode & 0o111).toBeGreaterThan(0)
    await writeFile(join(root, 'custom-hooks', 'prepare-commit-msg.claude-user'), 'second')
    // Replace our dispatcher with a new user hook: installation must now stop.
    await writeFile(hook, '#!/bin/sh\nexit 0\n')
    await expect(installPrepareCommitMsgHook(root)).rejects.toThrow('already exists')
  })
})
