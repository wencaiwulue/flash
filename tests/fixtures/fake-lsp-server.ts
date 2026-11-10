let buffer = Buffer.alloc(0)

function respond(id: unknown, result: unknown): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body.toString()}`)
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.slice(0, headerEnd).toString()
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1])
    if (!Number.isFinite(length)) {
      buffer = Buffer.alloc(0)
      return
    }
    if (buffer.length < headerEnd + 4 + length) return
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString()
    buffer = buffer.slice(headerEnd + 4 + length)
    const request = JSON.parse(body) as { id?: unknown; method?: string; params?: unknown }
    if (request.method === 'initialize') {
      respond(request.id, { capabilities: { textDocumentSync: 1 } })
    } else if (request.method === 'shutdown') {
      respond(request.id, null)
      const delay = Number(process.env.FAKE_LSP_SHUTDOWN_DELAY ?? 0)
      setTimeout(() => process.exit(0), delay)
    } else if (request.method === 'x-crash') {
      process.exit(1)
    } else if (request.method === 'x-echo') {
      respond(request.id, request.params)
    } else if (request.id !== undefined) {
      respond(request.id, null)
    }
  }
})
