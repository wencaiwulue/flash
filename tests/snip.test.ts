import { afterEach, describe, expect, test } from 'bun:test'
import forceSnipCommand from '../src/commands/force-snip.ts'
import {
  createSnipMarkerMessage,
  isSnipRuntimeEnabled,
  resolveSnipTargets,
  shouldNudgeForSnips,
  snipCompactIfNeeded,
} from '../src/services/compact/snipCompact.ts'
import {
  isSnipBoundaryMessage,
  projectSnippedView,
} from '../src/services/compact/snipProjection.ts'
import { SnipTool } from '../src/tools/SnipTool/SnipTool.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'
import type { Message } from '../src/types/message.ts'
import { deriveShortMessageId, createAssistantMessage, createUserMessage } from '../src/utils/messages.ts'

const originalEnv = process.env.CLAUDE_HISTORY_SNIP

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CLAUDE_HISTORY_SNIP
  else process.env.CLAUDE_HISTORY_SNIP = originalEnv
})

function toolPair(): [Message, Message] {
  const assistant = createAssistantMessage({
    content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
  })
  const result = createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
  })
  result.sourceToolAssistantUUID = assistant.uuid
  return [assistant, result]
}

describe('snip compaction', () => {
  test('does nothing without a marker unless forced', () => {
    const messages = [createUserMessage({ content: 'old' })]
    expect(snipCompactIfNeeded(messages).executed).toBe(false)
    process.env.CLAUDE_HISTORY_SNIP = '0'
    expect(isSnipRuntimeEnabled()).toBe(false)
    expect(snipCompactIfNeeded(messages, { force: true }).executed).toBe(false)
  })

  test('executes a marker once and removes linked tool results', () => {
    const old = createUserMessage({ content: 'old user turn' })
    const [assistant, result] = toolPair()
    const recent = Array.from({ length: 4 }, (_, i) =>
      createUserMessage({ content: `recent-${i}` }),
    )
    const ids = [deriveShortMessageId(old.uuid), deriveShortMessageId(assistant.uuid)]
    const marker = createSnipMarkerMessage(ids)
    const messages = [old, assistant, result, ...recent, marker]
    const resultOfSnip = snipCompactIfNeeded(messages)
    expect(resultOfSnip.executed).toBe(true)
    expect(resultOfSnip.tokensFreed).toBeGreaterThan(0)
    expect(resultOfSnip.messages.includes(old)).toBe(false)
    expect(resultOfSnip.messages.includes(assistant)).toBe(false)
    expect(resultOfSnip.messages.includes(result)).toBe(false)
    expect(resultOfSnip.messages.includes(marker)).toBe(false)
    expect(resultOfSnip.messages.filter(isSnipBoundaryMessage)).toHaveLength(1)
    expect(recent.every(message => resultOfSnip.messages.includes(message))).toBe(true)
    expect(snipCompactIfNeeded(resultOfSnip.messages).executed).toBe(false)
  })

  test('does not split a tool pair across the protected-tail boundary', () => {
    const first = createUserMessage({ content: 'first' })
    const [assistant, result] = toolPair()
    const filler = Array.from({ length: 3 }, (_, i) =>
      createUserMessage({ content: `filler-${i}` }),
    )
    const messages = [first, assistant, ...filler, result]
    const { targets } = resolveSnipTargets(messages, [
      deriveShortMessageId(assistant.uuid),
    ])
    expect(targets.has(assistant.uuid)).toBe(false)
    expect(targets.has(result.uuid)).toBe(false)

    const forced = snipCompactIfNeeded(messages, { force: true })
    expect(forced.messages.includes(assistant)).toBe(true)
    expect(forced.messages.includes(result)).toBe(true)
  })

  test('projects after the latest boundary and hides markers', () => {
    const marker = createSnipMarkerMessage(['x'])
    const boundaryMessages = [
      createUserMessage({ content: 'old' }),
      marker,
      createSnipMarkerMessage(['y']),
    ]
    const boundary = snipCompactIfNeeded(
      [createUserMessage({ content: 'a' }), ...Array.from({ length: 4 }, () => createUserMessage({ content: 'b' }))],
      { force: true },
    ).boundaryMessage!
    const projected = projectSnippedView([...boundaryMessages, boundary, marker])
    expect(projected[0]).toBe(boundary)
    expect(projected.some(message => message === marker)).toBe(false)
  })
})

describe('snip nudge, tool, and command', () => {
  test('nudges after token growth and resets after a boundary', () => {
    const long = createUserMessage({ content: 'x'.repeat(45_000) })
    expect(shouldNudgeForSnips([long])).toBe(true)
    const boundary = snipCompactIfNeeded(
      [long, ...Array.from({ length: 4 }, () => createUserMessage({ content: 'b' }))],
      { force: true },
    ).boundaryMessage!
    expect(shouldNudgeForSnips([long, boundary])).toBe(false)
  })

  test('validates IDs and returns a real marker from SnipTool', async () => {
    const old = createUserMessage({ content: 'old' })
    const messages = [old, ...Array.from({ length: 4 }, () => createUserMessage({ content: 'new' }))]
    const context = { messages } as ToolUseContext
    expect(
      (await SnipTool.validateInput({ message_ids: ['missing'] }, context)).result,
    ).toBe(false)
    const id = deriveShortMessageId(old.uuid)
    expect((await SnipTool.validateInput({ message_ids: [id] }, context)).result).toBe(true)
    const result = await SnipTool.call({ message_ids: [id] }, context)
    expect(result.newMessages?.[0]?.type).toBe('system')
    expect(result.newMessages?.[0]?.subtype).toBe('snip_marker')
  })

  test('force-snip updates in-memory messages without rewriting a transcript', async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      createUserMessage({ content: `message-${i}` }),
    )
    let updated: Message[] = []
    const context = {
      messages,
      setMessages: (updater: (previous: Message[]) => Message[]) => {
        updated = updater(messages)
      },
    } as LocalJSXCommandContext
    let output = ''
    const { call } = await forceSnipCommand.load()
    await call(
      (value?: string) => {
        output = value ?? ''
      },
      context,
      '',
    )
    expect(updated.some(isSnipBoundaryMessage)).toBe(true)
    expect(updated.includes(messages[0]!)).toBe(false)
    expect(updated.find(isSnipBoundaryMessage)?.snippedCount).toBe(1)
    expect(output).toContain('Snipped')
    expect(messages.some(isSnipBoundaryMessage)).toBe(false)
  })
})
