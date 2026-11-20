import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { PassThrough } from 'node:stream'
import {
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../src/bootstrap/state.ts'
import { InvalidSettingsDialog } from '../src/components/InvalidSettingsDialog.tsx'
import { createRoot, type Root } from '../src/ink.ts'
import { KeybindingSetup } from '../src/keybindings/KeybindingProviderSetup.tsx'
import { AppStateProvider } from '../src/state/AppState.tsx'
import type { ValidationError } from '../src/utils/settings/validation.ts'

const warning: ValidationError = {
  file: 'settings.json',
  path: 'hooks.Future',
  message: 'Unknown hook event was ignored',
  severity: 'warning',
}
const error: ValidationError = {
  file: 'settings.json',
  path: 'model',
  message: 'Expected string, but received number',
  severity: 'error',
}

let rootDir = ''
let previousCwd = ''
let activeRoot: Root | undefined

function streamPair() {
  const stdout = new PassThrough() as NodeJS.WriteStream
  Object.assign(stdout, { columns: 120, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as NodeJS.ReadStream
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode: (mode: boolean) => {
      Object.assign(stdin, { isRaw: mode })
      return stdin
    },
    ref: () => stdin,
    unref: () => stdin,
  })
  return { stdin, stdout, output: () => output }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for dialog update')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function mount(
  errors: ValidationError[],
  onContinue: () => void = () => {},
  onExit: () => void = () => {},
) {
  const streams = streamPair()
  activeRoot = await createRoot({
    stdin: streams.stdin,
    stdout: streams.stdout,
    stderr: streams.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  activeRoot.render(
    <AppStateProvider>
      <KeybindingSetup>
        <InvalidSettingsDialog
          settingsErrors={errors}
          onContinue={onContinue}
          onExit={onExit}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )
  await waitFor(() => streams.output().includes('Settings '))
  return streams
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'invalid-settings-dialog-'))
  previousCwd = getOriginalCwd()
  setOriginalCwd(rootDir)
  setCwdState(rootDir)
})

afterEach(async () => {
  activeRoot?.unmount()
  activeRoot = undefined
  setOriginalCwd(previousCwd)
  setCwdState(previousCwd)
  await rm(rootDir, { recursive: true, force: true })
})

describe('InvalidSettingsDialog severity', () => {
  test('warning-only explains partial recovery and offers only Continue', async () => {
    const streams = await mount([warning])
    expect(streams.output()).toContain('Settings Warning')
    expect(streams.output()).toContain('Invalid entries were skipped')
    expect(streams.output()).toContain('valid settings remain active')
    expect(streams.output()).toContain('Continue')
    expect(streams.output()).not.toContain('Settings Error')
    expect(streams.output()).not.toContain('Exit and fix manually')
    expect(streams.output()).not.toContain('Continue without these settings')
  })

  test('error-only retains the whole-file failure and Exit option', async () => {
    const streams = await mount([error])
    expect(streams.output()).toContain('Settings Error')
    expect(streams.output()).toContain('Files with errors are skipped entirely')
    expect(streams.output()).toContain('Exit and fix manually')
  })

  test('mixed diagnostics use error presentation and list all paths', async () => {
    const streams = await mount([warning, error])
    expect(streams.output()).toContain('Settings Error')
    expect(streams.output()).toContain('Exit and fix manually')
    expect(streams.output()).toContain('hooks')
    expect(streams.output()).toContain('Future')
    expect(streams.output()).toContain('model')
  })

  test('Enter on warning-only continues without exiting', async () => {
    let continued = 0
    let exited = 0
    const streams = await mount([warning], () => continued++, () => exited++)
    streams.stdin.write('\r')
    await waitFor(() => continued === 1)
    expect(continued).toBe(1)
    expect(exited).toBe(0)
  })

  test('Escape on warning-only continues without exiting', async () => {
    let continued = 0
    let exited = 0
    const streams = await mount([warning], () => continued++, () => exited++)
    streams.stdin.write('')
    await waitFor(() => continued === 1)
    expect(continued).toBe(1)
    expect(exited).toBe(0)
  })

  for (const [name, errors] of [
    ['error-only', [error]],
    ['mixed', [warning, error]],
  ] as const) {
    test(`${name} Enter selects Exit`, async () => {
      let continued = 0
      let exited = 0
      const streams = await mount(errors, () => continued++, () => exited++)
      streams.stdin.write('\r')
      await waitFor(() => exited === 1)
      expect(continued).toBe(0)
      expect(exited).toBe(1)
    })

    test(`${name} Down and Enter selects Continue`, async () => {
      let continued = 0
      let exited = 0
      const streams = await mount(errors, () => continued++, () => exited++)
      const outputBeforeSelection = streams.output().length
      streams.stdin.write('[B')
      await waitFor(() => streams.output().length > outputBeforeSelection)
      streams.stdin.write('\r')
      await waitFor(() => continued === 1)
      expect(continued).toBe(1)
      expect(exited).toBe(0)
    })

    test(`${name} Escape exits without continuing`, async () => {
      let continued = 0
      let exited = 0
      const streams = await mount(errors, () => continued++, () => exited++)
      streams.stdin.write('')
      await waitFor(() => exited === 1)
      expect(continued).toBe(0)
      expect(exited).toBe(1)
    })
  }
})
