import { afterEach, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { DiffDialog } from '../src/components/diff/DiffDialog.tsx'
import { Select } from '../src/components/CustomSelect/select.tsx'
import {
  computeUnseenDivider,
  countUnseenAssistantTurns,
  useUnseenDivider,
} from '../src/components/FullscreenLayout.tsx'
import { useRegisterOverlay } from '../src/context/overlayContext.tsx'
import { render, Text } from '../src/ink.ts'
import type { ScrollBoxHandle } from '../src/ink/components/ScrollBox.tsx'
import { TerminalSizeContext } from '../src/ink/components/TerminalSizeContext.tsx'
import instances from '../src/ink/instances.ts'
import { TerminalWriteProvider } from '../src/ink/useTerminalNotification.ts'
import { KeybindingSetup } from '../src/keybindings/KeybindingProviderSetup.tsx'
import { AppStateProvider, useAppStateStore, type AppStateStore } from '../src/state/AppState.tsx'
import type { Message } from '../src/types/message.ts'

const originalCwd = process.cwd()
const originalNoFlicker = process.env.CLAUDE_CODE_NO_FLICKER
let tempRoot = ''
let instance: Awaited<ReturnType<typeof render>> | undefined

function setupGitRepo(): void {
  tempRoot = mkdtempSync(join(tmpdir(), 'workspace-components-'))
  execFileSync('git', ['init', '-q'], { cwd: tempRoot })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tempRoot })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempRoot })
  writeFileSync(join(tempRoot, 'tracked.txt'), 'initial\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: tempRoot })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: tempRoot })
  process.chdir(tempRoot)
}

afterEach(() => {
  instance?.unmount()
  instance = undefined
  process.chdir(originalCwd)
  if (originalNoFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
  else process.env.CLAUDE_CODE_NO_FLICKER = originalNoFlicker
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

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

async function mount(node: React.ReactNode, columns = 80) {
  const io = streams()
  instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <TerminalSizeContext.Provider value={{ columns, rows: 16 }}>
          <TerminalWriteProvider value={() => {}}>{node}</TerminalWriteProvider>
        </TerminalSizeContext.Provider>
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

function userPrompt(text: string, uuid: string): Message {
  return { type: 'user', message: { content: text }, uuid } as Message
}

function editResult(filePath: string, before = 'before', after = 'after'): Message {
  return {
    type: 'user',
    uuid: `edit-${filePath}`,
    message: { content: [] },
    toolUseResult: {
      filePath,
      structuredPatch: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [`-${before}`, `+${after}`],
      }],
    },
  } as Message
}

function turnMessages(fileCount = 1): Message[] {
  return [
    userPrompt('Edit files', 'prompt'),
    ...Array.from({ length: fileCount }, (_, i) => editResult(`src/file-${i}.ts`)),
  ]
}

describe('DiffDialog', () => {
  test('switches current/turn sources and enters/leaves detail mode', async () => {
    setupGitRepo()
    const done: string[] = []
    const io = await mount(<DiffDialog messages={turnMessages()} onDone={result => done.push(result ?? '')} />)
    await waitFor(() => io.output().includes('Uncommitted changes'))
    io.stdin.write('\x1b[C')
    await waitFor(() => io.output().includes('Turn 1'))
    expect(io.output()).toContain('src/file-0.ts')

    io.stdin.write('\r')
    await waitFor(() => io.output().includes('before'))
    expect(io.output()).toContain('after')
    io.stdin.write('\x1b')
    await new Promise(resolve => setTimeout(resolve, 20))
    io.stdin.write('\x1b')
    await waitFor(() => done.length === 1)
  })

  test('paginates six files with a below indicator', async () => {
    setupGitRepo()
    const io = await mount(<DiffDialog messages={turnMessages(6)} onDone={() => {}} />)
    io.stdin.write('\x1b[C')
    await waitFor(() => io.output().includes('Turn 1'))
    expect(io.output()).toContain('↓ 1 more file')
    expect(io.output()).toContain('src/file-0.ts')
    expect(io.output()).toContain('src/file-4.ts')
    expect(io.output()).not.toContain('src/file-5.ts')
  })
})

describe('CustomSelect', () => {
  test('supports keyboard navigation, disabled options and cancellation', async () => {
    const changes: string[] = []
    const cancellations: string[] = []
    const io = await mount(
      <Select
        options={[
          { label: 'Disabled', value: 'disabled', disabled: true },
          { label: 'Second', value: 'second' },
          { label: 'Third', value: 'third' },
        ]}
        onChange={value => changes.push(value)}
        onCancel={() => cancellations.push('cancel')}
      />,
    )
    io.stdin.write('\x1b[B')
    await new Promise(resolve => setTimeout(resolve, 20))
    io.stdin.write('\r')
    await waitFor(() => changes.length === 1)
    expect(changes).toEqual(['second'])
    io.stdin.write('\x1b')
    await waitFor(() => cancellations.length === 1)
  })

  test('accepts input options with onInputModeToggle and preserves typed text', async () => {
    const changes: string[] = []
    const io = await mount(
      <Select
        options={[{ type: 'input', label: 'Custom', value: 'custom', onChange: () => {}, placeholder: 'path' }]}
        onChange={value => changes.push(value)}
        onInputModeToggle={() => {}}
      />,
    )
    io.stdin.write('\t')
    io.stdin.write('abc')
    await waitFor(() => io.output().includes('abc'))
    io.stdin.write('\r')
    await waitFor(() => changes.length === 1)
    expect(changes).toEqual(['custom'])
  })
})

describe('overlay registration', () => {
  test('registers modal state, removes it and invalidates the previous frame', async () => {
    let store: AppStateStore | undefined
    function Capture(): React.ReactNode {
      store = useAppStateStore()
      return null
    }
    function Overlay({ id }: { id: string }): React.ReactNode {
      useRegisterOverlay(id)
      return null
    }
    await mount(<><Capture /><Overlay id="select" /></>)
    await waitFor(() => store!.getState().activeOverlays.has('select'))
    const invalidate = mock(() => {})
    const previousInk = instances.get(process.stdout)
    instances.set(process.stdout, { invalidatePrevFrame: invalidate } as any)
    instance!.unmount()
    instance = undefined
    await waitFor(() => !store!.getState().activeOverlays.has('select'))
    expect(invalidate).toHaveBeenCalled()
    if (previousInk) instances.set(process.stdout, previousInk)
    else instances.delete(process.stdout)

    await mount(<><Capture /><Overlay id="autocomplete" /></>)
    await waitFor(() => store!.getState().activeOverlays.has('autocomplete'))
    expect(store!.getState().activeOverlays.has('autocomplete')).toBe(true)
  })
})

describe('unseen divider helpers', () => {
  test('counts text turns but floors tool-only activity at one', () => {
    const messages = [
      { type: 'assistant', uuid: 'tool', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
      { type: 'assistant', uuid: 'text', message: { content: [{ type: 'text', text: 'answer' }] } },
      userPrompt('next', 'next'),
      { type: 'assistant', uuid: 'tool-2', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] } },
      { type: 'assistant', uuid: 'text-2', message: { content: [{ type: 'text', text: 'second answer' }] } },
    ] as Message[]
    expect(countUnseenAssistantTurns(messages, 0)).toBe(2)
    expect(computeUnseenDivider(messages.slice(0, 1), 0)).toEqual({ firstUnseenUuid: 'tool', count: 1 })
    expect(computeUnseenDivider(messages, null)).toBeUndefined()
  })

  test('snapshots once, shifts and repins with real hook state', async () => {
    let api: ReturnType<typeof useUnseenDivider>
    function Harness(): React.ReactNode {
      api = useUnseenDivider(5)
      return null
    }
    instance = await render(<Harness />)
    const handle: ScrollBoxHandle = {
      scrollTo: mock(),
      scrollBy: mock(),
      scrollToElement: mock(),
      scrollToBottom: mock(),
      getScrollTop: () => 0,
      getPendingDelta: () => 0,
      getScrollHeight: () => 100,
      getFreshScrollHeight: () => 100,
      getViewportHeight: () => 10,
      getViewportTop: () => 0,
      isSticky: () => false,
      subscribe: () => () => {},
      setClampBounds: () => {},
    }
    api!.onScrollAway(handle)
    await waitFor(() => api!.dividerIndex === 5)
    expect(api!.dividerYRef.current).toBe(100)
    api!.onScrollAway(handle)
    expect(api!.dividerYRef.current).toBe(100)

    api!.shiftDivider(-2, -10)
    await waitFor(() => api!.dividerIndex === 3)
    expect(api!.dividerYRef.current).toBe(90)
    api!.jumpToNew(handle)
    expect(handle.scrollToBottom).toHaveBeenCalled()
    api!.onRepin()
    await waitFor(() => api!.dividerIndex === null)
    await waitFor(() => api!.dividerYRef.current === null)
  })
})
