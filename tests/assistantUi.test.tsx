import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'stream'
import { render } from '../src/ink.ts'

const axiosGet = mock(async (..._args: unknown[]) => {
  throw new Error('Unexpected axios.get')
})
const prepareApiRequest = mock(async () => ({
  accessToken: 'offline-access-token',
  orgUUID: 'offline-org',
}))

mock.module('axios', () => ({ default: { get: axiosGet } }))
const teleportApi = await import('../src/utils/teleport/api.ts')
mock.module('../src/utils/teleport/api.ts', () => ({
  ...teleportApi,
  prepareApiRequest,
}))

const { discoverAssistantSessions } = await import(
  '../src/assistant/sessionDiscovery.ts'
)
const {
  createHistoryAuthCtx,
  fetchLatestEvents,
  fetchOlderEvents,
} = await import('../src/assistant/sessionHistory.ts')
const { AppStateProvider } = await import('../src/state/AppState.tsx')
const { KeybindingSetup } = await import(
  '../src/keybindings/KeybindingProviderSetup.tsx'
)
const { AssistantSessionChooser } = await import(
  '../src/assistant/AssistantSessionChooser.tsx'
)

beforeEach(() => {
  axiosGet.mockReset()
  prepareApiRequest.mockClear()
})

describe('assistant session discovery and history', () => {
  test('normalizes, filters and sorts remote session records', async () => {
    axiosGet.mockResolvedValue({
      data: {
        data: [
          {
            session_id: 'older',
            machine_name: 'host-a',
            updated_at: '2025-01-01T00:00:00.000Z',
          },
          {
            id: 'newer',
            title: 'New session',
            cwd: '/repo',
            lastActiveAt: 2_000_000_000_000,
            branch: 'feature',
          },
          { title: 'missing-id' },
        ],
      },
    })

    await expect(discoverAssistantSessions()).resolves.toEqual([
      {
        id: 'newer',
        title: 'New session',
        machineName: undefined,
        cwd: '/repo',
        branch: 'feature',
        lastActiveAt: 2_000_000_000_000,
      },
      {
        id: 'older',
        title: undefined,
        machineName: 'host-a',
        cwd: undefined,
        branch: undefined,
        lastActiveAt: Date.parse('2025-01-01T00:00:00.000Z'),
      },
    ])
    const [, config] = axiosGet.mock.calls[0]!
    expect(config).toMatchObject({
      params: { limit: 50 },
      timeout: 15000,
      headers: { 'x-organization-uuid': 'offline-org' },
    })
  })

  test('uses latest/cursor pagination and isolates non-200 responses', async () => {
    axiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { data: [{ type: 'result' }], first_id: 'event-2', has_more: true },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { data: [{ type: 'user' }], first_id: 'event-1', has_more: false },
      })
      .mockResolvedValueOnce({ status: 503, data: null })
    const context = await createHistoryAuthCtx('session-offline')

    await expect(fetchLatestEvents(context, 2)).resolves.toEqual({
      events: [{ type: 'result' }],
      firstId: 'event-2',
      hasMore: true,
    })
    await expect(fetchOlderEvents(context, 'event-2', 1)).resolves.toEqual({
      events: [{ type: 'user' }],
      firstId: 'event-1',
      hasMore: false,
    })
    await expect(fetchLatestEvents(context)).resolves.toBeNull()

    expect(context.baseUrl).toContain('/v1/sessions/session-offline/events')
    expect(axiosGet.mock.calls[0]?.[1]).toMatchObject({
      params: { limit: 2, anchor_to_latest: true },
    })
    expect(axiosGet.mock.calls[1]?.[1]).toMatchObject({
      params: { limit: 1, before_id: 'event-2' },
    })
  })
})

describe('AssistantSessionChooser Ink behavior', () => {
  let instance: Awaited<ReturnType<typeof render>> | undefined

  afterEach(() => {
    instance?.unmount()
    instance = undefined
  })

  function mount(sessions: Array<{ id: string; title?: string }>, onSelect = mock(), onCancel = mock()) {
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
    return (async () => {
      instance = await render(
        <AppStateProvider>
          <KeybindingSetup>
            <AssistantSessionChooser
              sessions={sessions}
              onSelect={onSelect}
              onCancel={onCancel}
            />
          </KeybindingSetup>
        </AppStateProvider>,
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stdin: stdin as unknown as NodeJS.ReadStream,
          patchConsole: false,
        },
      )
      await new Promise(resolve => setTimeout(resolve, 30))
      return { stdin, output: () => output, onSelect, onCancel }
    })()
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1500
    while (!predicate() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(predicate()).toBe(true)
  }

  test('renders the empty state', async () => {
    const mounted = await mount([])
    expect(mounted.output()).toContain('No assistant sessions found.')
  })

  test('selects the highlighted session with Enter and cancels with Escape', async () => {
    const mounted = await mount([{ id: 'session-a', title: 'Session A' }])
    expect(mounted.output()).toContain('Session A')

    mounted.stdin.write('\r')
    await waitFor(() => mounted.onSelect.mock.calls.length === 1)
    expect(mounted.onSelect).toHaveBeenCalledWith('session-a')

    mounted.stdin.write('')
    await waitFor(() => mounted.onCancel.mock.calls.length === 1)
    expect(mounted.onCancel).toHaveBeenCalledTimes(1)
  })
})
