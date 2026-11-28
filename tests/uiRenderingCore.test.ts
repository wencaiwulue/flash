import { describe, expect, test } from 'bun:test'
import { hasThinkingContent } from '../src/components/Message.tsx'

describe('thinking content detection', () => {
  test('detects only assistant thinking and redacted-thinking blocks', () => {
    expect(hasThinkingContent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'thought' }] },
    })).toBe(true)
    expect(hasThinkingContent({
      type: 'assistant',
      message: { content: [{ type: 'redacted_thinking', data: 'opaque' }] },
    })).toBe(true)
    expect(hasThinkingContent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'plain' }] },
    })).toBe(false)
    expect(hasThinkingContent({
      type: 'user',
      message: { content: [{ type: 'thinking', thinking: 'user text' }] },
    })).toBe(false)
  })
})
