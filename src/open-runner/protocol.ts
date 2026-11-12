import { createHash, randomUUID } from 'crypto'
import { lstat, readFile } from 'fs/promises'
import { isAbsolute, resolve, sep } from 'path'

export const OPEN_RUNNER_PROTOCOL = 'open-runner-v1' as const
export const OPEN_RUNNER_API_PREFIX = '/open-runner/v1'
export const OPEN_RUNNER_SERVER_VERSION = '1.0.0'
export const MAX_PROMPT_BYTES = 256 * 1024
export const MAX_EVENT_BYTES = 4 * 1024 * 1024
export const MAX_EVENT_BATCH_BYTES = 8 * 1024 * 1024
export const DEFAULT_LEASE_MS = 30_000
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export const WORK_STATES = [
  'queued',
  'leased',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type WorkState = (typeof WORK_STATES)[number]
export type TerminalWorkState = 'succeeded' | 'failed' | 'cancelled'
export type OpenRunnerRole = 'worker' | 'admin'

export type WorkInput = {
  prompt: string
  cwd: string
  model?: string
  permission_mode: PermissionMode
  session_id?: string
}

export type WorkError = {
  code: string
  message: string
}

export type WorkRecord = {
  protocol?: typeof OPEN_RUNNER_PROTOCOL
  work_id: string
  session_id: string
  state: WorkState
  attempt: number
  input: WorkInput
  max_attempts: number
  max_runtime_ms: number
  cancel_requested: boolean
  created_at: string
  updated_at: string
  last_seq: number
  result: Record<string, unknown> | null
  error: WorkError | null
}

export type WorkAssignment = {
  work_id: string
  session_id: string
  attempt: number
  lease_id: string
  lease_expires_at: string
  input: WorkInput
  max_runtime_ms: number
}

export type RunnerIdentity = {
  runner_id: string
  instance_id: string
  worker_epoch: number
}

export type LeaseIdentity = RunnerIdentity & { lease_id: string }

export type RunnerRegistration = {
  runner_id: string
  instance_id: string
  worker_epoch: number
  heartbeat_interval_ms: number
  lease_ms: number
  server_time: string
}

export type WorkEventInput = {
  event_id: string
  kind: 'sdk' | 'process' | 'log' | 'error'
  occurred_at: string
  message: unknown
}

export type WorkEvent = WorkEventInput & { seq: number }

export type OpenRunnerErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'INVALID_REQUEST'
  | 'WORK_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EVENT_ID_CONFLICT'
  | 'TERMINAL_CONFLICT'
  | 'STALE_LEASE'
  | 'STALE_WORKER_EPOCH'
  | 'WORK_TERMINAL'
  | 'CAPACITY_EXCEEDED'
  | 'SERVER_DRAINING'
  | 'RECOVERY_CONFLICT'
  | 'WORK_TIMEOUT'
  | 'RATE_LIMITED'
  | 'CHILD_EXIT'
  | 'CHILD_PROTOCOL_ERROR'
  | 'RUNNER_RESTARTED'
  | 'LEASE_EXPIRED'
  | 'INTERNAL_ERROR'

export class OpenRunnerError extends Error {
  constructor(
    readonly code: OpenRunnerErrorCode | string,
    message: string,
    readonly status = 400,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'OpenRunnerError'
  }
}

export function invalidRequest(message: string): OpenRunnerError {
  return new OpenRunnerError('INVALID_REQUEST', message, 400)
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function assertObject(
  value: unknown,
  name = 'request',
): Record<string, unknown> {
  if (!isObject(value)) throw invalidRequest(`${name} must be an object`)
  return value
}

export function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidRequest(`Unsupported field: ${key}`)
  }
  for (const key of required) {
    if (value[key] === undefined) throw invalidRequest(`Missing field: ${key}`)
  }
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}

export function assertUuid(value: unknown, name: string): string {
  if (!isUuid(value)) throw invalidRequest(`${name} must be a UUID`)
  return value
}

export function assertInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidRequest(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return value
}

export function assertRfc3339(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw invalidRequest(`${name} must be an RFC3339 timestamp`)
  }
  return value
}

export function normalizeWorkInput(value: unknown): WorkInput {
  const input = assertObject(value, 'input')
  assertKeys(input, [
    'prompt',
    'cwd',
    'model',
    'permission_mode',
    'session_id',
  ])
  if (typeof input.prompt !== 'string') {
    throw invalidRequest('input.prompt must be a string')
  }
  if (Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new OpenRunnerError(
      'INVALID_REQUEST',
      'input.prompt exceeds 256 KiB',
      413,
    )
  }
  const cwd = validateRelativeCwd(input.cwd ?? '.')
  if (input.model !== undefined && typeof input.model !== 'string') {
    throw invalidRequest('input.model must be a string')
  }
  if (typeof input.model === 'string' && input.model.length > 1024) {
    throw invalidRequest('input.model is too long')
  }
  const mode = input.permission_mode ?? 'default'
  if (!PERMISSION_MODES.includes(mode as PermissionMode)) {
    throw invalidRequest('Unsupported input.permission_mode')
  }
  const sessionId =
    input.session_id === undefined
      ? undefined
      : assertUuid(input.session_id, 'input.session_id')
  return {
    prompt: input.prompt,
    cwd,
    ...(input.model !== undefined ? { model: input.model } : {}),
    permission_mode: mode as PermissionMode,
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  }
}

export function validateRelativeCwd(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw invalidRequest('input.cwd must be a non-empty relative path')
  }
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    value.split('/').some(part => part === '..')
  ) {
    throw invalidRequest('input.cwd must stay within the workspace')
  }
  const normalized = value.replace(/^\.\//, '').replace(/\/$/, '') || '.'
  return normalized
}

export async function resolveWorkspaceCwd(
  workspace: string,
  relative: string,
): Promise<string> {
  const safeRelative = validateRelativeCwd(relative)
  const root = await canonicalDirectory(workspace)
  const candidate = resolve(root, safeRelative)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw invalidRequest('Work cwd escapes the workspace')
  }
  const canonical = await canonicalDirectory(candidate)
  if (canonical !== root && !canonical.startsWith(root + sep)) {
    throw invalidRequest('Work cwd escapes the workspace through a symlink')
  }
  return canonical
}

async function canonicalDirectory(path: string): Promise<string> {
  const { realpath, stat } = await import('fs/promises')
  let canonical: string
  try {
    canonical = await realpath(path)
    if (!(await stat(canonical)).isDirectory()) throw new Error('not directory')
  } catch {
    throw invalidRequest('Workspace or work cwd is not an accessible directory')
  }
  return canonical
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`
  }
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function newId(): string {
  return randomUUID()
}

export function eventIdForMessage(message: unknown): string {
  if (isObject(message) && isUuid(message.uuid)) return message.uuid
  return newId()
}

export function isTerminalState(state: WorkState): state is TerminalWorkState {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export function publicWork(record: WorkRecord): WorkRecord {
  const { protocol: _protocol, ...work } = record
  return structuredClone(work)
}

export function errorResponse(error: unknown, requestId = newId()): {
  protocol: typeof OPEN_RUNNER_PROTOCOL
  error: {
    code: string
    message: string
    retryable: boolean
    details: Record<string, unknown>
  }
  request_id: string
} {
  const openError =
    error instanceof OpenRunnerError
      ? error
      : new OpenRunnerError('INTERNAL_ERROR', 'Internal server error', 500, true)
  return {
    protocol: OPEN_RUNNER_PROTOCOL,
    error: {
      code: openError.code,
      message: openError.message,
      retryable: openError.retryable,
      details: openError.details,
    },
    request_id: requestId,
  }
}

/** Read an owner-only, one-line token without ever including it in errors. */
export async function readTokenFile(path: string): Promise<string> {
  let info
  try {
    info = await lstat(path)
  } catch {
    throw new OpenRunnerError(
      'INVALID_REQUEST',
      'Token file is missing or inaccessible',
      400,
    )
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new OpenRunnerError(
      'INVALID_REQUEST',
      'Token file must be a regular, non-symlink file',
      400,
    )
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new OpenRunnerError(
      'INVALID_REQUEST',
      'Token file permissions must be exactly 0600',
      400,
    )
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new OpenRunnerError(
      'INVALID_REQUEST',
      'Token file must be owned by the current user',
      400,
    )
  }
  const text = await readFile(path, 'utf8')
  if (!/^[^\r\n]{32,1024}\r?\n?$/.test(text)) {
    throw new OpenRunnerError(
      'INVALID_REQUEST',
      'Token file must contain one high-entropy token line (32-1024 characters)',
      400,
    )
  }
  const token = text.replace(/\r?\n$/, '')
  if (/\s/.test(token) || token.length < 32) {
    throw new OpenRunnerError(
      'INVALID_REQUEST',
      'Token file contains an invalid token',
      400,
    )
  }
  return token
}
