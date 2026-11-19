import { afterEach, describe, expect, mock, test } from 'bun:test'
import { connect, type Socket } from 'net'
import {
  decodeChunk,
  encodeChunk,
  startNodeRelay,
  type UpstreamProxyRelay,
} from '../src/upstreamproxy/relay.ts'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly url: string
  readonly options: Record<string, unknown>
  readonly sent: Uint8Array[] = []
  readyState = WebSocket.CONNECTING
  binaryType = ''
  onopen?: () => void
  onmessage?: (event: { data: ArrayBuffer }) => void
  onerror?: (event: { message: string }) => void
  onclose?: () => void

  constructor(url: string, options: Record<string, unknown>) {
    this.url = url
    this.options = options
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = WebSocket.OPEN
    this.onopen?.()
  }

  send(data: Uint8Array) {
    this.sent.push(data)
  }

  respond(data: string) {
    this.onmessage?.({ data: encodeChunk(Buffer.from(data)).buffer as ArrayBuffer })
  }

  error() {
    this.onerror?.({ message: 'offline ws failure' })
  }

  close() {
    this.readyState = WebSocket.CLOSED
    this.onclose?.()
  }
}

mock.module('ws', () => ({ default: FakeWebSocket }))

const relays = new Set<UpstreamProxyRelay>()
const clients = new Set<Socket>()

afterEach(async () => {
  for (const client of clients) client.destroy()
  clients.clear()
  for (const relay of relays) relay.stop()
  relays.clear()
  FakeWebSocket.instances = []
})

async function startRelay(): Promise<UpstreamProxyRelay> {
  const relay = await startNodeRelay('ws://offline.invalid/tunnel', 'Basic offline', 'Bearer offline')
  relays.add(relay)
  return relay
}

function client(port: number): { socket: Socket; received: () => string } {
  const socket = connect(port, '127.0.0.1')
  clients.add(socket)
  let data = ''
  socket.on('data', chunk => {
    data += chunk.toString()
  })
  return { socket, received: () => data }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

function decoded(data: Uint8Array): string {
  const chunk = decodeChunk(data)
  if (!chunk) throw new Error('invalid chunk')
  return Buffer.from(chunk).toString()
}

describe('UpstreamProxyChunk codec', () => {
  test('round-trips empty, small and multi-byte-varint payloads and rejects malformed data', () => {
    for (const payload of [Buffer.alloc(0), Buffer.from('abc'), Buffer.alloc(128, 1), Buffer.alloc(16_384, 2)]) {
      expect(decodeChunk(encodeChunk(payload))).toEqual(payload)
    }
    expect(decodeChunk(new Uint8Array([0x0b, 0x00]))).toBeNull()
    expect(decodeChunk(new Uint8Array([0x0a, 0x05, 0x01]))).toBeNull()
    expect(decodeChunk(new Uint8Array([0x0a, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10]))).toBeNull()
  })
})

describe('Node CONNECT relay', () => {
  test('forwards fragmented CONNECT and pending bytes with proxy auth and response', async () => {
    const relay = await startRelay()
    const { socket, received } = client(relay.port)
    socket.write('CONNECT example.test:443 HTTP/1.1\r\n')
    socket.write('Proxy-Authorization: Basic dummy\r\n')
    socket.write('\r\nearly-bytes')
    await waitFor(() => FakeWebSocket.instances.length === 1)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await waitFor(() => ws.sent.length >= 2)

    expect(decoded(ws.sent[0]!)).toContain('CONNECT example.test:443 HTTP/1.1')
    expect(decoded(ws.sent[0]!)).toContain('Proxy-Authorization: Basic offline')
    expect(decoded(ws.sent[1]!)).toBe('early-bytes')
    ws.respond('HTTP/1.1 200 Connection Established\r\n\r\n')
    await waitFor(() => received().includes('200 Connection Established'))
  })

  test('rejects an oversized incomplete CONNECT header', async () => {
    const relay = await startRelay()
    const { socket, received } = client(relay.port)
    socket.write('A'.repeat(9000))
    await waitFor(() => received().includes('400 Bad Request'))
  })

  test('returns 502 when WebSocket fails before establishment', async () => {
    const relay = await startRelay()
    const { socket, received } = client(relay.port)
    socket.write('CONNECT example.test:443 HTTP/1.1\r\n\r\n')
    await waitFor(() => FakeWebSocket.instances.length === 1)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.error()
    await waitFor(() => received().includes('502 Bad Gateway'))
  })

  test('closes without injecting a plaintext 502 after establishment', async () => {
    const relay = await startRelay()
    const { socket, received } = client(relay.port)
    socket.write('CONNECT example.test:443 HTTP/1.1\r\n\r\n')
    await waitFor(() => FakeWebSocket.instances.length === 1)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.respond('HTTP/1.1 200 Connection Established\r\n\r\n')
    ws.error()
    await waitFor(() => received().includes('200 Connection Established'))
    expect(received()).not.toContain('502 Bad Gateway')
  })
})
