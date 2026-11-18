let buffer = Buffer.alloc(0)

// State for tracking diagnostics and content modified retries
let publishDiagnosticsParams: unknown = null
let contentModifiedRequestCount = 0
let contentModifiedMaxFailures = 0
let symbols: unknown[] = []
let definitions: unknown[] = []
let references: unknown[] = []

function respond(id: unknown, result: unknown): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body.toString()}`)
}

function sendNotification(method: string, params: unknown): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body.toString()}`)
}

function respondError(id: unknown, code: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
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
      respond(request.id, {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          implementationProvider: true,
          callHierarchyProvider: true,
        },
      })
    } else if (request.method === 'initialized') {
      // No response needed for notification
      // If we have diagnostics to publish, send them now
      if (publishDiagnosticsParams) {
        setTimeout(() => sendNotification('textDocument/publishDiagnostics', publishDiagnosticsParams), 50)
      }
    } else if (request.method === 'shutdown') {
      respond(request.id, null)
      const delay = Number(process.env.FAKE_LSP_SHUTDOWN_DELAY ?? 0)
      setTimeout(() => process.exit(0), delay)
    } else if (request.method === 'exit') {
      process.exit(0)
    } else if (request.method === 'x-crash') {
      process.exit(1)
    } else if (request.method === 'x-echo') {
      respond(request.id, request.params)
    } else if (request.method === 'x-set-diagnostics') {
      // Set diagnostics to be published when initialized
      publishDiagnosticsParams = (request.params as { diagnostics: unknown }).diagnostics
      respond(request.id, { success: true })
    } else if (request.method === 'x-set-content-modified') {
      // Configure how many times to return ContentModified before succeeding
      const params = request.params as { maxFailures: number; result?: unknown }
      contentModifiedMaxFailures = params.maxFailures
      contentModifiedRequestCount = 0
      respond(request.id, { success: true })
    } else if (request.method === 'x-set-symbols') {
      symbols = (request.params as { symbols: unknown[] }).symbols
      respond(request.id, { success: true })
    } else if (request.method === 'x-set-definitions') {
      definitions = (request.params as { definitions: unknown[] }).definitions
      respond(request.id, { success: true })
    } else if (request.method === 'x-set-references') {
      references = (request.params as { references: unknown[] }).references
      respond(request.id, { success: true })
    } else if (request.method === 'textDocument/hover') {
      if (contentModifiedRequestCount < contentModifiedMaxFailures) {
        contentModifiedRequestCount++
        respondError(request.id, -32801, 'Content modified')
      } else {
        contentModifiedRequestCount = 0
        respond(request.id, {
          contents: { kind: 'markdown', value: 'Hover content' },
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        })
      }
    } else if (request.method === 'textDocument/definition') {
      if (contentModifiedRequestCount < contentModifiedMaxFailures) {
        contentModifiedRequestCount++
        respondError(request.id, -32801, 'Content modified')
      } else {
        contentModifiedRequestCount = 0
        respond(request.id, definitions.length > 0 ? definitions : null)
      }
    } else if (request.method === 'textDocument/references') {
      if (contentModifiedRequestCount < contentModifiedMaxFailures) {
        contentModifiedRequestCount++
        respondError(request.id, -32801, 'Content modified')
      } else {
        contentModifiedRequestCount = 0
        respond(request.id, references.length > 0 ? references : null)
      }
    } else if (request.method === 'textDocument/documentSymbol') {
      if (contentModifiedRequestCount < contentModifiedMaxFailures) {
        contentModifiedRequestCount++
        respondError(request.id, -32801, 'Content modified')
      } else {
        contentModifiedRequestCount = 0
        respond(request.id, symbols.length > 0 ? symbols : null)
      }
    } else if (request.method === 'workspace/symbol') {
      if (contentModifiedRequestCount < contentModifiedMaxFailures) {
        contentModifiedRequestCount++
        respondError(request.id, -32801, 'Content modified')
      } else {
        contentModifiedRequestCount = 0
        respond(request.id, symbols.length > 0 ? symbols : null)
      }
    } else if (request.method === 'textDocument/implementation') {
      if (contentModifiedRequestCount < contentModifiedMaxFailures) {
        contentModifiedRequestCount++
        respondError(request.id, -32801, 'Content modified')
      } else {
        contentModifiedRequestCount = 0
        respond(request.id, definitions.length > 0 ? definitions : null)
      }
    } else if (request.method === 'textDocument/prepareCallHierarchy') {
      if (contentModifiedRequestCount < contentModifiedMaxFailures) {
        contentModifiedRequestCount++
        respondError(request.id, -32801, 'Content modified')
      } else {
        contentModifiedRequestCount = 0
        const params = request.params as { textDocument: { uri: string }; position: { line: number; character: number } }
        respond(request.id, [
          {
            name: 'testFunction',
            kind: 12, // Function
            uri: params.textDocument.uri,
            range: { start: { line: params.position.line, character: 0 }, end: { line: params.position.line, character: 10 } },
            selectionRange: { start: { line: params.position.line, character: 0 }, end: { line: params.position.line, character: 10 } },
          },
        ])
      }
    } else if (request.method === 'callHierarchy/incomingCalls') {
      respond(request.id, [])
    } else if (request.method === 'callHierarchy/outgoingCalls') {
      respond(request.id, [])
    } else if (request.id !== undefined) {
      // Respond with null for unknown methods that have an id
      respond(request.id, null)
    }
  }
})
