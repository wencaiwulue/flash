import { afterAll, afterEach, describe, expect, jest, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as React from 'react'
import { PassThrough } from 'stream'
import type { VoiceStreamCallbacks, VoiceStreamConnection, FinalizeSource } from '../src/services/voiceStreamSTT.ts'

const configDir = mkdtempSync(join(tmpdir(), 'voice-assistant-test-'))
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

const actualKeyterms = await import('../src/services/voiceKeyterms.ts')

const audio = {
  availability: { available: true, reason: null as string | null },
  startResult: true,
  startCalls: 0,
  stopCalls: 0,
  onChunk: null as ((chunk: Buffer) => void) | null,
  onEnd: null as (() => void) | null,
}

type Behavior = 'normal' | 'earlyError' | 'noData' | 'replaySuccess'
const stt = {
  behaviors: [] as Behavior[],
  connections: [] as FakeConnection[],
  calls: 0,
}

class FakeConnection implements VoiceStreamConnection {
  readonly sent: Buffer[] = []
  closeCalls = 0
  finalizeCalls = 0
  constructor(
    readonly callbacks: VoiceStreamCallbacks,
    private readonly behavior: Behavior,
  ) {}
  send(audioChunk: Buffer): void {
    this.sent.push(Buffer.from(audioChunk))
  }
  async finalize(): Promise<FinalizeSource> {
    this.finalizeCalls++
    if (this.behavior === 'replaySuccess') {
      this.callbacks.onTranscript('recovered', true)
      return 'ws_close'
    }
    return this.behavior === 'noData' ? 'no_data_timeout' : 'ws_close'
  }
  close(): void {
    this.closeCalls++
  }
  isConnected(): boolean {
    return this.closeCalls === 0
  }
}

mock.module('../src/services/voice.ts', () => ({
  checkRecordingAvailability: async () => audio.availability,
  startRecording: async (onChunk: (chunk: Buffer) => void, onEnd: () => void) => {
    audio.startCalls++
    audio.onChunk = onChunk
    audio.onEnd = onEnd
    return audio.startResult
  },
  stopRecording: () => {
    audio.stopCalls++
  },
}))

mock.module('../src/services/voiceStreamSTT.ts', () => ({
  isVoiceStreamAvailable: () => true,
  connectVoiceStream: async (callbacks: VoiceStreamCallbacks) => {
    const behavior = stt.behaviors[stt.calls++] ?? 'normal'
    const connection = new FakeConnection(callbacks, behavior)
    stt.connections.push(connection)
    if (behavior === 'earlyError') {
      callbacks.onError('transient upstream error')
      return connection
    }
    callbacks.onReady(connection)
    return connection
  },
}))

mock.module('../src/services/voiceKeyterms.ts', () => ({
  getVoiceKeyterms: async () => [],
}))

const { useVoice, computeLevel, normalizeLanguageForSTT } = await import(
  '../src/hooks/useVoice.ts'
)
const { useVoiceIntegration } = await import('../src/hooks/useVoiceIntegration.tsx')
const { VoiceProvider } = await import('../src/context/voice.tsx')
const { render } = await import('../src/ink.ts')
const { AppStateProvider } = await import('../src/state/AppState.tsx')
const { setTerminalFocused, resetTerminalFocusState } = await import('../src/ink/terminal-focus-state.ts')

let instance: Awaited<ReturnType<typeof render>> | undefined

function streams() {
  const stdout = new PassThrough()
  stdout.on('data', () => {})
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
  return { stdin, stdout }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

afterEach(() => {
  instance?.unmount()
  instance = undefined
  audio.availability = { available: true, reason: null }
  audio.startResult = true
  audio.startCalls = 0
  audio.stopCalls = 0
  audio.onChunk = null
  audio.onEnd = null
  stt.behaviors = []
  stt.connections = []
  stt.calls = 0
  jest.useRealTimers()
  resetTerminalFocusState()
})

afterAll(() => {
  mock.restore()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

async function mountVoice(focusMode: boolean) {
  const io = streams()
  const transcripts: string[] = []
  const errors: string[] = []
  let api: ReturnType<typeof useVoice>
  function Harness(): React.ReactNode {
    api = useVoice({
      enabled: true,
      focusMode,
      onTranscript: text => transcripts.push(text),
      onError: message => errors.push(message),
    })
    return null
  }
  instance = await render(
    <AppStateProvider>
      <VoiceProvider>
        <Harness />
      </VoiceProvider>
    </AppStateProvider>,
    {
      stdout: io.stdout as unknown as NodeJS.WriteStream,
      stdin: io.stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )
  await new Promise(resolve => setTimeout(resolve, 20))
  return {
    api: () => api!,
    transcripts,
    errors,
    io,
    setFocusMode: (next: boolean) => {
      focusMode = next
      instance!.rerender(
        <AppStateProvider>
          <VoiceProvider>
            <Harness />
          </VoiceProvider>
        </AppStateProvider>,
      )
    },
  }
}

function loudChunk(length = 1024): Buffer {
  return Buffer.alloc(length, 0x11)
}

describe('useVoice production state machine', () => {
  test('starts once, detects repeat release and finalizes one transcript', async () => {
    stt.behaviors = ['normal']
    const { api, transcripts } = await mountVoice(false)
    api().handleKeyEvent(20)
    await waitFor(() => audio.onChunk !== null && stt.connections.length === 1)
    api().handleKeyEvent()
    audio.onChunk!(loudChunk())
    stt.connections[0]!.callbacks.onTranscript('hello', true)

    await waitFor(() => api().state === 'idle')
    expect(transcripts).toEqual(['hello'])
    expect(audio.startCalls).toBe(1)
    expect(audio.stopCalls).toBe(1)
    expect(stt.connections[0]!.finalizeCalls).toBe(1)
  })

  test('retries an early error once and flushes buffered audio', async () => {
    stt.behaviors = ['earlyError', 'normal']
    const { api, transcripts } = await mountVoice(false)
    api().handleKeyEvent()
    await waitFor(() => stt.connections.length === 1)
    audio.onChunk!(loudChunk())
    await waitFor(() => stt.connections.length === 2)

    expect(Buffer.concat(stt.connections[1]!.sent).equals(loudChunk())).toBe(true)
    stt.connections[1]!.callbacks.onTranscript('after retry', true)
    api().handleKeyEvent()
    await waitFor(() => api().state === 'idle')
    expect(transcripts).toEqual(['after retry'])
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(stt.connections).toHaveLength(2)
  })

  test('replays buffered audio once after a silent drop', async () => {
    stt.behaviors = ['noData', 'replaySuccess']
    const { api, transcripts } = await mountVoice(false)
    api().handleKeyEvent()
    await waitFor(() => stt.connections.length === 1)
    audio.onChunk!(loudChunk())
    api().handleKeyEvent()

    await waitFor(() => transcripts.length === 1 && stt.connections.length === 2)
    expect(transcripts).toEqual(['recovered'])
    expect(Buffer.concat(stt.connections[1]!.sent).equals(loudChunk())).toBe(true)
    await waitFor(() => api().state === 'idle')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(stt.connections).toHaveLength(2)
  })

  test('flushes focus transcripts immediately and finishes on blur', async () => {
    stt.behaviors = ['normal']
    const { api, transcripts } = await mountVoice(true)
    await waitFor(() => audio.onChunk !== null && stt.connections.length === 1)
    stt.connections[0]!.callbacks.onTranscript('focus hello', true)
    await waitFor(() => transcripts.length === 1)
    expect(api().state).toBe('recording')

    setTerminalFocused(false)
    await waitFor(() => api().state === 'idle')
    expect(transcripts).toEqual(['focus hello'])
    expect(audio.stopCalls).toBe(1)
  })

  test('tears down after focus silence and re-arms on the next focus cycle', async () => {
    const { api, setFocusMode } = await mountVoice(false)
    jest.useFakeTimers()
    setFocusMode(true)
    for (let i = 0; i < 20 && audio.onChunk === null; i++) {
      jest.advanceTimersByTime(10)
      await Promise.resolve()
    }
    expect(audio.onChunk).not.toBeNull()
    jest.advanceTimersByTime(5000)
    await Promise.resolve()
    jest.useRealTimers()

    await waitFor(() => api().state === 'idle')
    expect(audio.startCalls).toBe(1)
    expect(audio.stopCalls).toBeGreaterThanOrEqual(1)

    setTerminalFocused(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    setTerminalFocused(true)
    await waitFor(() => audio.startCalls === 2)
  })

  test('surfaces availability and audio-start failures without opening STT', async () => {
    audio.availability = { available: false, reason: 'no audio device' }
    const unavailable = await mountVoice(false)
    unavailable.api().handleKeyEvent()
    await waitFor(() => unavailable.errors.length === 1)
    expect(unavailable.errors[0]).toBe('no audio device')
    expect(unavailable.api().state).toBe('idle')
    expect(stt.connections).toHaveLength(0)

    instance?.unmount()
    instance = undefined
    audio.availability = { available: true, reason: null }
    audio.startResult = false
    const failed = await mountVoice(false)
    failed.api().handleKeyEvent()
    await waitFor(() => failed.errors.length === 1)
    expect(failed.errors[0]).toContain('microphone')
    expect(failed.api().state).toBe('idle')
    expect(stt.connections).toHaveLength(0)
  })

  test('cancels a pending retry when unmounted', async () => {
    stt.behaviors = ['earlyError', 'normal']
    const { api } = await mountVoice(false)
    api().handleKeyEvent()
    await waitFor(() => stt.connections.length === 1)
    instance?.unmount()
    instance = undefined
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(stt.connections).toHaveLength(2)
    expect(stt.connections[1]!.isConnected()).toBe(false)
  })
})

describe('useVoiceIntegration anchors', () => {
  test('strips only the hold key and restores prefix/suffix without clobbering', async () => {
    let api: ReturnType<typeof useVoiceIntegration>
    let currentInput = ''
    let currentCursor = 0
    function Harness(): React.ReactNode {
      const [input, setInput] = React.useState('hel  world')
      const [cursor, setCursor] = React.useState(5)
      currentInput = input
      currentCursor = cursor
      const inputValueRef = React.useRef(input)
      inputValueRef.current = input
      const insertTextRef = React.useRef({
        cursorOffset: cursor,
        insert: () => {},
        setInputWithCursor: (value: string, nextCursor: number) => {
          setInput(value)
          setCursor(nextCursor)
        },
      })
      insertTextRef.current.cursorOffset = cursor
      api = useVoiceIntegration({ setInputValueRaw: setInput, inputValueRef, insertTextRef })
      return null
    }
    instance = await render(
      <AppStateProvider>
        <Harness />
      </AppStateProvider>,
    )
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(api!.stripTrailing(0)).toBe(2)
    expect(currentInput).toBe('hel  world')
    expect(api!.stripTrailing(2, { anchor: true })).toBe(0)
    await waitFor(() => currentInput === 'hel world' && currentCursor === 3)
    api!.resetAnchor()
    await waitFor(() => currentInput === 'helworld' && currentCursor === 3)
  })

  test('handles full-width spaces as hold-key characters', async () => {
    let api: ReturnType<typeof useVoiceIntegration>
    let currentInput = ''
    function Harness(): React.ReactNode {
      const [input, setInput] = React.useState('hello　　')
      currentInput = input
      const inputValueRef = React.useRef(input)
      inputValueRef.current = input
      const insertTextRef = React.useRef({
        cursorOffset: input.length,
        insert: () => {},
        setInputWithCursor: (value: string) => setInput(value),
      })
      insertTextRef.current.cursorOffset = input.length
      api = useVoiceIntegration({ setInputValueRaw: setInput, inputValueRef, insertTextRef })
      return null
    }
    instance = await render(
      <AppStateProvider>
        <Harness />
      </AppStateProvider>,
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api!.stripTrailing(1)).toBe(1)
    await waitFor(() => currentInput === 'hello　')
  })
})

describe('voice pure helpers', () => {
  test('normalizes supported and fallback languages', () => {
    expect(normalizeLanguageForSTT('es')).toEqual({ code: 'es' })
    expect(normalizeLanguageForSTT('French')).toEqual({ code: 'fr' })
    expect(normalizeLanguageForSTT('日本語')).toEqual({ code: 'ja' })
    expect(normalizeLanguageForSTT('es-MX')).toEqual({ code: 'es' })
    expect(normalizeLanguageForSTT('not-a-language')).toEqual({
      code: 'en',
      fellBackFrom: 'not-a-language',
    })
  })

  test('computes PCM RMS levels', () => {
    expect(computeLevel(Buffer.alloc(0))).toBe(0)
    expect(computeLevel(Buffer.alloc(1024))).toBe(0)
    const quiet = Buffer.alloc(2)
    quiet.writeInt16LE(1000)
    expect(computeLevel(quiet)).toBeCloseTo(Math.sqrt(0.5), 8)
    const loud = Buffer.alloc(2)
    loud.writeInt16LE(4000)
    expect(computeLevel(loud)).toBe(1)
  })

  test('splits real keyterm identifiers and drops short fragments', () => {
    expect(actualKeyterms.splitIdentifier('camelCase-name/snake_case/file.ts')).toEqual([
      'camel',
      'Case',
      'name',
      'snake',
      'case',
      'file',
    ])
    expect(actualKeyterms.splitIdentifier('a/to/be')).toEqual([])
  })
})
