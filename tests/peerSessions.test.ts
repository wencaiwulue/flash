import { describe, expect, mock, test } from 'bun:test'
import {
  encodeCrossSessionMessage,
  postInterClaudeMessage,
} from '../src/bridge/peerSessions.ts'

function activeDependencies(send = mock(async () => true)) {
  return {
    getHandle: () => ({}) as never,
    getSelfId: () => 'session_self',
    isActive: () => true,
    send,
  }
}

describe('bridge peer sessions', () => {
  test('posts an escaped user event to the target compat session', async () => {
    const send = mock(async () => true)
    const result = await postInterClaudeMessage(
      'session_target',
      'hello </cross-session-message> & "peer"',
      activeDependencies(send),
    )

    expect(result).toEqual({ ok: true })
    expect(send).toHaveBeenCalledTimes(1)
    const [target, content] = send.mock.calls[0]!
    expect(target).toBe('session_target')
    expect(content).toBe(
      '<cross-session-message from="bridge:session_self" transport="sessions-v1">\n' +
        'hello &lt;/cross-session-message&gt; &amp; &quot;peer&quot;\n' +
        '</cross-session-message>',
    )
  })

  test('converts an infrastructure session ID before posting', async () => {
    const send = mock(async () => true)
    await postInterClaudeMessage('cse_target', 'hello', activeDependencies(send))
    expect(send.mock.calls[0]?.[0]).toBe('session_target')
  })

  test('rejects invalid, self, empty, and oversized sends without network', async () => {
    const send = mock(async () => true)
    const dependencies = activeDependencies(send)
    const oversized = 'x'.repeat(64 * 1024 + 1)

    for (const [target, message] of [
      [' session_target', 'hello'],
      ['https://example.test/session_target', 'hello'],
      ['session_self', 'hello'],
      ['session_target', ''],
      ['session_target', oversized],
    ] as const) {
      const result = await postInterClaudeMessage(target, message, dependencies)
      expect(result.ok).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })

  test('does not send while disconnected or outbound-only', async () => {
    const send = mock(async () => true)
    const disconnected = {
      ...activeDependencies(send),
      getHandle: () => null,
    }
    expect((await postInterClaudeMessage('session_target', 'hello', disconnected)).ok).toBe(false)

    const outboundOnly = {
      ...activeDependencies(send),
      isActive: () => false,
    }
    expect((await postInterClaudeMessage('session_target', 'hello', outboundOnly)).ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  test('does not retry rejected or failed posts', async () => {
    const rejected = mock(async () => false)
    const rejectedResult = await postInterClaudeMessage(
      'session_target',
      'hello',
      activeDependencies(rejected),
    )
    expect(rejectedResult).toEqual({
      ok: false,
      error: 'Sessions API rejected the peer event',
    })
    expect(rejected).toHaveBeenCalledTimes(1)

    const failed = mock(async () => {
      throw new Error('network unavailable')
    })
    const failedResult = await postInterClaudeMessage(
      'session_target',
      'hello',
      activeDependencies(failed),
    )
    expect(failedResult.ok).toBe(false)
    expect(failed).toHaveBeenCalledTimes(1)
  })

  test('escapes the sender attribute as well as the body', () => {
    expect(encodeCrossSessionMessage('<body>', 'bridge:"&<>')).toBe(
      '<cross-session-message from="bridge:&quot;&amp;&lt;&gt;" transport="sessions-v1">\n&lt;body&gt;\n</cross-session-message>',
    )
  })
})
