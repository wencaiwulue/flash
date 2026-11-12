import { mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import type { LocalCommandCall } from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'
import { lock } from '../../utils/lockfile.js'
import {
  getProjectsDir,
  getSessionFilesWithMtime,
  loadAllLogsFromSessionFile,
} from '../../utils/sessionStorage.js'
import {
  deduplicateSessionBranches,
  getSessionMetaDir,
  hasValidDates,
  loadCachedSessionMeta,
  logToSessionMeta,
  saveSessionMeta,
  type SessionMeta,
} from '../insights/sessionMeta.js'

const USAGE = 'Usage: /backfill-sessions [--dry-run] [--force]'

type SessionFile = { path: string; mtime: number; ctime: number; size: number }

export type BackfillReport = {
  scanned: number
  valid: number
  rebuilt: number
  wouldRebuild: number
  duplicates: number
  failed: number
  dryRun: boolean
}

export type BackfillDependencies = {
  listSessions: () => Promise<Map<string, SessionFile>>
  loadCachedSessionMeta: (sessionId: string) => Promise<SessionMeta | null>
  loadAllLogsFromSessionFile: (path: string) => Promise<LogOption[]>
  saveSessionMeta: (meta: SessionMeta) => Promise<void>
  withLock: <T>(fn: () => Promise<T>) => Promise<T>
}

async function listSessions(): Promise<Map<string, SessionFile>> {
  const sessions = new Map<string, SessionFile>()
  let entries
  try {
    entries = await readdir(getProjectsDir(), { withFileTypes: true })
  } catch {
    return sessions
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const files = await getSessionFilesWithMtime(
      join(getProjectsDir(), entry.name),
    )
    for (const [id, file] of files) {
      const existing = sessions.get(id)
      if (!existing || file.mtime > existing.mtime) sessions.set(id, file)
    }
  }
  return sessions
}

async function withMetadataLock<T>(fn: () => Promise<T>): Promise<T> {
  // proper-lockfile also coordinates independent CLI processes.
  await mkdir(getSessionMetaDir(), { recursive: true, mode: 0o700 })
  const release = await lock(getSessionMetaDir(), {
    realpath: false,
    stale: 30_000,
    retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
  })
  try {
    return await fn()
  } finally {
    await release()
  }
}

const defaultDependencies: BackfillDependencies = {
  listSessions,
  loadCachedSessionMeta,
  loadAllLogsFromSessionFile,
  saveSessionMeta,
  withLock: withMetadataLock,
}

export async function backfillSessionMetadata(
  options: { dryRun: boolean; force: boolean },
  deps: BackfillDependencies = defaultDependencies,
): Promise<BackfillReport> {
  const execute = async (): Promise<BackfillReport> => {
    const sessions = await deps.listSessions()
    const report: BackfillReport = {
      scanned: sessions.size,
      valid: 0,
      rebuilt: 0,
      wouldRebuild: 0,
      duplicates: 0,
      failed: 0,
      dryRun: options.dryRun,
    }

    for (const [sessionId, file] of [...sessions].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      try {
        const cached = await deps.loadCachedSessionMeta(sessionId)
        if (cached && !options.force) {
          report.valid++
          continue
        }
        const logs = await deps.loadAllLogsFromSessionFile(file.path)
        const entries = logs
          .filter(hasValidDates)
          .map(log => ({ log, meta: logToSessionMeta(log) }))
        const deduplicated = deduplicateSessionBranches(entries)
        report.duplicates += Math.max(0, entries.length - deduplicated.length)
        const best = deduplicated[0]
        if (!best || best.meta.session_id !== sessionId) {
          report.failed++
          continue
        }
        if (options.dryRun) {
          report.wouldRebuild++
        } else {
          await deps.saveSessionMeta(best.meta)
          report.rebuilt++
        }
      } catch {
        // One malformed/unreadable transcript must not block other sessions.
        report.failed++
      }
    }
    return report
  }

  return options.dryRun ? execute() : deps.withLock(execute)
}

export async function runBackfillSessions(
  args: string,
  deps: BackfillDependencies = defaultDependencies,
): Promise<string> {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (
    tokens.some(token => token !== '--dry-run' && token !== '--force') ||
    new Set(tokens).size !== tokens.length
  ) {
    return USAGE
  }
  const options = {
    dryRun: tokens.includes('--dry-run'),
    force: tokens.includes('--force'),
  }
  const report = await backfillSessionMetadata(options, deps)
  const lines = [
    `Sessions scanned: ${report.scanned}`,
    `Valid metadata preserved: ${report.valid}`,
    report.dryRun
      ? `Metadata requiring rebuild: ${report.wouldRebuild}`
      : `Metadata rebuilt: ${report.rebuilt}`,
    `Duplicate branches skipped: ${report.duplicates}`,
    `Sessions failed: ${report.failed}`,
    report.dryRun
      ? 'Dry run: no files were written.'
      : 'Local metadata writes completed with locking and atomic 0600 files.',
    'No transcripts were uploaded, no model was called, and provider usage was not recalculated.',
  ]
  return lines.join('\n')
}

export const call: LocalCommandCall = async args => ({
  type: 'text',
  value: await runBackfillSessions(args),
})
