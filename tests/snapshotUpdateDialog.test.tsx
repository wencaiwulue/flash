import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'stream'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRoot, type Root } from '../src/ink.ts'
import { KeybindingSetup } from '../src/keybindings/KeybindingProviderSetup.tsx'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { SnapshotUpdateDialog, type SnapshotUpdateChoice } from '../src/components/agents/SnapshotUpdateDialog.tsx'
import {
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../src/bootstrap/state.ts'

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

async function mount(
  onComplete: (choice: SnapshotUpdateChoice) => void,
  onCancel: () => void,
  onApply?: (choice: SnapshotUpdateChoice) => Promise<void>,
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
        <SnapshotUpdateDialog
          agentType="coder"
          scope="project"
          snapshotTimestamp="2026-11-11T01:02:03.000Z"
          onComplete={onComplete}
          onCancel={onCancel}
          onApply={onApply}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )
  await new Promise(resolve => setTimeout(resolve, 40))
  return streams
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'snapshot-dialog-'))
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

describe('SnapshotUpdateDialog choices', () => {
  test('shows paths and defaults to non-destructive Merge', async () => {
    const choices: SnapshotUpdateChoice[] = []
    const streams = await mount(choice => choices.push(choice), () => {})
    expect(streams.output()).toContain('Merge')
    expect(streams.output()).toContain('Keep local')
    expect(streams.output()).toContain('Replace with snapshot')
    expect(streams.output()).toContain('agent-memory-snapshots')
    streams.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(choices).toEqual(['merge'])
  })

  test('Keep local and Replace require their distinct actions', async () => {
    let choice: SnapshotUpdateChoice | undefined
    let streams = await mount(value => {
      choice = value
    }, () => {})
    streams.stdin.write('[B')
    await new Promise(resolve => setTimeout(resolve, 30))
    streams.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(choice).toBe('keep')
    activeRoot?.unmount()

    choice = undefined
    streams = await mount(value => {
      choice = value
    }, () => {})
    streams.stdin.write('[B')
    await new Promise(resolve => setTimeout(resolve, 30))
    streams.stdin.write('[B')
    await new Promise(resolve => setTimeout(resolve, 30))
    streams.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(choice).toBeUndefined()
    expect(streams.output()).toContain('Confirm snapshot replacement')
    // Default confirmation focus is Back; moving down selects replacement.
    streams.stdin.write('[B')
    await new Promise(resolve => setTimeout(resolve, 30))
    streams.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(choice).toBe('replace')
  })

  test('an in-flight operation cannot be submitted twice', async () => {
    let resolveApply!: () => void
    let applies = 0
    let completed = 0
    const streams = await mount(
      () => completed++,
      () => {},
      () => {
        applies++
        return new Promise<void>(resolve => {
          resolveApply = resolve
        })
      },
    )
    streams.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    streams.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(applies).toBe(1)
    resolveApply()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(completed).toBe(1)
  })

  test('Ctrl+C is cancel rather than Keep or process exit', async () => {
    let cancelled = 0
    let applied = 0
    const streams = await mount(
      () => {},
      () => cancelled++,
      async () => {
        applied++
      },
    )
    streams.stdin.write('')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(cancelled).toBe(1)
    expect(applied).toBe(0)
  })

  test('Escape cancels without applying and confirmation Escape goes back', async () => {
    let cancelled = 0
    let applied = 0
    let streams = await mount(
      () => {},
      () => cancelled++,
      async () => {
        applied++
      },
    )
    streams.stdin.write('')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(cancelled).toBe(1)
    expect(applied).toBe(0)
    activeRoot?.unmount()

    cancelled = 0
    streams = await mount(
      () => {},
      () => cancelled++,
      async () => {
        applied++
      },
    )
    streams.stdin.write('[B')
    await new Promise(resolve => setTimeout(resolve, 30))
    streams.stdin.write('[B')
    await new Promise(resolve => setTimeout(resolve, 30))
    streams.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    streams.stdin.write('')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(streams.output()).toContain('Choose how to handle this snapshot version')
    expect(cancelled).toBe(0)
    expect(applied).toBe(0)
  })
})
