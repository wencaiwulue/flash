/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

import { randomUUID } from 'crypto'
import { errorMessage } from '../utils/errors.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { DirectConnectConfig } from './directConnectManager.js'
import {
  directConnectFetchOptions,
  directConnectHttpUrl,
} from './directConnectTransport.js'
import { connectResponseSchema } from './types.js'

export type DirectConnectErrorCode =
  | 'SERVER_UNREACHABLE'
  | 'HTTP_ERROR'
  | 'INVALID_SESSION_RESPONSE'
  | string

/** Errors thrown by createDirectConnectSession when the connection fails. */
export class DirectConnectError extends Error {
  constructor(
    message: string,
    readonly code: DirectConnectErrorCode = 'HTTP_ERROR',
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'DirectConnectError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function responseError(response: Response): Promise<DirectConnectError> {
  let code = 'HTTP_ERROR'
  let message = `Failed to create session: ${response.status} ${response.statusText}`
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown }
    }
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string') message = body.error.message
  } catch {
    // Keep the status-only message; never echo an untrusted response body.
  }
  return new DirectConnectError(
    message,
    code,
    response.status,
    response.status === 429 || response.status === 503,
  )
}

/** Create/resume a session while preserving the legacy config/message shape. */
export async function createDirectConnectSession({
  serverUrl,
  authToken,
  cwd,
  dangerouslySkipPermissions,
  sessionId,
  clientRequestId = randomUUID(),
}: {
  serverUrl: string
  authToken?: string
  cwd: string
  dangerouslySkipPermissions?: boolean
  sessionId?: string
  clientRequestId?: string
}): Promise<{
  config: DirectConnectConfig
  workDir?: string
  resumed?: boolean
  lastSeq?: number
}> {
  const token = authToken ?? process.env.CLAUDE_DIRECT_CONNECT_TOKEN
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const body = jsonStringify({
    cwd,
    ...(dangerouslySkipPermissions && {
      dangerously_skip_permissions: true,
    }),
    ...(sessionId ? { session_id: sessionId } : {}),
    client_request_id: clientRequestId,
  })

  let lastError: DirectConnectError | undefined
  for (let attempt = 0; attempt <= 3; attempt++) {
    let response: Response
    try {
      response = await fetch(directConnectHttpUrl(serverUrl, '/sessions'), {
        ...directConnectFetchOptions(serverUrl),
        method: 'POST',
        headers,
        body,
      })
    } catch (error) {
      lastError = new DirectConnectError(
        `Failed to connect to server at ${serverUrl}: ${errorMessage(error)}`,
        'SERVER_UNREACHABLE',
        undefined,
        true,
      )
      if (attempt < 3) {
        await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 50))
        continue
      }
      throw lastError
    }

    if (!response.ok) {
      const error = await responseError(response)
      if (!error.retryable || attempt === 3) throw error
      lastError = error
      await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 50))
      continue
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new DirectConnectError(
        `Invalid session response: ${errorMessage(error)}`,
        'INVALID_SESSION_RESPONSE',
      )
    }
    const result = connectResponseSchema().safeParse(payload)
    if (!result.success) {
      throw new DirectConnectError(
        `Invalid session response: ${result.error.message}`,
        'INVALID_SESSION_RESPONSE',
      )
    }

    const data = result.data
    return {
      config: {
        serverUrl,
        sessionId: data.session_id,
        wsUrl: data.ws_url,
        authToken: token,
        // A new client has processed no events; HTTP last_seq is status only.
        lastSeq: 0,
        dangerouslySkipPermissions,
      },
      workDir: data.work_dir,
      resumed: data.resumed,
      lastSeq: data.last_seq,
    }
  }
  throw lastError ?? new DirectConnectError('Failed to create session')
}
