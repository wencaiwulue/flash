import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import chalk from 'chalk'
import type { Hunk } from 'diff'
import * as React from 'react'
import {
  Messages,
  computeSliceStart,
  type SliceAnchor,
} from '../src/components/Messages.tsx'
import { SentryErrorBoundary } from '../src/components/SentryErrorBoundary.ts'
import { StructuredDiff } from '../src/components/StructuredDiff.tsx'
import { Text } from '../src/ink.ts'
import { TerminalWriteProvider } from '../src/ink/useTerminalNotification.ts'
import type { ScrollBoxHandle } from '../src/ink/components/ScrollBox.tsx'
import { TerminalSizeContext } from '../src/ink/components/TerminalSizeContext.tsx'
import { renderToScreen } from '../src/ink/render-to-screen.ts'
import { charInCellAt } from '../src/ink/screen.ts'
import { ColorDiff } from '../src/native-ts/color-diff/index.ts'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import type { RenderableMessage } from '../src/types/message.ts'

const originalChalkLevel = chalk.level
const originalNoFlicker = process.env.CLAUDE_CODE_NO_FLICKER
const originalSyntaxHighlight = process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT
const originalDisableVirtualScroll = process.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL
const initialState = {
  ...getDefaultAppState(),
  settings: {
    ...getDefaultAppState().settings,
    syntaxHighlightingDisabled: false,
  },
}

beforeEach(() => {
  chalk.level = 1
  delete process.env.CLAUDE_CODE_NO_FLICKER
  delete process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT
  delete process.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL
})

afterEach(() => {
  mock.restore()
  chalk.level = originalChalkLevel
  if (originalNoFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
  else process.env.CLAUDE_CODE_NO_FLICKER = originalNoFlicker
  if (originalSyntaxHighlight === undefined) delete process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT
  else process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT = originalSyntaxHighlight
  if (originalDisableVirtualScroll === undefined) delete process.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL
  else process.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL = originalDisableVirtualScroll
})

function renderNode(node: React.ReactNode, width = 80) {
  const { screen, height } = renderToScreen(
    <AppStateProvider initialState={initialState}>
      <TerminalSizeContext.Provider value={{ columns: width, rows: 24 }}>
        <TerminalWriteProvider value={() => {}}>{node}</TerminalWriteProvider>
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
  return { screen, height, lines, text: lines.join('\n') }
}

function patch(): Hunk {
  return {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [' const x = 1', '-const y = 2', '+const z = 3'],
  }
}

function diffProps(overrides: Partial<Parameters<typeof StructuredDiff>[0]> = {}) {
  return {
    patch: patch(),
    dim: false,
    filePath: 'test.ts',
    firstLine: null,
    width: 80,
    ...overrides,
  }
}

function userMessage(text: string, uuid: string): RenderableMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    uuid,
  } as RenderableMessage
}

function assistantMessage(
  content: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }>,
  uuid: string,
): RenderableMessage {
  return { type: 'assistant', message: { content }, uuid } as RenderableMessage
}

function manyMessages(count: number): RenderableMessage[] {
  return Array.from({ length: count }, (_, i) => userMessage(`Message ${i}`, `msg-${i}`))
}

function messagesProps(overrides: Partial<Parameters<typeof Messages>[0]> = {}) {
  return {
    messages: [userMessage('Hello', 'hello'), assistantMessage([{ type: 'text', text: 'Hi there' }], 'hi')],
    tools: [],
    commands: [],
    verbose: false,
    toolJSX: null,
    toolUseConfirmQueue: [],
    inProgressToolUseIDs: new Set<string>(),
    streamingToolUses: [],
    isMessageSelectorVisible: false,
    conversationId: 'test-conversation',
    screen: 'prompt' as const,
    isLoading: false,
    hidePastThinking: false,
    hideLogo: true,
    ...overrides,
  }
}

describe('StructuredDiff production rendering', () => {
  test('renders exact fallback lines when native highlighting is disabled', () => {
    process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT = '0'
    const nativeRender = spyOn(ColorDiff.prototype, 'render')
    const result = renderNode(<StructuredDiff {...diffProps()} />)
    expect(nativeRender).not.toHaveBeenCalled()
    expect(result.text).toContain('const x = 1')
    expect(result.text).toContain('const y = 2')
    expect(result.text).toContain('const z = 3')
    expect(result.text).toContain('-')
    expect(result.text).toContain('+')
  })

  test('clamps fractional and negative widths while keeping content readable', () => {
    for (const width of [0.5, -3, 1]) {
      const result = renderNode(<StructuredDiff {...diffProps({ width, skipHighlighting: true })} />, 10)
      expect(result.text.replace(/\s/g, '')).toContain('const')
    }
  })

  test('reuses native renders by key and clears after four variants', () => {
    const nativeRender = spyOn(ColorDiff.prototype, 'render')
    const base = diffProps()
    renderNode(<StructuredDiff {...base} />)
    renderNode(<StructuredDiff {...base} />)
    expect(nativeRender).toHaveBeenCalledTimes(1)

    renderNode(<StructuredDiff {...base} width={40} />)
    expect(nativeRender).toHaveBeenCalledTimes(2)
    renderNode(<StructuredDiff {...base} dim={true} />)
    expect(nativeRender).toHaveBeenCalledTimes(3)
    renderNode(<StructuredDiff {...base} firstLine={'#!/usr/bin/env tsx'} />)
    expect(nativeRender).toHaveBeenCalledTimes(4)

    renderNode(<StructuredDiff {...base} filePath={'other.ts'} />)
    expect(nativeRender).toHaveBeenCalledTimes(5)
    renderNode(<StructuredDiff {...base} />)
    expect(nativeRender).toHaveBeenCalledTimes(6)
  })

  test('splits fullscreen gutter and marks only gutter cells noSelect', () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    const result = renderNode(<StructuredDiff {...diffProps()} />)
    expect(result.text).toContain('const x = 1')
    expect(result.screen.noSelect[0]).toBe(1)
    expect(result.screen.noSelect[1]).toBe(1)
    expect(result.screen.noSelect[4]).toBe(0)
  })

  test('isolates native render failure behind the production error boundary', () => {
    spyOn(ColorDiff.prototype, 'render').mockImplementation(() => {
      throw new Error('intentional native render failure')
    })
    const result = renderNode(
      <>
        <SentryErrorBoundary>
          <StructuredDiff {...diffProps()} />
        </SentryErrorBoundary>
        <Text>survives</Text>
      </>,
    )
    expect(result.text).toBe('survives')
  })
})

describe('computeSliceStart', () => {
  test('keeps zero below cap and advances by cap beyond cap+step', () => {
    const small = { current: null }
    expect(computeSliceStart(manyMessages(100), small)).toBe(0)
    const large = { current: null }
    expect(computeSliceStart(manyMessages(251), large)).toBe(51)
    expect(large.current).toEqual({ uuid: 'msg-51', idx: 51 })
  })

  test('preserves a valid UUID anchor instead of advancing on append', () => {
    const anchor = { current: { uuid: 'msg-51', idx: 51 } }
    expect(computeSliceStart(manyMessages(251), anchor)).toBe(51)
    expect(anchor.current).toEqual({ uuid: 'msg-51', idx: 51 })
  })

  test('falls back to clamped stored index and heals a lost UUID', () => {
    const anchor = { current: { uuid: 'missing', idx: 55 } }
    expect(computeSliceStart(manyMessages(251), anchor)).toBe(51)
    expect(anchor.current).toEqual({ uuid: 'msg-51', idx: 51 })
  })

  test('advances again only when the anchored remainder exceeds cap+step', () => {
    const messages = manyMessages(302)
    const anchor = { current: null }
    expect(computeSliceStart(messages.slice(0, 251), anchor)).toBe(51)
    expect(computeSliceStart(messages, anchor)).toBe(102)
    expect(anchor.current).toEqual({ uuid: 'msg-102', idx: 102 })
  })

  test('supports custom cap/step and clears an empty anchor', () => {
    expect(computeSliceStart(manyMessages(35), { current: null }, 20, 10)).toBe(15)
    const anchor: { current: SliceAnchor } = { current: { uuid: 'old', idx: 5 } }
    expect(computeSliceStart([], anchor)).toBe(0)
    expect(anchor.current).toBeNull()
  })
})

describe('Messages production rendering and virtualization', () => {
  test('renders real user and assistant text and applies the render cap', () => {
    const basic = renderNode(<Messages {...messagesProps()} />)
    expect(basic.text).toContain('Hello')
    expect(basic.text).toContain('Hi there')

    const capped = renderNode(<Messages {...messagesProps({ messages: manyMessages(251) })} />)
    expect(capped.text).not.toContain('Message 0\n')
    expect(capped.text).toContain('Message 51')
    expect(capped.text).toContain('Message 250')
  })

  test('shows only the latest completed thinking block in transcript mode', () => {
    const messages = [
      userMessage('First', 'first'),
      assistantMessage([{ type: 'thinking', thinking: 'Thinking 1' }], 'think-1'),
      assistantMessage([{ type: 'text', text: 'Answer 1' }], 'answer-1'),
      userMessage('Second', 'second'),
      assistantMessage([{ type: 'thinking', thinking: 'Thinking 2' }], 'think-2'),
      assistantMessage([{ type: 'text', text: 'Answer 2' }], 'answer-2'),
    ]
    const result = renderNode(
      <Messages {...messagesProps({ messages, screen: 'transcript', hidePastThinking: true })} />,
    )
    expect(result.text).not.toContain('Thinking 1')
    expect(result.text).toContain('Thinking 2')
    expect(result.text).toContain('Answer 1')
    expect(result.text).toContain('Answer 2')
  })

  test('hides completed thinking while streaming thinking is visible', () => {
    const messages = [
      assistantMessage([{ type: 'thinking', thinking: 'Completed thought' }], 'think-1'),
      assistantMessage([{ type: 'text', text: 'Answer' }], 'answer-1'),
    ]
    const result = renderNode(
      <Messages {...messagesProps({
        messages,
        screen: 'transcript',
        hidePastThinking: true,
        streamingThinking: { type: 'thinking', thinking: 'Streaming thought', isStreaming: true },
      })} />,
    )
    expect(result.text).not.toContain('Completed thought')
    expect(result.text).toContain('Streaming thought')
    expect(result.text).toContain('Answer')
  })
})

function fakeScrollHandle(sticky: boolean, viewportHeight = 10): ScrollBoxHandle {
  let scrollTop = 0
  const listeners = new Set<() => void>()
  return {
    scrollTo: y => {
      scrollTop = y
      listeners.forEach(listener => listener())
    },
    scrollBy: delta => {
      scrollTop += delta
      listeners.forEach(listener => listener())
    },
    scrollToElement: () => {},
    scrollToBottom: () => {
      sticky = true
      listeners.forEach(listener => listener())
    },
    getScrollTop: () => scrollTop,
    getPendingDelta: () => 0,
    getScrollHeight: () => 100,
    getFreshScrollHeight: () => 100,
    getViewportHeight: () => viewportHeight,
    getViewportTop: () => 0,
    isSticky: () => sticky,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setClampBounds: () => {},
  }
}

describe('virtual scroll runtime gate', () => {
  test('mounts only a subset around the viewport instead of the full list', () => {
    const scrollRef = { current: fakeScrollHandle(false) }
    const virtual = renderNode(
      <Messages {...messagesProps({ messages: manyMessages(300), scrollRef })} />,
    )
    expect(virtual.text).toContain('Message 0')
    expect(virtual.text).not.toContain('Message 299')

    const plain = renderNode(<Messages {...messagesProps({ messages: manyMessages(300) })} />)
    expect(plain.text).toContain('Message 299')
    expect(virtual.text.match(/Message \d+/g)?.length).toBeLessThan(
      plain.text.match(/Message \d+/g)?.length ?? 0,
    )
  })

  test('mounts the tail when the scroll handle is sticky to bottom', () => {
    const scrollRef = { current: fakeScrollHandle(true) }
    const result = renderNode(
      <Messages {...messagesProps({ messages: manyMessages(300), scrollRef })} />,
    )
    expect(result.text).toContain('Message 299')
    expect(result.text).not.toContain('Message 0\n')
  })
})
