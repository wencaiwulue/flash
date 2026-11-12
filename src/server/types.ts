import type { ChildProcess } from 'child_process'
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

export const connectResponseSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    ws_url: z.string(),
    work_dir: z.string().optional(),
    protocol: z.literal('direct-connect-v1').optional(),
    state: z
      .enum(['starting', 'running', 'detached', 'stopping', 'stopped'])
      .optional(),
    resumed: z.boolean().optional(),
    last_seq: z.number().int().nonnegative().optional(),
  }),
)

export type ServerConfig = {
  port: number
  host: string
  authToken: string
  unix?: string
  /** Idle timeout for detached sessions (ms). 0 = never expire. */
  idleTimeoutMs?: number
  /** Maximum number of concurrent sessions. */
  maxSessions?: number
  /** Default workspace directory for sessions that don't specify cwd. */
  workspace?: string
  /** Explicit server-side opt-in for permission bypass. */
  allowDangerousSkipPermissions?: boolean
}

export type SessionState =
  | 'starting'
  | 'running'
  | 'detached'
  | 'stopping'
  | 'stopped'

export type SessionInfo = {
  id: string
  status: SessionState
  createdAt: number
  workDir: string
  process: ChildProcess | null
  sessionKey?: string
  lastActiveAt: number
  lastSeq: number
  transcriptSessionId: string
  permissionMode?: string
  exit?: SessionExit
}

/**
 * Stable session key → session metadata. Persisted to ~/.claude/server-sessions.json
 * so sessions can be resumed across server restarts.
 */
export type SessionExit = {
  code: number | null
  signal: string | null
  reason?: string
  endedAt: number
}

export type SessionIndexEntry = {
  /** Server-assigned session ID (matches the subprocess's claude session). */
  sessionId: string
  /** The claude transcript session ID for --resume. Same as sessionId for direct sessions. */
  transcriptSessionId: string
  cwd: string
  permissionMode?: string
  createdAt: number
  lastActiveAt: number
  processStartToken?: string
  state: SessionState
  lastSeq: number
  exit?: SessionExit | null
  replayResetBeforeSeq?: number
  ownerId?: string
}

export type SessionIndex = Record<string, SessionIndexEntry>
