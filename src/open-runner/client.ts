import {
  OPEN_RUNNER_API_PREFIX,
  OPEN_RUNNER_PROTOCOL,
  OpenRunnerError,
  type LeaseIdentity,
  type RunnerIdentity,
  type WorkAssignment,
  type WorkEvent,
  type WorkEventInput,
  type WorkRecord,
  type WorkState,
} from './protocol.js'

export type OpenRunnerClientOptions = {
  serverUrl: string
  token: string
  fetch?: typeof fetch
  maxRetries?: number
  initialBackoffMs?: number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

function assertServerUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new OpenRunnerError('INVALID_REQUEST', 'Invalid Open Runner server URL', 400)
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'http:' && !loopback) {
    throw new OpenRunnerError('INVALID_REQUEST', 'Non-loopback Open Runner connections require TLS', 400)
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  return url
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

export class OpenRunnerClient {
  private readonly base: URL
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly initialBackoff: number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: OpenRunnerClientOptions) {
    this.base = assertServerUrl(options.serverUrl)
    this.fetchImpl = options.fetch ?? fetch
    this.maxRetries = options.maxRetries ?? 6
    this.initialBackoff = options.initialBackoffMs ?? 500
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    if (!options.token) throw new OpenRunnerError('INVALID_REQUEST', 'Runner token is empty', 400)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    let attempt = 0
    for (;;) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await this.fetchImpl(`${this.base.origin}${this.base.pathname}${OPEN_RUNNER_API_PREFIX}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null) as {
          protocol?: string
          error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> }
          request_id?: string
        } | null
        if (response.ok) {
          if (payload?.protocol !== OPEN_RUNNER_PROTOCOL) {
            throw new OpenRunnerError('CHILD_PROTOCOL_ERROR', 'Server returned an invalid protocol response', 502, true)
          }
          return payload as T
        }
        const retryableStatus = [408, 429, 500, 502, 503, 504].includes(response.status)
        const error = new OpenRunnerError(
          payload?.error?.code ?? 'INTERNAL_ERROR',
          payload?.error?.message ?? `Open Runner request failed (${response.status})`,
          response.status,
          payload?.error?.retryable ?? retryableStatus,
          payload?.error?.details ?? {},
          payload?.request_id,
          retryAfter(response) ?? undefined,
        )
        if (!retryableStatus || attempt >= this.maxRetries) throw error
        const delay = error.retryAfterMs ?? Math.min(30_000, this.initialBackoff * 2 ** attempt) * this.random()
        attempt++
        await this.sleep(delay)
      } catch (error) {
        if (error instanceof OpenRunnerError && ![408, 429, 500, 502, 503, 504].includes(error.status)) {
          throw error
        }
        if (error instanceof OpenRunnerError && error.status !== 0 && attempt > this.maxRetries) throw error
        if (error instanceof OpenRunnerError && [408, 429, 500, 502, 503, 504].includes(error.status)) throw error
        if (attempt >= this.maxRetries) {
          throw new OpenRunnerError('INTERNAL_ERROR', 'Open Runner network request failed', 503, true)
        }
        const delay = Math.min(30_000, this.initialBackoff * 2 ** attempt) * this.random()
        attempt++
        await this.sleep(delay)
      } finally {
        clearTimeout(timeout)
      }
    }
  }

  async register(identity: { runner_id: string; instance_id: string }, maxWork = 1) {
    const response = await this.request<{
      protocol: typeof OPEN_RUNNER_PROTOCOL
      runner_id: string
      instance_id: string
      worker_epoch: number
      heartbeat_interval_ms: number
      lease_ms: number
      server_time: string
    }>('POST', '/runners/register', {
      ...identity,
      capabilities: {
        max_work: maxWork,
        permission_modes: ['default', 'acceptEdits', 'plan'],
      },
    })
    return response
  }

  async submit(value: { work_id: string; input: unknown; max_attempts?: number; max_runtime_ms?: number }): Promise<WorkRecord> {
    return (await this.request<{ work: WorkRecord }>('POST', '/work', value)).work
  }

  async poll(identity: RunnerIdentity, maxWork: number, waitMs: number): Promise<{
    server_time: string
    work: WorkAssignment[]
    cancel_requested: string[]
  }> {
    return this.request('POST', '/work/poll', {
      ...identity,
      max_work: maxWork,
      wait_ms: waitMs,
    }, waitMs + 5_000)
  }

  private workPath(workId: string, action: string): string {
    return `/work/${encodeURIComponent(workId)}/${action}`
  }

  async acknowledge(workId: string, identity: LeaseIdentity): Promise<WorkRecord> {
    return (await this.request<{ work: WorkRecord }>('POST', this.workPath(workId, 'ack'), identity)).work
  }

  async heartbeat(workId: string, identity: LeaseIdentity): Promise<{
    lease_expires_at: string
    state: WorkState
    cancel_requested: boolean
  }> {
    return this.request('POST', this.workPath(workId, 'heartbeat'), identity)
  }

  async appendEvents(workId: string, identity: LeaseIdentity, events: WorkEventInput[]): Promise<{
    accepted: { event_id: string; seq: number }[]
    last_seq: number
  }> {
    return this.request('POST', this.workPath(workId, 'events'), { ...identity, events })
  }

  async complete(workId: string, identity: LeaseIdentity, completion: {
    outcome: 'succeeded' | 'failed' | 'cancelled'
    retryable?: boolean
    result?: Record<string, unknown>
    error?: { code: string; message: string }
  }): Promise<WorkRecord> {
    return (await this.request<{ work: WorkRecord }>('POST', this.workPath(workId, 'complete'), {
      ...identity,
      ...completion,
    })).work
  }

  async getWork(workId: string, workerIdentity?: LeaseIdentity): Promise<WorkRecord> {
    const query = workerIdentity ? `?${new URLSearchParams({
      runner_id: workerIdentity.runner_id,
      instance_id: workerIdentity.instance_id,
      worker_epoch: String(workerIdentity.worker_epoch),
      lease_id: workerIdentity.lease_id,
    })}` : ''
    return (await this.request<{ work: WorkRecord }>('GET', `/work/${encodeURIComponent(workId)}${query}`)).work
  }

  async readEvents(workId: string, after = 0, limit = 100, workerIdentity?: LeaseIdentity): Promise<{
    work_id: string
    events: WorkEvent[]
    last_seq: number
    has_more: boolean
  }> {
    const parameters = new URLSearchParams({ after: String(after), limit: String(limit) })
    if (workerIdentity) {
      parameters.set('runner_id', workerIdentity.runner_id)
      parameters.set('instance_id', workerIdentity.instance_id)
      parameters.set('worker_epoch', String(workerIdentity.worker_epoch))
      parameters.set('lease_id', workerIdentity.lease_id)
    }
    return this.request('GET', `/work/${encodeURIComponent(workId)}/events?${parameters}`)
  }

  async cancel(workId: string, reason?: string): Promise<WorkRecord> {
    return (await this.request<{ work: WorkRecord }>('POST', this.workPath(workId, 'cancel'), reason === undefined ? {} : { reason })).work
  }

  async listWorks(state?: WorkState, limit = 100): Promise<WorkRecord[]> {
    const parameters = new URLSearchParams({ limit: String(limit) })
    if (state) parameters.set('state', state)
    return (await this.request<{ work: WorkRecord[] }>(`GET`, `/work?${parameters}`)).work
  }
}
