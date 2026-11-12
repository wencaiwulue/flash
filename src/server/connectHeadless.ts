import { createInterface } from 'readline'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import {
  DirectConnectSessionManager,
  type DirectConnectConfig,
} from './directConnectManager.js'

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`)
}

function outputMessage(message: SDKMessage, format: string): void {
  const raw = message as unknown as Record<string, unknown>
  if (format === 'stream-json') {
    writeLine(JSON.stringify(message))
    return
  }
  if (format === 'json') {
    if (message.type === 'result') writeLine(JSON.stringify(message))
    return
  }
  if (message.type === 'assistant') {
    const content = (raw.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        process.stdout.write((block as { text: string }).text)
      }
    }
  }
}

function resultFailed(message: SDKMessage): boolean {
  const raw = message as unknown as Record<string, unknown>
  return (
    message.type === 'result' &&
    (raw.is_error === true || (raw.subtype !== 'success' && raw.subtype !== undefined))
  )
}

/** Run the public print/NDJSON mode over the same manager used by the REPL. */
export async function runConnectHeadless(
  config: DirectConnectConfig,
  prompt: string,
  outputFormat: string,
  interactive: boolean,
): Promise<void> {
  if (!['text', 'json', 'stream-json'].includes(outputFormat)) {
    throw new Error(`Unsupported output format: ${outputFormat}`)
  }

  let connected!: () => void
  let connectionFailed!: (error: Error) => void
  const connectedPromise = new Promise<void>((resolve, reject) => {
    connected = resolve
    connectionFailed = reject
  })
  let turnComplete!: (message: SDKMessage) => void
  let turnPromise = new Promise<SDKMessage>(resolve => {
    turnComplete = resolve
  })
  let terminalError: Error | undefined
  let latestResult: SDKMessage | undefined

  const manager = new DirectConnectSessionManager(
    { ...config, maxReconnectAttempts: 3 },
    {
      onConnected: connected,
      onMessage: message => {
        outputMessage(message, outputFormat)
        if (message.type === 'result') {
          latestResult = message
          turnComplete(message)
          turnPromise = new Promise<SDKMessage>(resolve => {
            turnComplete = resolve
          })
        }
      },
      onPermissionRequest: (request, requestId) => {
        if (interactive) {
          // NDJSON controllers answer with control_response on stdin.
          writeLine(
            JSON.stringify({
              type: 'control_request',
              request_id: requestId,
              request,
            }),
          )
          return
        }
        if (config.dangerouslySkipPermissions) {
          manager.respondToPermissionRequest(requestId, {
            behavior: 'allow',
            updatedInput: request.input,
          })
        } else {
          manager.respondToPermissionRequest(requestId, {
            behavior: 'deny',
            message: 'Permission prompts are unavailable in non-interactive mode',
          })
        }
      },
      onDisconnected: () => {
        const error = new Error('Direct-connect WebSocket disconnected')
        terminalError = error
        connectionFailed(error)
        turnComplete({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
        } as SDKMessage)
      },
      onStopped: () => {
        terminalError = new Error('Direct-connect session stopped')
        turnComplete({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
        } as SDKMessage)
      },
      onError: error => {
        if (config.maxReconnectAttempts === 0) terminalError = error
      },
    },
  )

  manager.connect()
  try {
    await connectedPromise
    if (!interactive) {
      if (!manager.sendMessage(prompt)) throw new Error('Unable to queue prompt')
      const result = await turnPromise
      if (terminalError || resultFailed(result)) process.exitCode = 1
      return
    }

    const pendingTurns: Promise<SDKMessage>[] = []
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      if (Buffer.byteLength(line) > 1024 * 1024) {
        throw new Error('Input message exceeds 1 MiB')
      }
      const value = JSON.parse(line) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Interactive input must contain NDJSON objects')
      }
      const record = value as Record<string, unknown>
      if (record.type === 'user') {
        pendingTurns.push(turnPromise)
      }
      if (!manager.sendMessageRecord(record)) {
        throw new Error('Unable to queue input message')
      }
    }
    const results = await Promise.all(pendingTurns)
    if (terminalError || results.some(resultFailed) || latestResult && resultFailed(latestResult)) {
      process.exitCode = 1
    }
  } catch (error) {
    process.exitCode = 1
    throw error
  } finally {
    manager.disconnect()
  }
}
