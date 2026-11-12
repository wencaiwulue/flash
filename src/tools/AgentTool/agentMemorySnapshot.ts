import { randomUUID } from 'crypto'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  lstat,
} from 'fs/promises'
import { basename, dirname, join, resolve, sep } from 'path'
import { z } from 'zod/v4'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { type AgentMemoryScope, getAgentMemoryDir } from './agentMemory.js'

const SNAPSHOT_BASE = 'agent-memory-snapshots'
const SNAPSHOT_JSON = 'snapshot.json'
const SYNCED_JSON = '.snapshot-synced.json'

const snapshotMetaSchema = lazySchema(() =>
  z.object({
    updatedAt: z.string().min(1),
  }),
)

const syncedMetaSchema = lazySchema(() =>
  z.object({
    syncedFrom: z.string().min(1),
  }),
)
type SyncedMeta = z.infer<ReturnType<typeof syncedMetaSchema>>
type SnapshotMeta = z.infer<ReturnType<typeof snapshotMetaSchema>>
type SnapshotMarkdown = { name: string; content: string }

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function isWithin(parent: string, candidate: string): boolean {
  const root = resolve(parent)
  const path = resolve(candidate)
  return path === root || path.startsWith(root + sep)
}

/** Return the real snapshot and target paths used by the dialog and merge tool. */
export function getSnapshotPaths(
  agentType: string,
  scope: AgentMemoryScope,
): { snapshotDir: string; targetDir: string } {
  return {
    snapshotDir: getSnapshotDirForAgent(agentType),
    targetDir: getAgentMemoryDir(agentType, scope),
  }
}

/**
 * Returns the path to the snapshot directory for an agent in the current project.
 * e.g., <cwd>/.claude/agent-memory-snapshots/<agentType>/
 */
export function getSnapshotDirForAgent(agentType: string): string {
  return join(getCwd(), '.claude', SNAPSHOT_BASE, agentType)
}

function getSnapshotJsonPath(agentType: string): string {
  return join(getSnapshotDirForAgent(agentType), SNAPSHOT_JSON)
}

function getSyncedJsonPath(agentType: string, scope: AgentMemoryScope): string {
  return join(getAgentMemoryDir(agentType, scope), SYNCED_JSON)
}

async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const content = await readFile(path, { encoding: 'utf-8' })
    const result = schema.safeParse(jsonParse(content))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

async function readSnapshotMeta(agentType: string): Promise<SnapshotMeta> {
  const path = getSnapshotJsonPath(agentType)
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('snapshot.json must be a regular, non-symbolic-link file')
  }
  const parsed = snapshotMetaSchema().safeParse(
    jsonParse(await readFile(path, 'utf8')),
  )
  if (!parsed.success || parseTimestamp(parsed.data.updatedAt) === null) {
    throw new Error('snapshot.json has no valid ISO updatedAt timestamp')
  }
  return parsed.data
}

function assertSnapshotTimestamp(meta: SnapshotMeta, expected: string): void {
  if (meta.updatedAt !== expected) {
    throw new Error(
      'The snapshot changed while it was being applied. Re-check the update and try again.',
    )
  }
}

async function readSnapshotMarkdown(agentType: string): Promise<SnapshotMarkdown[]> {
  const snapshotDir = getSnapshotDirForAgent(agentType)
  const files = await readdir(snapshotDir, { withFileTypes: true })
  const markdown: SnapshotMarkdown[] = []
  for (const dirent of files) {
    if (!dirent.name.endsWith('.md')) continue
    if (dirent.isSymbolicLink()) {
      throw new Error(`Snapshot Markdown must not be a symbolic link: ${dirent.name}`)
    }
    if (!dirent.isFile()) continue
    const name = dirent.name
    const sourcePath = join(snapshotDir, name)
    if (basename(name) !== name || !isWithin(snapshotDir, sourcePath)) {
      throw new Error(`Unsafe snapshot filename: ${name}`)
    }
    // lstat closes the readdir race where a regular file is replaced by a link.
    const stats = await lstat(sourcePath)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Snapshot Markdown must be a regular file: ${name}`)
    }
    markdown.push({ name, content: await readFile(sourcePath, 'utf8') })
  }
  return markdown
}

async function writeRegularFile(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function copySnapshotToLocal(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<void> {
  const localMemDir = getAgentMemoryDir(agentType, scope)
  const markdown = await readSnapshotMarkdown(agentType)
  await mkdir(localMemDir, { recursive: true })
  const targetStats = await lstat(localMemDir)
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error('Agent memory target must be a real directory')
  }
  for (const file of markdown) {
    const targetPath = join(localMemDir, file.name)
    if (basename(file.name) !== file.name || !isWithin(localMemDir, targetPath)) {
      throw new Error(`Unsafe snapshot filename: ${file.name}`)
    }
    // Use a same-directory temporary file so an interrupted copy never leaves a
    // partial Markdown document that could later be mistaken for a synced one.
    const temporary = join(localMemDir, `.snapshot-${randomUUID()}.tmp`)
    try {
      await writeRegularFile(temporary, file.content)
      await rename(temporary, targetPath)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}

/** The single synced-metadata success path used by initialize/keep/replace/merge. */
export async function commitSyncedMeta(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  if (parseTimestamp(snapshotTimestamp) === null) {
    throw new Error('Cannot mark a snapshot with an invalid timestamp as synced')
  }
  const syncedPath = getSyncedJsonPath(agentType, scope)
  const localMemDir = getAgentMemoryDir(agentType, scope)
  await mkdir(localMemDir, { recursive: true })
  const meta: SyncedMeta = { syncedFrom: snapshotTimestamp }
  const temporary = join(localMemDir, `.snapshot-synced-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(jsonStringify(meta), 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, syncedPath)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * Check if a snapshot exists and whether it's newer than what we last synced.
 */
export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}> {
  const snapshotMeta = await readJsonFile(
    getSnapshotJsonPath(agentType),
    snapshotMetaSchema(),
  )
  const snapshotTime = snapshotMeta
    ? parseTimestamp(snapshotMeta.updatedAt)
    : null
  if (!snapshotMeta || snapshotTime === null) {
    return { action: 'none' }
  }

  const localMemDir = getAgentMemoryDir(agentType, scope)
  let hasLocalMemory = false
  try {
    const dirents = await readdir(localMemDir, { withFileTypes: true })
    hasLocalMemory = dirents.some(d => d.isFile() && d.name.endsWith('.md'))
  } catch {
    // Directory doesn't exist
  }
  if (!hasLocalMemory) {
    return { action: 'initialize', snapshotTimestamp: snapshotMeta.updatedAt }
  }

  const syncedMeta = await readJsonFile(
    getSyncedJsonPath(agentType, scope),
    syncedMetaSchema(),
  )
  const syncedTime = syncedMeta ? parseTimestamp(syncedMeta.syncedFrom) : null
  if (syncedTime === null || snapshotTime > syncedTime) {
    return {
      action: 'prompt-update',
      snapshotTimestamp: snapshotMeta.updatedAt,
    }
  }
  return { action: 'none' }
}

/** Initialize local agent memory from a snapshot (first-time setup). */
export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  logForDebugging(
    `Initializing agent memory for ${agentType} from project snapshot`,
  )
  assertSnapshotTimestamp(await readSnapshotMeta(agentType), snapshotTimestamp)
  await copySnapshotToLocal(agentType, scope)
  await commitSyncedMeta(agentType, scope, snapshotTimestamp)
}

async function listTargetMarkdown(targetDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(targetDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue
    const path = join(targetDir, entry.name)
    const stats = await lstat(path)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Target Markdown must be a regular file: ${entry.name}`)
    }
    if (basename(entry.name) !== entry.name || !isWithin(targetDir, path)) {
      throw new Error(`Unsafe target filename: ${entry.name}`)
    }
    names.push(entry.name)
  }
  return names
}

/**
 * Replace only the target Markdown set. Source files are completely staged
 * before target changes; any failure restores the previous Markdown files.
 */
export async function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  logForDebugging(
    `Replacing agent memory for ${agentType} with project snapshot`,
  )
  assertSnapshotTimestamp(await readSnapshotMeta(agentType), snapshotTimestamp)
  const markdown = await readSnapshotMarkdown(agentType)
  const targetDir = getAgentMemoryDir(agentType, scope)
  await mkdir(targetDir, { recursive: true })
  const targetStats = await lstat(targetDir)
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error('Agent memory target must be a real directory')
  }
  const parent = dirname(resolve(targetDir))
  const oldNames = await listTargetMarkdown(targetDir)
  const staging = await mkdtemp(join(parent, '.snapshot-staging-'))
  const backup = await mkdtemp(join(parent, '.snapshot-backup-'))
  const movedOld: string[] = []
  const installedNew: string[] = []
  let synced = false
  let rollbackComplete = true
  try {
    for (const file of markdown) {
      await writeRegularFile(join(staging, file.name), file.content)
    }
    for (const name of oldNames) {
      await rename(join(targetDir, name), join(backup, name))
      movedOld.push(name)
    }
    for (const file of markdown) {
      await rename(join(staging, file.name), join(targetDir, file.name))
      installedNew.push(file.name)
    }
    await commitSyncedMeta(agentType, scope, snapshotTimestamp)
    synced = true
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const name of installedNew.reverse()) {
      await unlink(join(targetDir, name)).catch(rollbackError => {
        rollbackErrors.push(rollbackError)
      })
    }
    for (const name of movedOld.reverse()) {
      await rename(join(backup, name), join(targetDir, name)).catch(
        rollbackError => {
          rollbackErrors.push(rollbackError)
        },
      )
    }
    if (rollbackErrors.length > 0) {
      rollbackComplete = false
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Snapshot replacement failed and rollback was incomplete',
      )
    }
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    if (synced || rollbackComplete) {
      await rm(backup, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Mark the current snapshot as synced without changing local memory. */
export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  assertSnapshotTimestamp(await readSnapshotMeta(agentType), snapshotTimestamp)
  await commitSyncedMeta(agentType, scope, snapshotTimestamp)
}
