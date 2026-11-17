export type ScriptedResponse =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'error'; status: number; body: Record<string, unknown> }

export interface RecordedRequest {
  path: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

export interface MockAnthropic {
  url: string
  requests: RecordedRequest[]
  enqueue(...responses: ScriptedResponse[]): void
  stop(): Promise<void>
}

export const MOCK_API_KEY = 'mock-key'

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type ContentBlock = TextBlock | ToolUseBlock

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function createMockAnthropic(): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = []
  const queue: ScriptedResponse[] = []
  let idCounter = 0

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const headers: Record<string, string> = {}
      req.headers.forEach((value, key) => {
        headers[key] = value
      })
      const body = req.method === 'POST'
        ? await req.json().catch(() => null)
        : null
      requests.push({ path: url.pathname, method: req.method, headers, body })

      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        return Response.json({ input_tokens: JSON.stringify(body).length })
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
        return Response.json(
          { error: { type: 'not_found', message: `mock-anthropic: no route for ${req.method} ${url.pathname}` } },
          { status: 404 },
        )
      }

      const scripted = queue.shift() ?? { type: 'text' as const, text: 'mock-anthropic: response queue is empty' }
      if (scripted.type === 'error') {
        return Response.json(scripted.body, { status: scripted.status })
      }

      const request = body as Record<string, unknown>
      const model = (request?.model as string) ?? 'mock-model'
      const id = `msg_mock_${++idCounter}`
      const content: ContentBlock[] = scripted.type === 'tool_use'
        ? [{ type: 'tool_use', id: scripted.id, name: scripted.name, input: scripted.input }]
        : [{ type: 'text', text: scripted.text }]
      const usage = { input_tokens: 10, output_tokens: 10 }

      if (!request?.stream) {
        return Response.json({
          id, type: 'message', role: 'assistant', model, content,
          stop_reason: 'end_turn', stop_sequence: null, usage,
        })
      }

      const chunks: string[] = []
      chunks.push(sse('message_start', {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage },
      }))
      content.forEach((block, index) => {
        chunks.push(sse('content_block_start', { type: 'content_block_start', index, content_block: block }))
        chunks.push(sse('content_block_delta', block.type === 'text'
          ? { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }
          : { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
        ))
        chunks.push(sse('content_block_stop', { type: 'content_block_stop', index }))
      })
      chunks.push(sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      }))
      chunks.push(sse('message_stop', { type: 'message_stop' }))
      return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } })
    },
  })

  return {
    url: server.url.toString().replace(/\/$/, ''),
    requests,
    enqueue(...responses: ScriptedResponse[]) {
      queue.push(...responses)
    },
    async stop() {
      server.stop(true)
    },
  }
}
