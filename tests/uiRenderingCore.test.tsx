import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import chalk from 'chalk'
import { marked } from 'marked'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import {
  areMessagePropsEqual,
  Message,
  type Props as MessageProps,
} from '../src/components/Message.tsx'
import { Markdown, StreamingMarkdown } from '../src/components/Markdown.tsx'
import { SentryErrorBoundary } from '../src/components/SentryErrorBoundary.ts'
import { createRoot, Text, type Root } from '../src/ink.ts'
import { TerminalSizeContext } from '../src/ink/components/TerminalSizeContext.tsx'
import { renderToScreen } from '../src/ink/render-to-screen.ts'
import { charInCellAt } from '../src/ink/screen.ts'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { BashTool } from '../src/tools/BashTool/BashTool.tsx'
import type {
  AssistantMessage,
  AttachmentMessage,
  NormalizedUserMessage,
  SystemMessage,
} from '../src/types/message.ts'
import { getCliHighlightPromise } from '../src/utils/cliHighlight.ts'

const originalChalkLevel = chalk.level
const initialState = {
  ...getDefaultAppState(),
  settings: {
    ...getDefaultAppState().settings,
    syntaxHighlightingDisabled: true,
  },
}
const enabledHighlightState = {
  ...initialState,
  settings: { ...initialState.settings, syntaxHighlightingDisabled: false },
}

let streamingRoot: Root | undefined
let streamingCleanup: (() => void) | undefined

beforeEach(() => {
  chalk.level = 1
})

afterEach(() => {
  mock.restore()
  streamingRoot?.unmount()
  streamingRoot = undefined
  streamingCleanup?.()
  streamingCleanup = undefined
  chalk.level = originalChalkLevel
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

function renderNode(
  node: React.ReactNode,
  state = initialState,
  width = 80,
) {
  const { screen, height } = renderToScreen(
    <AppStateProvider initialState={state}>
      <TerminalSizeContext.Provider value={{ columns: width, rows: 24 }}>
        {node}
      </TerminalSizeContext.Provider>
    </AppStateProvider>,
    width,
  )
  const lines: string[] = []
  for (let y = 0; y < height; y++) {
    let line = ''
    for (let x = 0; x < screen.width; x++) {
      line += charInCellAt(screen, x, y) ?? ' '
    }
    lines.push(line.trimEnd())
  }
  return { height, lines, text: lines.join('\n') }
}

const lookups: MessageProps['lookups'] = {
  resolvedToolUseIDs: new Set(),
  erroredToolUseIDs: new Set(),
  toolUseByToolUseID: new Map(),
  progressMessagesByToolUseID: new Map(),
}

function messageProps(
  message: MessageProps['message'],
  overrides: Partial<MessageProps> = {},
): MessageProps {
  return {
    message,
    lookups,
    addMargin: false,
    tools: [],
    commands: [],
    verbose: false,
    inProgressToolUseIDs: new Set(),
    progressMessagesForMessage: [],
    shouldAnimate: false,
    shouldShowDot: false,
    isTranscriptMode: false,
    isStatic: false,
    ...overrides,
  }
}

function assistant(
  content: AssistantMessage['message']['content'],
  uuid = 'assistant-1',
): AssistantMessage {
  return { type: 'assistant', message: { content }, uuid } as AssistantMessage
}

function user(
  content: NormalizedUserMessage['message']['content'],
  uuid = 'user-1',
): NormalizedUserMessage {
  return { type: 'user', message: { content }, uuid } as NormalizedUserMessage
}

function renderMessage(
  message: MessageProps['message'],
  overrides: Partial<MessageProps> = {},
) {
  return renderNode(<Message {...messageProps(message, overrides)} />)
}

describe('Message production rendering', () => {
  test('routes assistant, user, system and attachment messages to visible output', () => {
    expect(renderMessage(assistant([{ type: 'text', text: '# Assistant' }])).text).toBe('Assistant')

    expect(renderMessage(user([{ type: 'text', text: 'User question' }])).text).toContain('User question')

    const system = {
      type: 'system',
      subtype: undefined,
      content: 'System notice',
      uuid: 'system-1',
    } as SystemMessage
    expect(renderMessage(system).text).toContain('System notice')

    const attachment = {
      type: 'attachment',
      attachment: { type: 'directory', displayPath: '/tmp' },
      uuid: 'attachment-1',
    } as AttachmentMessage
    expect(renderMessage(attachment).text).toContain('Listed directory /tmp/')
  })

  test('renders user image paste IDs without requiring a real image file', () => {
    const message = user([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
      },
    ])
    message.imagePasteIds = [7]
    expect(renderMessage(message).text).toContain('[Image #7]')
  })

  test('renders a tool_use block through the real Bash tool definition', () => {
    const result = renderMessage(
      assistant([
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      ]),
      { tools: [BashTool] },
    )
    expect(result.text).toContain('Bash')
    expect(result.text).toContain('pwd')
  })

  test('shows only the selected thinking block in transcript mode', () => {
    const message = assistant([
      { type: 'thinking', thinking: 'first thought' },
      { type: 'thinking', thinking: 'second thought' },
      { type: 'text', text: 'answer' },
    ])
    const second = renderMessage(message, {
      isTranscriptMode: true,
      lastThinkingBlockId: 'assistant-1:1',
    })
    expect(second.text).not.toContain('first thought')
    expect(second.text).toContain('second thought')
    expect(second.text).toContain('answer')

    const first = renderMessage(message, {
      isTranscriptMode: true,
      lastThinkingBlockId: 'assistant-1:0',
    })
    expect(first.text).toContain('first thought')
    expect(first.text).not.toContain('second thought')
  })

  test('memo comparator preserves static messages and invalidates meaningful changes', () => {
    const text = assistant([{ type: 'text', text: 'plain' }])
    const base = messageProps(text, { isStatic: true })
    expect(areMessagePropsEqual(base, messageProps(text, { isStatic: true }))).toBe(true)
    expect(areMessagePropsEqual(base, messageProps(text, { isStatic: true, verbose: true }))).toBe(false)
    expect(areMessagePropsEqual(base, messageProps(assistant([{ type: 'text', text: 'other' }], 'other'), { isStatic: true }))).toBe(false)
    expect(areMessagePropsEqual(base, messageProps(text, { isStatic: true, latestBashOutputUUID: text.uuid }))).toBe(false)

    const thinking = assistant([{ type: 'thinking', thinking: 'thought' }])
    expect(areMessagePropsEqual(
      messageProps(thinking, { lastThinkingBlockId: 'a:0' }),
      messageProps(thinking, { lastThinkingBlockId: 'a:1' }),
    )).toBe(false)
  })

  test('isolates a failing child behind the production error boundary', () => {
    function ThrowingChild(): React.ReactNode {
      throw new Error('intentional render failure')
    }
    const result = renderNode(
      <>
        <SentryErrorBoundary>
          <ThrowingChild />
        </SentryErrorBoundary>
        <Text>survives</Text>
      </>,
    )
    expect(result.text).toBe('survives')
  })
})

describe('Markdown production rendering and cache', () => {
  test('plain text fast path never calls marked.lexer', () => {
    const lexer = spyOn(marked, 'lexer')
    expect(renderNode(<Markdown>{'ordinary plain text'}</Markdown>).text).toBe('ordinary plain text')
    expect(renderNode(<Markdown>{'ordinary plain text'}</Markdown>).text).toBe('ordinary plain text')
    expect(lexer).not.toHaveBeenCalled()
  })

  test('promotes cache hits and evicts the oldest unused entry beyond 500', () => {
    const lexer = spyOn(marked, 'lexer')
    const a = '# ui-cache-a'
    const b = '# ui-cache-b'
    renderNode(<Markdown>{a}</Markdown>)
    renderNode(<Markdown>{b}</Markdown>)
    renderNode(<Markdown>{a}</Markdown>)
    expect(lexer).toHaveBeenCalledTimes(2)

    for (let i = 0; i < 499; i++) {
      renderNode(<Markdown>{`# ui-cache-${i}`}</Markdown>)
    }
    expect(lexer).toHaveBeenCalledTimes(501)

    renderNode(<Markdown>{a}</Markdown>)
    expect(lexer).toHaveBeenCalledTimes(501)
    renderNode(<Markdown>{b}</Markdown>)
    expect(lexer).toHaveBeenCalledTimes(502)
  })

  test('renders a real Markdown table through the component path', () => {
    const result = renderNode(
      <Markdown>{'| Left | Right |\n|------|-------|\n| A | B |'}</Markdown>,
    )
    expect(result.text).toContain('Left')
    expect(result.text).toContain('Right')
    expect(result.text).toContain('A')
    expect(result.text).toContain('B')
    expect(result.lines.length).toBeGreaterThanOrEqual(3)
  })

  test('renders real highlighting after the shared lazy loader resolves', async () => {
    await getCliHighlightPromise()
    const result = renderNode(
      <Markdown>{'```ts\nconst x = 1\n```'}</Markdown>,
      enabledHighlightState,
    )
    expect(result.text).toContain('const x = 1')
  })
})

async function createStreamingHarness() {
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
  let frames = 0
  streamingRoot = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    onFrame: () => {
      frames++
    },
  })
  streamingCleanup = () => {
    stdout.end()
    stdin.end()
  }

  return async (children: string): Promise<string> => {
    const outputStart = output.length
    const nextFrame = frames + 1
    streamingRoot!.render(
      <AppStateProvider initialState={initialState}>
        <StreamingMarkdown>{children}</StreamingMarkdown>
      </AppStateProvider>,
    )
    await waitFor(() => frames >= nextFrame)
    return stripAnsi(output.slice(outputStart))
  }
}

describe('StreamingMarkdown incremental rendering', () => {
  test('keeps stable prefixes while appending and resets on replacement', async () => {
    const lexer = spyOn(marked, 'lexer')
    const render = await createStreamingHarness()

    expect(await render('# One\n\n# Two')).toContain('Two')
    const afterInitial = lexer.mock.calls.length

    const appended = await render('# One\n\n# Two more')
    expect(appended.match(/One/g)).toHaveLength(1)
    expect(appended).toContain('Two more')
    const firstAppendCalls = lexer.mock.calls.slice(afterInitial).map(call => call[0])
    expect(firstAppendCalls).not.toContain('# One\n\n')

    const afterFirstAppend = lexer.mock.calls.length
    expect(await render('# One\n\n# Two more\n\n# Three')).toContain('Three')
    const afterNewBlock = lexer.mock.calls.length

    const growing = await render('# One\n\n# Two more\n\n# Three again')
    expect(growing.match(/One/g)).toHaveLength(1)
    expect(growing.match(/Two more/g)).toHaveLength(1)
    expect(growing).toContain('Three again')
    const secondAppendCalls = lexer.mock.calls.slice(afterNewBlock).map(call => call[0])
    expect(secondAppendCalls).not.toContain('# One\n\n# Two more\n\n')
    expect(afterNewBlock).toBeGreaterThan(afterFirstAppend)

    const replaced = await render('# Replacement')
    expect(replaced).toContain('Replacement')
    expect(replaced).not.toContain('One')
    expect(replaced).not.toContain('Two')
  })

  test('keeps an unclosed code fence in the unstable suffix without duplicating output', async () => {
    const render = await createStreamingHarness()
    await render('# One\n\n```ts\nconst x = 1')
    const result = await render('# One\n\n```ts\nconst x = 1\n```')
    expect(result.match(/One/g)).toHaveLength(1)
    expect(result.match(/const x = 1/g)).toHaveLength(1)
    expect(result.trim()).toBe('One\n\nconst x = 1')
  })
})
