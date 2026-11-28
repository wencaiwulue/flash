import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import type { LocalJSXCommandContext } from '../src/commands.ts'
import type { SandboxDependencyCheck } from '../src/utils/sandbox/sandbox-adapter.ts'

const actualSandbox = await import('../src/utils/sandbox/sandbox-adapter.ts')
const actualAddToExcludedCommands = actualSandbox.addToExcludedCommands
const actualBootstrap = await import('../src/bootstrap/state.ts')
mock.module('../src/bootstrap/state.ts', () => ({
  ...actualBootstrap,
  getOriginalCwd: () => tempRoot || originalCwd,
  getCwdState: () => tempRoot || originalCwd,
}))
const sandboxControls = {
  supported: true,
  enabled: true,
  locked: false,
  platform: 'darwin',
  depCheck: { errors: [], warnings: [] } as SandboxDependencyCheck,
  refreshCalls: 0,
  excluded: [] as string[],
}
const manager = Object.create(actualSandbox.SandboxManager) as typeof actualSandbox.SandboxManager
manager.isSupportedPlatform = () => sandboxControls.supported
manager.isPlatformInEnabledList = () => sandboxControls.enabled
manager.areSandboxSettingsLockedByPolicy = () => sandboxControls.locked
manager.checkDependencies = () => sandboxControls.depCheck
manager.refreshConfig = () => {
  sandboxControls.refreshCalls++
}
mock.module('../src/utils/sandbox/sandbox-adapter.ts', () => ({
  SandboxManager: manager,
  addToExcludedCommands: (pattern: string) => {
    sandboxControls.excluded.push(pattern)
    actualAddToExcludedCommands(pattern)
  },
}))
mock.module('../src/utils/platform.ts', () => ({
  getPlatform: () => sandboxControls.platform,
}))

const { call: addDirCall } = await import('../src/commands/add-dir/add-dir.tsx')
const { call: diffCall } = await import('../src/commands/diff/diff.tsx')
const { call: sandboxCall } = await import('../src/commands/sandbox-toggle/sandbox-toggle.tsx')
const { render } = await import('../src/ink.ts')
const { AppStateProvider } = await import('../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../src/keybindings/KeybindingProviderSetup.tsx')
const { TerminalWriteProvider } = await import('../src/ink/useTerminalNotification.ts')
const { resetSettingsCache } = await import('../src/utils/settings/settingsCache.ts')
const {
  getAdditionalDirectoriesForClaudeMd,
  setAdditionalDirectoriesForClaudeMd,
} = await import('../src/bootstrap/state.ts')

const originalCwd = process.cwd()
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalAdditionalDirectories = getAdditionalDirectoriesForClaudeMd()
let tempRoot = ''
let externalDir = ''
let instance: Awaited<ReturnType<typeof render>> | undefined

function resetSandboxControls() {
  sandboxControls.supported = true
  sandboxControls.enabled = true
  sandboxControls.locked = false
  sandboxControls.platform = 'darwin'
  sandboxControls.depCheck = { errors: [], warnings: [] }
  sandboxControls.refreshCalls = 0
  sandboxControls.excluded = []
}

afterEach(() => {
  instance?.unmount()
  instance = undefined
  process.chdir(originalCwd)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  setAdditionalDirectoriesForClaudeMd(originalAdditionalDirectories)
  resetSettingsCache()
  resetSandboxControls()
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
  if (externalDir) rmSync(externalDir, { recursive: true, force: true })
  externalDir = ''
})

afterAll(() => {
  mock.restore()
})

function setup() {
  tempRoot = mkdtempSync(join(tmpdir(), 'workspace-commands-'))
  process.chdir(tempRoot)
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
  resetSettingsCache()
  setAdditionalDirectoriesForClaudeMd([])
  resetSandboxControls()
  externalDir = mkdtempSync(join(tmpdir(), 'workspace-add-dir-'))
  return { validDir: externalDir }
}

function commandContext(): { context: LocalJSXCommandContext; state: ReturnType<typeof getDefaultAppState> } {
  const state = getDefaultAppState()
  const context = {
    getAppState: () => state,
    setAppState: (update: (previous: typeof state) => typeof state) => {
      const next = update(state)
      Object.assign(state, next)
    },
    messages: [],
  } as unknown as LocalJSXCommandContext
  return { context, state }
}

function streams() {
  const stdout = new PassThrough()
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    isRaw: boolean
    setRawMode: (value: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = value => {
    stdin.isRaw = value
  }
  stdin.ref = () => {}
  stdin.unref = () => {}
  return { stdin, stdout, output: () => stripAnsi(output) }
}

async function mount(node: React.ReactNode) {
  const io = streams()
  instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <TerminalWriteProvider value={() => {}}>{node}</TerminalWriteProvider>
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: io.stdout as unknown as NodeJS.WriteStream,
      stdin: io.stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )
  return io
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

describe('/add-dir', () => {
  test('adds a valid directory for the session through the real selection UI', async () => {
    const { validDir } = setup()
    const { context, state } = commandContext()
    const done: string[] = []
    const node = await addDirCall(message => done.push(message ?? ''), context, validDir)
    const io = await mount(node)
    io.stdin.write('\r')
    await waitFor(() => done.length === 1)

    expect(done[0]).toContain('for this session')
    expect(state.toolPermissionContext.additionalWorkingDirectories.has(validDir)).toBe(true)
    expect(getAdditionalDirectoriesForClaudeMd()).toContain(validDir)
    expect(sandboxControls.refreshCalls).toBe(1)
  })

  test('persists remember-directory updates in isolated local settings', async () => {
    const { validDir } = setup()
    const { context } = commandContext()
    const done: string[] = []
    const node = await addDirCall(message => done.push(message ?? ''), context, validDir)
    const io = await mount(node)
    io.stdin.write('\x1b[B')
    await new Promise(resolve => setTimeout(resolve, 20))
    io.stdin.write('\r')
    await waitFor(() => done.length === 1)

    expect(done[0]).toContain('saved to local settings')
    const settingsPath = join(tempRoot, '.claude', 'settings.local.json')
    expect(existsSync(settingsPath)).toBe(true)
    expect(readFileSync(settingsPath, 'utf8')).toContain(validDir)
  })

  test('keeps the session update when local persistence fails', async () => {
    const { validDir } = setup()
    mkdirSync(join(tempRoot, '.claude', 'settings.local.json'), { recursive: true })
    const { context, state } = commandContext()
    const done: string[] = []
    const node = await addDirCall(message => done.push(message ?? ''), context, validDir)
    const io = await mount(node)
    io.stdin.write('\x1b[B')
    await new Promise(resolve => setTimeout(resolve, 20))
    io.stdin.write('\r')
    await waitFor(() => done.length === 1)

    expect(done[0]).toContain('Failed to save to local settings')
    expect(state.toolPermissionContext.additionalWorkingDirectories.has(validDir)).toBe(true)
    expect(getAdditionalDirectoriesForClaudeMd()).toContain(validDir)
  })

  test('rejects a missing directory without changing permissions', async () => {
    const { validDir } = setup()
    const missing = join(validDir, 'missing')
    const { context, state } = commandContext()
    const before = JSON.stringify(state.toolPermissionContext)
    const done: string[] = []
    const node = await addDirCall(message => done.push(message ?? ''), context, missing)
    await mount(node)
    await waitFor(() => done.length === 1)

    expect(done[0]).toContain(missing)
    expect(JSON.stringify(state.toolPermissionContext)).toBe(before)
    expect(getAdditionalDirectoriesForClaudeMd()).not.toContain(missing)
  })

  test('accepts a directory through the no-argument input path', async () => {
    const { validDir } = setup()
    const { context } = commandContext()
    const done: string[] = []
    const node = await addDirCall(message => done.push(message ?? ''), context)
    const io = await mount(node)
    io.stdin.write(validDir)
    await new Promise(resolve => setTimeout(resolve, 100))
    io.stdin.write('\r')
    await waitFor(() => done.length === 1)
    expect(done[0]).toContain('for this session')
    expect(getAdditionalDirectoriesForClaudeMd()).toContain(validDir)
  })

  test('cancels the no-argument form with Escape', async () => {
    setup()
    const { context } = commandContext()
    const done: string[] = []
    const node = await addDirCall(message => done.push(message ?? ''), context)
    const io = await mount(node)
    io.stdin.write('\x1b')
    await waitFor(() => done.length === 1)
    expect(done[0]).toBe('Did not add a working directory.')
  })
})

describe('/diff', () => {
  test('lazy-loads the real dialog and shows a clean temporary git repository', async () => {
    setup()
    execFileSync('git', ['init', '-q'])
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'])
    execFileSync('git', ['config', 'user.name', 'Test User'])
    writeFileSync('tracked.txt', 'initial\n')
    execFileSync('git', ['add', 'tracked.txt'])
    execFileSync('git', ['commit', '-qm', 'initial'])
    const { context } = commandContext()
    const node = await diffCall(() => {}, context)
    const io = await mount(node)
    await waitFor(() => io.output().includes('Working tree is clean'))
    expect(io.output()).toContain('Uncommitted changes')
  })
})

describe('/sandbox-toggle', () => {
  test('rejects unsupported WSL1, disabled platform and policy locking', async () => {
    setup()
    sandboxControls.platform = 'wsl'
    sandboxControls.supported = false
    const wsl: string[] = []
    expect(await sandboxCall(message => wsl.push(message ?? ''), {}, undefined)).toBeNull()
    expect(wsl[0]).toContain('WSL1 is not supported')

    sandboxControls.supported = true
    sandboxControls.enabled = false
    const disabled: string[] = []
    await sandboxCall(message => disabled.push(message ?? ''), {}, undefined)
    expect(disabled[0]).toContain('enabledPlatforms')

    sandboxControls.enabled = true
    sandboxControls.locked = true
    const locked: string[] = []
    await sandboxCall(message => locked.push(message ?? ''), {}, undefined)
    expect(locked[0]).toContain('higher-priority configuration')
  })

  test('validates exclude arguments and writes a valid exclusion in isolated settings', async () => {
    setup()
    const missing: string[] = []
    await sandboxCall(message => missing.push(message ?? ''), {}, 'exclude')
    expect(missing[0]).toContain('Please provide a command pattern')

    const unknown: string[] = []
    await sandboxCall(message => unknown.push(message ?? ''), {}, 'unknown')
    expect(unknown[0]).toContain('Unknown subcommand')

    const done: string[] = []
    await sandboxCall(message => done.push(message ?? ''), {}, 'exclude "npm run test:*"')
    expect(sandboxControls.excluded).toEqual(['npm run test:*'])
    expect(done[0]).toContain('Added "npm run test:*"')
    expect(done[0]).toContain('settings.local.json')
    expect(readFileSync(join(tempRoot, '.claude', 'settings.local.json'), 'utf8')).toContain('npm run test:*')
  })

  test('shows only Dependencies on required errors and all tabs for warnings', async () => {
    setup()
    sandboxControls.depCheck = { errors: ['required missing'], warnings: [] }
    const errorsNode = await sandboxCall(() => {}, {}, undefined)
    const errorsIo = await mount(errorsNode)
    await waitFor(() => errorsIo.output().includes('Dependencies'))
    expect(errorsIo.output()).not.toContain('Overrides')
    instance?.unmount()
    instance = undefined

    sandboxControls.depCheck = { errors: [], warnings: ['optional missing'] }
    const warningsNode = await sandboxCall(() => {}, {}, undefined)
    const warningsIo = await mount(warningsNode)
    await waitFor(() => warningsIo.output().includes('Dependencies'))
    expect(warningsIo.output()).toContain('Mode')
    expect(warningsIo.output()).toContain('Overrides')
    expect(warningsIo.output()).toContain('Config')
  })
})
