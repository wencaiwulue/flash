import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import React from 'react'
import { PassThrough } from 'stream'

const actualOs = await import('os')
let testHome = ''
mock.module('os', () => ({
  ...actualOs,
  homedir: () => testHome,
}))
const actualPlatform = await import('../src/utils/platform.ts')
mock.module('../src/utils/platform.ts', () => ({
  ...actualPlatform,
  getPlatform: () => 'macos',
}))
const actualConfig = await import('../src/utils/config.ts')
let globalConfig: Record<string, unknown> = {}
let browserOpened: string[] = []
let browserResult = true
mock.module('../src/utils/config.ts', () => ({
  ...actualConfig,
  getGlobalConfig: () => globalConfig,
  saveGlobalConfig: (update: (current: Record<string, unknown>) => Record<string, unknown>) => {
    globalConfig = update(globalConfig)
  },
}))
mock.module('../src/utils/browser.ts', () => ({
  openBrowser: async (url: string) => {
    browserOpened.push(url)
    return browserResult
  },
}))

const { readClaudeDesktopMcpServers } = await import('../src/utils/claudeDesktop.ts')
const { detectExtensionInstallationPortable } = await import(
  '../src/utils/claudeInChrome/setupPortable.ts'
)
const { call: mobileCall } = await import('../src/commands/mobile/mobile.tsx')
const { call: installSlackApp } = await import(
  '../src/commands/install-slack-app/install-slack-app.ts'
)
const { render } = await import('../src/ink.ts')
const { KeybindingSetup } = await import('../src/keybindings/KeybindingProviderSetup.tsx')
const { AppStateProvider } = await import('../src/state/AppState.tsx')

let tempRoot = ''
let instance: Awaited<ReturnType<typeof render>> | undefined

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'platform-integrations-'))
  testHome = tempRoot
  globalConfig = {}
  browserOpened = []
  browserResult = true
})

afterEach(() => {
  instance?.unmount()
  instance = undefined
  testHome = ''
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

function streams() {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number }
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
  stdout.columns = 100
  stdout.rows = 40
  return { stdin, stdout, output: () => output }
}

describe('Claude Desktop MCP config', () => {
  test('reads only schema-valid servers and tolerates missing or malformed config', async () => {
    const path = join(testHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        valid: { type: 'stdio', command: 'offline', args: [], env: {} },
        invalid: { type: 'stdio', command: 123 },
      },
    }))

    expect(await readClaudeDesktopMcpServers()).toEqual({
      valid: { type: 'stdio', command: 'offline', args: [], env: {} },
    })
    rmSync(path)
    expect(await readClaudeDesktopMcpServers()).toEqual({})
    writeFileSync(path, '{not-json')
    expect(await readClaudeDesktopMcpServers()).toEqual({})
  })
})

describe('Chrome extension detection', () => {
  test('finds the production extension in a non-default profile and rejects empty paths', async () => {
    const base = join(tempRoot, 'browser')
    const extension = join(base, 'Profile 1', 'Extensions', 'fcoeoabgfenejglbffodgkkbkcdhcgfn')
    mkdirSync(extension, { recursive: true })
    mkdirSync(join(base, 'Default'), { recursive: true })

    expect(await detectExtensionInstallationPortable([{ browser: 'chrome', path: base }])).toEqual({
      isInstalled: true,
      browser: 'chrome',
    })
    expect(await detectExtensionInstallationPortable([])).toEqual({
      isInstalled: false,
      browser: null,
    })
  })
})

describe('Mobile QR code', () => {
  test('generates both store QR codes, switches platform with Tab, and closes with Escape', async () => {
    const io = streams()
    const onDone = mock()
    const element = await mobileCall(onDone)
    instance = await render(
      <AppStateProvider>
        <KeybindingSetup>{element}</KeybindingSetup>
      </AppStateProvider>,
      {
      stdout: io.stdout as unknown as NodeJS.WriteStream,
      stdin: io.stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    await waitFor(() => io.output().includes('apps.apple.com'))
    expect(io.output()).toContain('iOS')
    io.stdin.write('\t')
    await waitFor(() => io.output().includes('play.google.com'))
    io.stdin.write('\x1b')
    await waitFor(() => onDone.mock.calls.length === 1)
  })
})

describe('Slack installation', () => {
  test('opens the marketplace URL and increments install count with a fallback message', async () => {
    expect(await installSlackApp()).toEqual({
      type: 'text',
      value: 'Opening Slack app installation page in browser…',
    })
    expect(globalConfig.slackAppInstallCount).toBe(1)
    expect(browserOpened).toEqual(['https://slack.com/marketplace/A08SF47R6P4-claude'])

    browserResult = false
    expect(await installSlackApp()).toEqual({
      type: 'text',
      value: "Couldn't open browser. Visit: https://slack.com/marketplace/A08SF47R6P4-claude",
    })
    expect(globalConfig.slackAppInstallCount).toBe(2)
  })
})
