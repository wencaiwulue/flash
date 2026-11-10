import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { CompactionResult } from '../src/services/compact/compact.ts'
import {
  initReactiveCompact,
  isReactiveCompactEnabled,
  isWithheldMediaSizeError,
  isWithheldPromptTooLong,
  reactiveCompactOnPromptTooLong,
  tryReactiveCompact,
} from '../src/services/compact/reactiveCompact.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { Message } from '../src/types/message.ts'
import type { CacheSafeParams } from '../src/utils/forkedAgent.ts'
import { createAssistantMessage, createUserMessage } from '../src/utils/messages.ts'

const originalEnv = process.env.CLAUDE_REACTIVE_COMPACT

afterEach(() => {
  initReactiveCompact()
  if (originalEnv === undefined) delete process.env.CLAUDE_REACTIVE_COMPACT
  else process.env.CLAUDE_REACTIVE_COMPACT = originalEnv
})

function cacheParams(): CacheSafeParams {
  return {
    toolUseContext: { abortController: new AbortController() } as ToolUseContext,
  } as CacheSafeParams
}

function compactResult(): CompactionResult {
  return {
    boundaryMarker: { type: 'system', subtype: 'compact_boundary' },
    summaryMessages: [],
    attachments: [],
    hookResults: [],
    userDisplayMessage: 'post',
  } as CompactionResult
}

function conversation(): Message[] {
  return [
    createUserMessage({ content: 'first' }),
    createAssistantMessage({ content: 'answer' }),
    createUserMessage({ content: 'next' }),
  ]
}

describe('reactive error detection', () => {
  test('detects PTL and media-size errors with a runtime kill switch', () => {
    const ptl = createAssistantMessage({ content: 'Prompt is too long' })
    ptl.isApiErrorMessage = true
    const media = createAssistantMessage({ content: 'image too large' })
    media.isApiErrorMessage = true
    media.errorDetails = 'image exceeds 5 MB maximum'
    expect(isWithheldPromptTooLong(ptl)).toBe(true)
    expect(isWithheldMediaSizeError(media)).toBe(true)
    process.env.CLAUDE_REACTIVE_COMPACT = '0'
    expect(isReactiveCompactEnabled()).toBe(false)
    expect(isWithheldPromptTooLong(ptl)).toBe(false)
    expect(isWithheldMediaSizeError(media)).toBe(false)
  })
})

describe('reactiveCompactOnPromptTooLong', () => {
  test('strips media and calls the shared compactor without duplicate PreCompact', async () => {
    const compact = mock(async () => compactResult())
    initReactiveCompact({ compact: compact as never })
    const input = conversation()
    input[0] = createUserMessage({
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'x' },
        },
      ] as never,
    })
    const outcome = await reactiveCompactOnPromptTooLong(input, cacheParams(), {
      customInstructions: 'custom',
      trigger: 'auto',
    })
    expect(outcome.ok).toBe(true)
    const args = compact.mock.calls[0] as unknown as unknown[]
    expect(JSON.stringify(args[0])).toContain('[image]')
    expect(args[4]).toBe('custom')
    expect(args[5]).toBe(true)
    expect(args[7]).toBe(true)
  })

  test('returns media_unstrippable when no media can be removed', async () => {
    const media = createAssistantMessage({ content: 'image too large' })
    media.isApiErrorMessage = true
    media.errorDetails = 'image exceeds 5 MB maximum'
    const outcome = await reactiveCompactOnPromptTooLong(
      [createUserMessage({ content: 'text' }), media],
      cacheParams(),
      { customInstructions: undefined, trigger: 'auto' },
    )
    expect(outcome).toEqual({ ok: false, reason: 'media_unstrippable' })
  })

  test('maps too-few-groups, abort, and exhausted outcomes', async () => {
    expect(
      await reactiveCompactOnPromptTooLong(
        [createUserMessage({ content: 'only' })],
        cacheParams(),
        { customInstructions: undefined, trigger: 'auto' },
      ),
    ).toEqual({ ok: false, reason: 'too_few_groups' })

    const aborted = cacheParams()
    aborted.toolUseContext.abortController.abort()
    expect(
      await reactiveCompactOnPromptTooLong(conversation(), aborted, {
        customInstructions: undefined,
        trigger: 'auto',
      }),
    ).toEqual({ ok: false, reason: 'aborted' })

    initReactiveCompact({
      compact: mock(async () => {
        throw new Error('Prompt is too long')
      }) as never,
    })
    expect(
      await reactiveCompactOnPromptTooLong(conversation(), cacheParams(), {
        customInstructions: undefined,
        trigger: 'auto',
      }),
    ).toEqual({ ok: false, reason: 'exhausted' })
  })
})

describe('tryReactiveCompact', () => {
  test('merges hook messages and performs success cleanup once', async () => {
    const compact = mock(async () => compactResult())
    const preCompact = mock(async () => ({
      newCustomInstructions: 'from hook',
      userDisplayMessage: 'pre',
    }))
    const onSuccess = mock(() => {})
    initReactiveCompact({
      compact: compact as never,
      preCompact: preCompact as never,
      onSuccess,
    })
    const result = await tryReactiveCompact({
      hasAttempted: false,
      querySource: 'sdk',
      aborted: false,
      messages: conversation(),
      cacheSafeParams: cacheParams(),
    })
    expect(result?.userDisplayMessage).toBe('pre\npost')
    expect(compact.mock.calls[0]?.[4]).toBe('from hook')
    expect(onSuccess).toHaveBeenCalledWith('sdk')

    expect(
      await tryReactiveCompact({
        hasAttempted: true,
        querySource: 'sdk',
        aborted: false,
        messages: conversation(),
        cacheSafeParams: cacheParams(),
      }),
    ).toBeNull()
    expect(compact).toHaveBeenCalledTimes(1)
  })
})
