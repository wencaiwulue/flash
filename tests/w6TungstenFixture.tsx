import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'stream'

const calls: Array<{ file: string; args: string[] }> = []

mock.module('../src/utils/execFileNoThrow.ts', () => ({
  execFileNoThrow: async (file: string, args: string[]) => {
    calls.push({ file, args })
    if (file === 'which') return { stdout: '/fake/tmux\n', stderr: '', code: 0 }
    if (args.includes('display-message') && args.includes('#{socket_path},#{pid}')) {
      return { stdout: '/tmp/claude-test,4242\n', stderr: '', code: 0 }
    }
    if (args.includes('list-sessions')) {
      return { stdout: 'base\t1\t0\nwork\t1\t0\n', stderr: '', code: 0 }
    }
    if (args.includes('capture-pane')) {
      return { stdout: 'real pane output\n', stderr: '', code: 0 }
    }
    if (args.includes('display-message') && args.includes('#{pane_current_command}')) {
      return { stdout: 'bash\n', stderr: '', code: 0 }
    }
    if (args.includes('new-session') && args.includes('-P')) {
      return { stdout: 'work:0.0\n', stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  },
  execFileNoThrowWithCwd: async () => ({ stdout: '', stderr: '', code: 0 }),
  execSyncWithDefaults_DEPRECATED: () => ({ stdout: '', stderr: '', code: 0 }),
}))

const { TungstenTool, clearSessionsWithTungstenUsage, resetInitializationState } =
  await import('../src/tools/TungstenTool/TungstenTool.js')
const { resetSocketState } = await import('../src/utils/tmuxSocket.js')
const { TungstenLiveMonitor } = await import('../src/tools/TungstenTool/TungstenLiveMonitor.js')
const { AppStateProvider } = await import('../src/state/AppState.js')
const { getDefaultAppState } = await import('../src/state/AppStateStore.js')
const { render } = await import('../src/ink.js')
const { TungstenPill } = await import('../src/components/PromptInput/TungstenPill.js')
const { renderToAnsiString } = await import('../src/utils/staticRender.js')

function context(
  initialState = getDefaultAppState(),
): Parameters<typeof TungstenTool.call>[1] {
  let state = initialState
  return {
    setAppState(update: (previous: typeof initialState) => typeof initialState) {
      state = update(state)
    },
    getAppState() {
      return state
    },
  } as unknown as Parameters<typeof TungstenTool.call>[1]
}

beforeEach(() => {
  calls.length = 0
  clearSessionsWithTungstenUsage()
  resetInitializationState()
  resetSocketState()
})

afterEach(() => {
  clearSessionsWithTungstenUsage()
  resetInitializationState()
  resetSocketState()
})

describe('Tungsten tool', () => {
  test('uses isolated argv, literal send, capture and managed kill', async () => {
    const created = await TungstenTool.call(
      TungstenTool.inputSchema.parse({ action: 'create', name: 'work', command: 'printf safe' }),
      context(),
    )
    expect(created.data).toEqual({ action: 'create', name: 'work', target: 'work:0.0' })
    await TungstenTool.call(
      TungstenTool.inputSchema.parse({ action: 'send', name: 'work', text: 'echo $(not-run); -R', enter: true }),
      context(),
    )
    const literal = calls.find(call => call.args.includes('-l'))
    expect(literal?.args).toContain('echo $(not-run); -R')
    expect(literal?.args.slice(0, 2)).toEqual(['-L', `claude-${process.pid}`])
    expect(calls.some(call => call.args.at(-1) === 'Enter')).toBe(true)

    const captured = await TungstenTool.call(
      TungstenTool.inputSchema.parse({ action: 'capture', name: 'work', lines: 25 }),
      context(),
    )
    expect(captured.data).toEqual({ action: 'capture', name: 'work', content: 'real pane output\n' })
    const capture = calls.find(call => call.args.includes('capture-pane'))
    expect(capture?.args).toContain('-25')

    const listed = await TungstenTool.call(TungstenTool.inputSchema.parse({ action: 'list' }), context())
    expect(listed.data).toEqual({
      action: 'list',
      sessions: [
        { name: 'base', windows: 1, attached: false },
        { name: 'work', windows: 1, attached: false },
      ],
    })
    await expect(
      TungstenTool.call(TungstenTool.inputSchema.parse({ action: 'kill', name: 'base' }), context()),
    ).rejects.toThrow('unmanaged')
    expect(calls.some(call => call.args.includes('kill-session') && call.args.includes('base'))).toBe(false)
    await TungstenTool.call(TungstenTool.inputSchema.parse({ action: 'kill', name: 'work' }), context())
    expect(clearSessionsWithTungstenUsage()).toBe(false)
  })

  test('denied command permission does not spawn and reset is meaningful', async () => {
    const deniedState = getDefaultAppState()
    deniedState.toolPermissionContext = {
      ...deniedState.toolPermissionContext,
      alwaysDenyRules: {
        userSettings: ['Bash(rm -rf /)'],
      },
    }
    const input = TungstenTool.inputSchema.parse({ action: 'create', name: 'work', command: 'rm -rf /' })
    const result = await TungstenTool.checkPermissions(input, context(deniedState))
    expect(result.behavior).toBe('deny')
    expect(calls).toHaveLength(0)

    await TungstenTool.call(TungstenTool.inputSchema.parse({ action: 'list' }), context())
    expect(resetInitializationState()).toBe(true)
    expect(resetInitializationState()).toBe(false)
  })

  test('rejects malformed names and invalid action payloads', () => {
    expect(() => TungstenTool.inputSchema.parse({ action: 'create', name: '../escape' })).toThrow()
    expect(() => TungstenTool.inputSchema.parse({ action: 'capture', name: 'work', lines: 10001 })).toThrow()
    expect(() => TungstenTool.inputSchema.parse({ action: 'nuke', name: 'work' })).toThrow()
  })
})

describe('TungstenPill', () => {
  test('shows the active session and real selected state', async () => {
    const initialState = {
      ...getDefaultAppState(),
      tungstenActiveSession: {
        sessionName: 'work', socketName: `claude-${process.pid}`, target: 'work:0.0',
      },
    }
    const output = await renderToAnsiString(
      <AppStateProvider initialState={initialState}>
        <TungstenPill selected={true} />
      </AppStateProvider>,
    )
    expect(output).toContain('tmux work (1)')
    expect(output).not.toContain('unavailable')
  })
})

describe('TungstenLiveMonitor', () => {
  test('renders real pane state and cleans up its interval', async () => {
    const clear = spyOn(globalThis, 'clearInterval')
    const initialState = {
      ...getDefaultAppState(),
      tungstenActiveSession: {
        sessionName: 'work',
        socketName: `claude-${process.pid}`,
        target: 'work:0.0',
      },
      tungstenLastCommand: { command: 'status', timestamp: Date.now() },
    }
    const stream = new PassThrough()
    let output = ''
    stream.on('data', chunk => { output += chunk.toString() })
    const instance = await render(
      <AppStateProvider initialState={initialState}>
        <TungstenLiveMonitor />
      </AppStateProvider>,
      { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    instance.unmount()
    expect(output).toContain('work')
    expect(output).toContain('real pane output')
    expect(output).toContain('Last input: status')
    expect(clear).toHaveBeenCalled()
    clear.mockRestore()
  })
})
