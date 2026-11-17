import { describe, test, expect, afterAll } from 'bun:test'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from './mock-anthropic.ts'

const mocks: MockAnthropic[] = []
async function started(): Promise<MockAnthropic> {
  const mock = await createMockAnthropic()
  mocks.push(mock)
  return mock
}
afterAll(async () => {
  for (const mock of mocks) await mock.stop()
})

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

  test('404 for unknown routes', async () => {
    const mock = await started()
    const res = await fetch(`${mock.url}/v1/unknown`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
