import { afterEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import {
  applyCollapsesIfNeeded,
  getStats,
  initContextCollapse,
  isWithheldPromptTooLong,
  recoverFromOverflow,
  resetContextCollapse,
  subscribe,
} from '../src/services/contextCollapse/index.ts'
import {
  projectView,
  selectCollapseSpan,
} from '../src/services/contextCollapse/operations.ts'
import { restoreFromEntries } from '../src/services/contextCollapse/persist.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { AssistantMessage, Message } from '../src/types/message.ts'
import { createAssistantMessage, createUserMessage } from '../src/utils/messages.ts'
import { sleep } from '../src/utils/sleep.ts'

const context = {
  options: { mainLoopModel: 'test-model' },
} as ToolUseContext

function messages(count = 6): Message[] {
  return Array.from({ length: count }, (_, index) =>
    createUserMessage({ content: `message-${index}`, uuid: randomUUID() }),
  )
}

afterEach(() => {
  initContextCollapse()
  resetContextCollapse()
})

describe('context-collapse execution', () => {
  test('commits a summary above the blocking threshold and is idempotent', async () => {
    const recordCommit = mock(async () => {})
    const recordSnapshot = mock(async () => {})
    const summarize = mock(async () => 'concise summary')
    initContextCollapse({
      tokenCount: () => 96,
      contextWindow: () => 100,
      summarize,
      recordCommit,
      recordSnapshot,
    })
    resetContextCollapse()
    const original = messages()
    const result = await applyCollapsesIfNeeded(original, context, 'sdk')
    expect(result.messages).toHaveLength(5)
    expect(String(result.messages[0] && 'uuid' in result.messages[0] ? result.messages[0].uuid : '')).not.toBe('')
    expect(getStats().collapsedSpans).toBe(1)
    expect(getStats().collapsedMessages).toBe(2)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(recordCommit).toHaveBeenCalledTimes(1)
    expect(recordSnapshot).toHaveBeenCalled()

    const again = await applyCollapsesIfNeeded(result.messages, context, 'sdk')
    expect(again.messages).toHaveLength(5)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(getStats().collapsedSpans).toBe(1)
  })

  test('runs a nonblocking spawn at 90 percent and projects after completion', async () => {
    let resolveSummary!: (summary: string) => void
    const summarize = mock(
      () =>
        new Promise<string>(resolve => {
          resolveSummary = resolve
        }),
    )
    initContextCollapse({
      tokenCount: () => 90,
      contextWindow: () => 100,
      summarize,
      recordCommit: async () => {},
      recordSnapshot: async () => {},
    })
    resetContextCollapse()
    const original = messages()
    const initial = await applyCollapsesIfNeeded(original, context, 'sdk')
    expect(initial.messages).toHaveLength(6)
    expect(summarize).toHaveBeenCalledTimes(1)
    resolveSummary('background summary')
    await sleep(0)
    const final = await applyCollapsesIfNeeded(original, context, 'sdk')
    expect(final.messages).toHaveLength(5)
    expect(getStats().collapsedSpans).toBe(1)
  })

  test('tracks empty summaries without committing a placeholder', async () => {
    initContextCollapse({
      tokenCount: () => 100,
      contextWindow: () => 100,
      summarize: async () => '',
    })
    resetContextCollapse()
    const original = messages()
    const result = await applyCollapsesIfNeeded(original, context, 'sdk')
    expect(result.messages).toEqual(original)
    expect(getStats().collapsedSpans).toBe(0)
    expect(getStats().health.totalEmptySpawns).toBe(1)
    expect(getStats().health.lastError).toContain('empty summary')
  })

  test('withholds prompt-too-long only outside the summarizer itself', () => {
    const error = createAssistantMessage({ content: 'prompt too long' })
    error.isApiErrorMessage = true
    expect(
      isWithheldPromptTooLong(error, () => true, 'sdk'),
    ).toBe(true)
    expect(
      isWithheldPromptTooLong(error, () => true, 'marble_origami'),
    ).toBe(false)
  })
})

describe('context-collapse persistence and projection', () => {
  test('restores commits and drains a staged snapshot on overflow', async () => {
    const original = messages()
    const [first, second, third, fourth] = original
    const recordCommit = mock(async () => {})
    initContextCollapse({ recordCommit })
    restoreFromEntries(
      [
        {
          type: 'marble-origami-commit',
          sessionId: randomUUID(),
          collapseId: '0000000000000001',
          summaryUuid: '00000000-0000-4000-8000-000000000001',
          summaryContent: '<collapsed id="0000000000000001">old summary</collapsed>',
          summary: 'old summary',
          firstArchivedUuid: first!.uuid,
          lastArchivedUuid: second!.uuid,
        },
      ],
      {
        type: 'marble-origami-snapshot',
        sessionId: randomUUID(),
        staged: [
          {
            startUuid: third!.uuid,
            endUuid: fourth!.uuid,
            summary: 'staged summary',
            risk: 0.96,
            stagedAt: 1,
          },
        ],
        armed: true,
        lastSpawnTokens: 90,
      },
    )

    const restored = projectView(original)
    expect(restored).toHaveLength(5)
    expect(getStats().collapsedSpans).toBe(1)
    expect(getStats().stagedSpans).toBe(1)
    const recovered = recoverFromOverflow(original, 'sdk')
    expect(recovered.committed).toBe(1)
    expect(recovered.messages).toHaveLength(4)
    expect(getStats().collapsedSpans).toBe(2)
    expect(getStats().stagedSpans).toBe(0)
    expect(recordCommit).toHaveBeenCalledTimes(1)
    await sleep(0)
    expect(projectView(recovered.messages)).toHaveLength(4)
  })

  test('does not split a tool use from its result at the span boundary', () => {
    const span = messages(7)
    span[2] = createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      ],
    })
    span[3] = createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
    })
    const selected = selectCollapseSpan(span)!
    expect(selected).toHaveLength(2)
    expect(selected.includes(span[2]!)).toBe(false)
    expect(selected.includes(span[3]!)).toBe(false)
  })

  test('notifies subscribers and resets all state', () => {
    const listener = mock(() => {})
    const unsubscribe = subscribe(listener)
    resetContextCollapse()
    expect(listener).toHaveBeenCalled()
    expect(getStats().collapsedSpans).toBe(0)
    expect(getStats().stagedSpans).toBe(0)
    unsubscribe()
  })
})
