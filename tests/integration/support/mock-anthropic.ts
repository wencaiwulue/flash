export interface ResponseGate {
  promise: Promise<void>
  release(): void
}

export function createResponseGate(): ResponseGate {
  let releasePromise!: () => void
  let released = false
  const promise = new Promise<void>(resolve => {
    releasePromise = resolve
  })
  return {
    promise,
    release() {
      if (released) return
      released = true
      releasePromise()
    },
  }
}

type Gated = { gate?: ResponseGate }

export type ScriptedResponse =
  | ({ type: 'text'; text: string } & Gated)
  | ({ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } & Gated)
  | ({ type: 'error'; status: number; body: Record<string, unknown> } & Gated)

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
  // 按请求路由（优先于队列）：返回 null 则回落到队列。
  // 用途：haiku 辅助请求是否发生不确定，按 body.model 路由可彻底确定化。
  setRouter(router: ((request: RecordedRequest) => ScriptedResponse | null) | null): void
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
  let router: ((request: RecordedRequest) => ScriptedResponse | null) | null = null
  let idCounter = 0

  const stopController = new AbortController()
  const pendingHandlers = new Set<Promise<void>>()
  let stopped = false

  async function waitForGate(gate: ResponseGate | undefined, requestSignal: AbortSignal): Promise<void> {
    if (!gate) return
    const signals = [requestSignal, stopController.signal]
    const aborted = signals.find(signal => signal.aborted)
    if (aborted) throw aborted.reason ?? new DOMException('The operation was aborted', 'AbortError')

    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
    try {
      await Promise.race([
        gate.promise,
        ...signals.map(signal => new Promise<never>((_, reject) => {
          const listener = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
          listeners.push({ signal, listener })
          signal.addEventListener('abort', listener, { once: true })
        })),
      ])
    } finally {
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
    }
  }

  async function handleRequest(req: Request): Promise<Response> {
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

    const lastRecorded = requests.at(-1)!
    const routed = router ? router(lastRecorded) : null
    const scripted = routed ?? queue.shift() ?? { type: 'text' as const, text: 'mock-anthropic: response queue is empty' }
    await waitForGate(scripted.gate, req.signal)
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
  }

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      let complete!: () => void
      const done = new Promise<void>(resolve => {
        complete = resolve
      })
      pendingHandlers.add(done)
      return handleRequest(req).finally(() => {
        pendingHandlers.delete(done)
        complete()
      })
    },
  })

  return {
    url: server.url.toString().replace(/\/$/, ''),
    requests,
    enqueue(...responses: ScriptedResponse[]) {
      queue.push(...responses)
    },
    setRouter(newRouter) {
      router = newRouter
    },
    async stop() {
      const hadPendingHandlers = pendingHandlers.size > 0
      if (!stopped) {
        stopped = true
        if (hadPendingHandlers) {
          stopController.abort(new Error('mock-anthropic: server stopped'))
        }
        server.stop(true)
      }
      await Promise.allSettled([...pendingHandlers])
      if (hadPendingHandlers) {
        throw new Error('mock-anthropic: stop called with a pending request handler')
      }
    },
  }
}
