import { randomUUID, type UUID } from 'crypto'
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { Message } from '../types/message.js'
import type {
  GetSessionMessagesOptions,
  SessionMessage,
} from '../entrypoints/sdk/runtimeTypes.js'
import type {
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKCompactBoundaryMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from '../entrypoints/sdk/coreTypes.js'
import { recoverOrphanedParallelToolResults } from './sessionChainRecovery.js'
import { listSessionsImpl } from './listSessionsImpl.js'
import { parseSessionInfoFromLite } from './listSessionsImpl.js'
import {
  readSessionLite,
  resolveSessionFilePath,
  validateUuid,
} from './sessionStoragePortable.js'

type TranscriptEntry = {
  type: string
  uuid: UUID
  parentUuid?: UUID | null
  sessionId?: string
  timestamp?: string
  isSidechain?: boolean
  message?: unknown
  [key: string]: unknown
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    (entry.type === 'user' ||
      entry.type === 'assistant' ||
      entry.type === 'system') &&
    typeof entry.uuid === 'string'
  )
}

async function readTranscriptEntries(filePath: string): Promise<TranscriptEntry[]> {
  const content = await readFile(filePath, 'utf8')
  const entries: TranscriptEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isTranscriptEntry(parsed) && !parsed.isSidechain) {
        entries.push(parsed)
      }
    } catch {
      // Ignore a trailing partial write and metadata entries that do not match
      // the transcript shape. Other valid messages remain readable.
    }
  }
  return entries
}

async function readContentReplacementEntries(
  filePath: string,
): Promise<Record<string, unknown>[]> {
  const content = await readFile(filePath, 'utf8')
  const entries: Record<string, unknown>[] = []
  for (const line of content.split('\n')) {
    if (!line.includes('"content-replacement"')) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (
        parsed.type === 'content-replacement' &&
        Array.isArray(parsed.replacements)
      ) {
        entries.push(parsed)
      }
    } catch {
      // Ignore a trailing partial write.
    }
  }
  return entries
}

function buildMainChain(entries: TranscriptEntry[]): TranscriptEntry[] {
  const byUuid = new Map(entries.map(entry => [entry.uuid, entry]))
  const leaf = entries.at(-1)
  if (!leaf) return []

  const chain: TranscriptEntry[] = []
  const seen = new Set<UUID>()
  let current: TranscriptEntry | undefined = leaf
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid)
    chain.push(current)
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined
  }
  return recoverOrphanedParallelToolResults(byUuid, chain.reverse(), seen).chain
}

function sessionIdFor(entry: TranscriptEntry, fallback: string): string {
  return typeof entry.sessionId === 'string' ? entry.sessionId : fallback
}

function toSessionMessage(
  entry: TranscriptEntry,
  fallbackSessionId: string,
): SessionMessage | null {
  const sessionId = sessionIdFor(entry, fallbackSessionId)
  if (entry.type === 'assistant') {
    const message: SDKAssistantMessage = {
      type: 'assistant',
      message: entry.message as SDKAssistantMessage['message'],
      session_id: sessionId,
      parent_tool_use_id:
        typeof entry.parentToolUseId === 'string'
          ? entry.parentToolUseId
          : null,
      uuid: entry.uuid,
      ...(entry.error !== undefined && {
        error: entry.error as SDKAssistantMessageError,
      }),
    }
    return message
  }
  if (entry.type === 'user') {
    const message: SDKUserMessage = {
      type: 'user',
      message: entry.message as SDKUserMessage['message'],
      session_id: sessionId,
      parent_tool_use_id:
        typeof entry.parentToolUseId === 'string'
          ? entry.parentToolUseId
          : null,
      uuid: entry.uuid,
      ...(typeof entry.timestamp === 'string' && {
        timestamp: entry.timestamp,
      }),
      ...(entry.toolUseResult !== undefined && {
        tool_use_result: entry.toolUseResult,
      }),
      ...((entry.isMeta === true || entry.isVisibleInTranscriptOnly === true) && {
        isSynthetic: true,
      }),
    }
    return message
  }
  if (entry.subtype === 'compact_boundary' && entry.compactMetadata) {
    const message: SDKCompactBoundaryMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata:
        entry.compactMetadata as SDKCompactBoundaryMessage['compact_metadata'],
      session_id: sessionId,
      uuid: entry.uuid,
    }
    return message
  }
  return null
}

export async function listSdkSessions(options?: {
  dir?: string
  limit?: number
  offset?: number
  includeWorktrees?: boolean
}): Promise<SDKSessionInfo[]> {
  return listSessionsImpl(options)
}

export async function getSdkSessionInfo(
  sessionId: string,
  options?: { dir?: string },
): Promise<SDKSessionInfo | undefined> {
  const uuid = validateUuid(sessionId)
  if (!uuid) return undefined
  const resolved = await resolveSessionFilePath(uuid, options?.dir)
  if (!resolved) return undefined
  const lite = await readSessionLite(resolved.filePath)
  if (!lite) return undefined
  return (
    parseSessionInfoFromLite(uuid, lite, resolved.projectPath) ?? undefined
  )
}

export async function getSdkSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  const uuid = validateUuid(sessionId)
  if (!uuid) return []
  const resolved = await resolveSessionFilePath(uuid, options?.dir)
  if (!resolved) return []

  const entries = await readTranscriptEntries(resolved.filePath)
  const messages = buildMainChain(entries)
    .map(entry => toSessionMessage(entry, uuid))
    .filter((message): message is SessionMessage => message !== null)
    .filter(message => options?.includeSystemMessages || message.type !== 'system')

  const offset = options?.offset ?? 0
  const limit = options?.limit
  return limit !== undefined && limit > 0
    ? messages.slice(offset, offset + limit)
    : messages.slice(offset)
}

async function appendMetadata(
  filePath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export async function renameSdkSession(
  sessionId: string,
  title: string,
  options?: { dir?: string },
): Promise<void> {
  const uuid = validateUuid(sessionId)
  if (!uuid) throw new Error('Invalid session ID')
  if (!title.trim()) throw new Error('Session title must not be empty')
  const resolved = await resolveSessionFilePath(uuid, options?.dir)
  if (!resolved) throw new Error(`Session not found: ${sessionId}`)
  await appendMetadata(resolved.filePath, {
    type: 'custom-title',
    customTitle: title,
    sessionId: uuid,
  })
}

export async function tagSdkSession(
  sessionId: string,
  tag: string | null,
  options?: { dir?: string },
): Promise<void> {
  const uuid = validateUuid(sessionId)
  if (!uuid) throw new Error('Invalid session ID')
  const resolved = await resolveSessionFilePath(uuid, options?.dir)
  if (!resolved) throw new Error(`Session not found: ${sessionId}`)
  await appendMetadata(resolved.filePath, {
    type: 'tag',
    tag: tag ?? '',
    sessionId: uuid,
  })
}

export async function loadSdkSessionTranscript(
  sessionId: string,
  options?: { dir?: string },
): Promise<Message[]> {
  const uuid = validateUuid(sessionId)
  if (!uuid) throw new Error('Invalid session ID')
  const resolved = await resolveSessionFilePath(uuid, options?.dir)
  if (!resolved) throw new Error(`Session not found: ${sessionId}`)
  const entries = await readTranscriptEntries(resolved.filePath)
  return buildMainChain(entries).map(entry => entry as unknown as Message)
}

export async function forkSdkSession(
  sessionId: string,
  options?: {
    dir?: string
    upToMessageId?: string
    title?: string
  },
): Promise<{ sessionId: string }> {
  const sourceId = validateUuid(sessionId)
  if (!sourceId) throw new Error('Invalid session ID')
  const resolved = await resolveSessionFilePath(sourceId, options?.dir)
  if (!resolved) throw new Error(`Session not found: ${sessionId}`)

  const [entries, contentReplacements] = await Promise.all([
    readTranscriptEntries(resolved.filePath),
    readContentReplacementEntries(resolved.filePath),
  ])
  const cutoff = options?.upToMessageId
    ? entries.findIndex(entry => entry.uuid === options.upToMessageId)
    : entries.length - 1
  if (cutoff < 0) {
    throw new Error(`Message not found in session: ${options?.upToMessageId}`)
  }

  const forkId = randomUUID()
  const lines: string[] = []
  let parentUuid: UUID | null = null
  for (const entry of entries.slice(0, cutoff + 1)) {
    const uuid = randomUUID()
    lines.push(
      JSON.stringify({
        ...entry,
        sessionId: forkId,
        uuid,
        parentUuid,
        isSidechain: false,
        forkedFrom: { sessionId: sourceId, messageUuid: entry.uuid },
      }),
    )
    parentUuid = uuid
  }

  if (lines.length === 0) {
    throw new Error('Cannot fork an empty session')
  }
  for (const entry of contentReplacements) {
    lines.push(JSON.stringify({ ...entry, sessionId: forkId }))
  }
  if (options?.title) {
    lines.push(
      JSON.stringify({
        type: 'custom-title',
        customTitle: options.title,
        sessionId: forkId,
      }),
    )
  }

  const forkPath = join(dirname(resolved.filePath), `${forkId}.jsonl`)
  await mkdir(dirname(forkPath), { recursive: true, mode: 0o700 })
  await writeFile(forkPath, `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return { sessionId: forkId }
}
