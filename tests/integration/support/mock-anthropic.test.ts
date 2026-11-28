import { describe, test, expect, afterAll } from 'bun:test'
import { createMockAnthropic, createResponseGate, MOCK_API_KEY, type MockAnthropic } from './mock-anthropic.ts'

const mocks: MockAnthropic[] = []
async function started(): Promise<MockAnthropic> {
  const mock = await createMockAnthropic()
  mocks.push(mock)
  return mock
}
afterAll(async () => {
  for (const mock of mocks) await mock.stop()
})

async function waitForRequest(mock: MockAnthropic): Promise<void> {
  const deadline = Date.now() + 2_000
  while (mock.requests.length === 0) {
    if (Date.now() >= deadline) throw new Error('mock request did not arrive')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function postMessage(mock: MockAnthropic, signal?: AbortSignal): Promise<Response> {
  return fetch(`${mock.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-mock', messages: [] }),
    signal,
  })
}

describe('mock-anthropic', () => {
  test('serves scripted text response for /v1/messages', async () => {
    const mock = await started()
    mock.enqueue({ type: 'text', text: 'SCRIPTED_TEXT_A1' })
    const res = await fetch(`${mock.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': MOCK_API_KEY },
      body: JSON.stringify({ model: 'claude-mock', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('message')
    expect(body.content[0].type).toBe('text')
    expect(body.content[0].text).toBe('SCRIPTED_TEXT_A1')
    expect(body.usage).toBeDefined()
  })

  test('scripts tool_use blocks', async () => {
    const mock = await started()
    mock.enqueue({ type: 'tool_use', id: 'toolu_mock_1', name: 'Bash', input: { command: 'echo x' } })
    const res = await fetch(`${mock.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-mock', messages: [] }),
    })
    const body = await res.json()
    expect(body.content[0]).toEqual({ type: 'tool_use', id: 'toolu_mock_1', name: 'Bash', input: { command: 'echo x' } })
  })

  test('scripts error responses', async () => {
    const mock = await started()
    mock.enqueue({ type: 'error', status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } })
    const res = await fetch(`${mock.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-mock', messages: [] }),
    })
    expect(res.status).toBe(429)
  })

  test('streams SSE events for stream:true', async () => {
    const mock = await started()
    mock.enqueue({ type: 'text', text: 'STREAM_PART_B2' })
    const res = await fetch(`${mock.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-mock', messages: [], stream: true }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const raw = await res.text()
    expect(raw).toContain('event: message_start')
    expect(raw).toContain('event: content_block_delta')
    expect(raw).toContain('STREAM_PART_B2')
    expect(raw).toContain('event: message_stop')
  })

  test('answers count_tokens', async () => {
    const mock = await started()
    const res = await fetch(`${mock.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-mock', messages: [] }),
    })
    const body = await res.json()
    expect(typeof body.input_tokens).toBe('number')
  })

  test('records received requests', async () => {
    const mock = await started()
    mock.enqueue({ type: 'text', text: 'x' })
    await fetch(`${mock.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-record', messages: [] }),
    })
    const recorded = mock.requests.find(r => r.path === '/v1/messages')
    expect(recorded).toBeDefined()
    expect(recorded!.method).toBe('POST')
    expect((recorded!.body as Record<string, unknown>).model).toBe('claude-record')
  })

  test('falls back to identifiable text when queue is empty', async () => {
    const mock = await started()
    const res = await fetch(`${mock.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-mock', messages: [] }),
    })
    const body = await res.json()
    expect(body.content[0].text).toContain('response queue is empty')
  })

  test('records a gated request before release and releases it idempotently', async () => {
    const mock = await started()
    const gate = createResponseGate()
    mock.enqueue(
      { type: 'text', text: 'GATED_RESPONSE', gate },
      { type: 'text', text: 'NEXT_RESPONSE' },
    )

    let settled = false
    const pending = postMessage(mock).then(response => {
      settled = true
      return response
    })
    await waitForRequest(mock)
    expect(mock.requests).toHaveLength(1)
    expect(settled).toBe(false)

    gate.release()
    gate.release()
    const gated = await pending
    expect((await gated.json()).content[0].text).toBe('GATED_RESPONSE')

    const next = await postMessage(mock)
    expect((await next.json()).content[0].text).toBe('NEXT_RESPONSE')
  })

  test('request abort releases a gated fetch and shutdown drains its handler', async () => {
    const mock = await started()
    const gate = createResponseGate()
    mock.enqueue({ type: 'text', text: 'NEVER_SENT', gate })
    const controller = new AbortController()

    const pending = postMessage(mock, controller.signal)
    const observed = pending.then(() => null, error => error as unknown)
    await waitForRequest(mock)
    controller.abort()

    expect(await observed).toBeInstanceOf(Error)
    // The server may learn about client abort only when stop closes the socket.
    // If its handler is still pending, strict stop rejects after draining it.
    await mock.stop().catch(error => {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('pending request handler')
    })
    await mock.stop()
    gate.release()
  })

  test('stop rejects when request handlers are still pending and unhangs them', async () => {
    const mock = await started()
    const gate = createResponseGate()
    mock.enqueue({ type: 'text', text: 'BLOCKED_AT_SHUTDOWN', gate })

    const pending = postMessage(mock)
    const observed = pending.then(() => 'response', () => 'error')
    await waitForRequest(mock)

    await expect(mock.stop()).rejects.toThrow('pending request handler')
    expect(['response', 'error']).toContain(await observed)
    await mock.stop()
  })

  test('404 for unknown routes', async () => {
    const mock = await started()
    const res = await fetch(`${mock.url}/v1/unknown`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
