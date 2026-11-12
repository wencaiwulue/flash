import { randomUUID } from 'crypto'
import { lstat, readFile, realpath } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import { getRegisteredHooks, registerHookCallbacks } from '../bootstrap/state.js'
import { hasBinaryExtension, isBinaryContent } from '../constants/files.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FileEditTool } from '../tools/FileEditTool/FileEditTool.js'
import { inputSchema as editInputSchema } from '../tools/FileEditTool/types.js'
import { FileWriteTool } from '../tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import type { HookInput, HookJSONOutput } from '../entrypoints/agentSdkTypes.js'
import type { HookCallback, HookCallbackContext } from '../types/hooks.js'
import {
  computeContentHash,
  expandFilePath,
  getAttributionRepoRoot,
  getFileMtime,
  normalizeFilePath,
  stateToSnapshotMessage,
  trackBulkFileChanges,
  trackFileModification,
  type AttributionState,
} from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { isGeneratedFile } from './generatedFiles.js'
import { gitExe } from './git.js'
import { persistAttributionStateForGit } from './postCommitAttribution.js'
import { recordAttributionSnapshot } from './sessionStorage.js'

const MAX_CANDIDATE_FILES = 200
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_CACHE_FILES = 500
const MAX_PENDING_BASH = 32
const CACHE_TTL_MS = 15 * 60 * 1000
const PENDING_TTL_MS = 5 * 60 * 1000

type CacheEntry = {
  content: string
  hash: string
  mtime: number
  size: number
  lastUsed: number
}

type PendingBash = {
  repoRoot: string
  createdAt: number
  before: Map<string, CacheEntry | null>
  incomplete: Set<string>
}

const fileContentCache = new Map<string, CacheEntry>()
const pendingBash = new Map<string, PendingBash>()
const lastHeadByRepo = new Map<string, string>()
let sweepTimer: ReturnType<typeof setInterval> | undefined
let persistence = Promise.resolve()

function cacheKey(repoRoot: string, path: string): string {
  return `${resolve(repoRoot)}\0${path}`
}

function trimCache(): void {
  let totalBytes = 0
  for (const entry of fileContentCache.values()) totalBytes += entry.size
  while (
    fileContentCache.size > MAX_CACHE_FILES ||
    totalBytes > MAX_TOTAL_BYTES
  ) {
    const oldest = fileContentCache.keys().next().value
    if (oldest === undefined) break
    totalBytes -= fileContentCache.get(oldest)?.size ?? 0
    fileContentCache.delete(oldest)
  }
}

function setCache(repoRoot: string, path: string, entry: CacheEntry): void {
  const key = cacheKey(repoRoot, path)
  fileContentCache.delete(key)
  fileContentCache.set(key, entry)
  trimCache()
}

export function sweepFileContentCache(): void {
  const now = Date.now()
  for (const [key, entry] of fileContentCache) {
    if (now - entry.lastUsed > CACHE_TTL_MS) fileContentCache.delete(key)
  }
  for (const [id, pending] of pendingBash) {
    if (now - pending.createdAt > PENDING_TTL_MS) pendingBash.delete(id)
  }
  trimCache()
}

export function clearAttributionCaches(): void {
  fileContentCache.clear()
  pendingBash.clear()
  lastHeadByRepo.clear()
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = undefined
}

function queuePersistence(state: AttributionState): void {
  const snapshot = stateToSnapshotMessage(state, randomUUID())
  persistence = persistence.catch(() => {}).then(async () => {
    await Promise.all([
      recordAttributionSnapshot(snapshot),
      persistAttributionStateForGit(snapshot),
    ])
  })
  void persistence.catch(error => {
    logForDebugging(`Attribution: failed to persist state: ${error}`)
  })
}

/** Wait for queued transcript/Git-state writes (used by graceful tests/shutdown). */
export function flushAttributionPersistence(): Promise<void> {
  return persistence
}

function updateAndPersist(
  context: HookCallbackContext,
  updater: (state: AttributionState) => AttributionState,
): void {
  let updated: AttributionState | undefined
  let changed = false
  context.updateAttributionState(previous => {
    updated = updater(previous)
    changed = updated !== previous
    return updated
  })
  if (changed && updated) queuePersistence(updated)
}

function normalizeRepoPath(repoRoot: string, path: string): string | null {
  const normalized = normalizeFilePath(path)
  if (
    !normalized ||
    isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.split('/').includes('.git') ||
    isGeneratedFile(normalized)
  ) {
    return null
  }
  const absolute = resolve(repoRoot, normalized)
  if (!absolute.startsWith(resolve(repoRoot) + sep)) return null
  return normalized
}

async function readCandidate(
  repoRoot: string,
  path: string,
): Promise<CacheEntry | null | 'incomplete'> {
  const normalized = normalizeRepoPath(repoRoot, path)
  if (!normalized) return 'incomplete'
  const absolute = resolve(repoRoot, normalized)
  try {
    const stats = await lstat(absolute)
    if (!stats.isFile() || stats.isSymbolicLink()) return 'incomplete'
    if (stats.size > MAX_FILE_BYTES || hasBinaryExtension(normalized)) {
      return 'incomplete'
    }
    const [realRoot, realFile] = await Promise.all([
      realpath(repoRoot),
      realpath(absolute),
    ])
    const realRelative = relative(realRoot, realFile)
    if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
      return 'incomplete'
    }
    const buffer = await readFile(absolute)
    if (isBinaryContent(buffer)) return 'incomplete'
    const content = buffer.toString('utf8')
    const entry: CacheEntry = {
      content,
      hash: computeContentHash(content),
      mtime: stats.mtimeMs,
      size: stats.size,
      lastUsed: Date.now(),
    }
    setCache(repoRoot, normalized, entry)
    return entry
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return 'incomplete'
  }
}

async function candidatePaths(
  context: HookCallbackContext,
  repoRoot: string,
): Promise<string[]> {
  const paths = new Set<string>()
  const attribution = context.getAppState().attribution
  for (const path of attribution.fileStates.keys()) paths.add(path)
  for (const path of attribution.sessionBaselines.keys()) paths.add(path)
  const [modified, untracked] = await Promise.all([
    execFileNoThrowWithCwd(gitExe(), ['diff', '--name-only'], {
      cwd: repoRoot,
      timeout: 5000,
    }),
    execFileNoThrowWithCwd(
      gitExe(),
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: repoRoot, timeout: 5000 },
    ),
  ])
  if (modified.code === 0) {
    for (const path of modified.stdout.split('\n')) if (path) paths.add(path)
  }
  if (untracked.code === 0) {
    for (const path of untracked.stdout.split('\n')) if (path) paths.add(path)
  }
  return Array.from(paths)
    .map(path => normalizeRepoPath(repoRoot, path))
    .filter((path): path is string => path !== null)
    .slice(0, MAX_CANDIDATE_FILES)
}

function addBaselines(
  state: AttributionState,
  before: ReadonlyMap<string, CacheEntry | null>,
): AttributionState {
  let changed = false
  const sessionBaselines = new Map(state.sessionBaselines)
  for (const [path, entry] of before) {
    if (entry && !sessionBaselines.has(path)) {
      sessionBaselines.set(path, {
        contentHash: entry.hash,
        mtime: entry.mtime,
      })
      changed = true
    }
  }
  return changed ? { ...state, sessionBaselines } : state
}

async function reconcileCommitBaseline(
  context?: HookCallbackContext,
): Promise<void> {
  if (!context) return
  const repoRoot = getAttributionRepoRoot()
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-parse', '--verify', 'HEAD'],
    { cwd: repoRoot, timeout: 2000 },
  )
  const head = result.stdout.trim()
  if (result.code !== 0 || !head) return
  const previousHead = lastHeadByRepo.get(repoRoot)
  if (previousHead === head) return
  lastHeadByRepo.set(repoRoot, head)
  const attribution = context.getAppState().attribution
  if (previousHead === undefined) {
    if (attribution.startingHeadSha === null) {
      updateAndPersist(context, state =>
        state.startingHeadSha === null
          ? { ...state, startingHeadSha: head }
          : state,
      )
    }
    return
  }
  // A changed HEAD is the commit-success reconciliation point. The prepare
  // hook never advances these counters, so a failed commit cannot do so.
  updateAndPersist(context, state => ({
    ...state,
    startingHeadSha: head,
    promptCountAtLastCommit: state.promptCount,
    permissionPromptCountAtLastCommit: state.permissionPromptCount,
    escapeCountAtLastCommit: state.escapeCount,
  }))
}

async function preBash(
  input: HookInput,
  toolUseID: string | null,
  context?: HookCallbackContext,
): Promise<void> {
  if (input.hook_event_name !== 'PreToolUse' || !toolUseID || !context) return
  const repoRoot = getAttributionRepoRoot()
  const pending: PendingBash = {
    repoRoot,
    createdAt: Date.now(),
    before: new Map(),
    incomplete: new Set(),
  }
  pendingBash.delete(toolUseID)
  if (pendingBash.size >= MAX_PENDING_BASH) {
    logForDebugging('Attribution: pending Bash capacity reached; skipping snapshot')
    return
  }
  pendingBash.set(toolUseID, pending)
  let totalBytes = 0
  for (const path of await candidatePaths(context, repoRoot)) {
    const entry = await readCandidate(repoRoot, path)
    if (entry === 'incomplete') {
      pending.incomplete.add(path)
      continue
    }
    if (entry && totalBytes + entry.size > MAX_TOTAL_BYTES) {
      pending.incomplete.add(path)
      continue
    }
    if (entry) totalBytes += entry.size
    pending.before.set(path, entry)
  }
  updateAndPersist(context, state => addBaselines(state, pending.before))
}

async function postBash(
  input: HookInput,
  toolUseID: string | null,
  context?: HookCallbackContext,
): Promise<void> {
  if (input.hook_event_name !== 'PostToolUse' || !toolUseID || !context) return
  const pending = pendingBash.get(toolUseID)
  pendingBash.delete(toolUseID)
  if (!pending || pending.repoRoot !== getAttributionRepoRoot()) return

  const afterPaths = new Set(pending.before.keys())
  for (const path of await candidatePaths(context, pending.repoRoot)) {
    afterPaths.add(path)
  }
  const changes: Array<{
    path: string
    type: 'modified' | 'created' | 'deleted'
    oldContent: string
    newContent: string
    mtime: number
  }> = []
  let totalNewBytes = 0
  for (const path of afterPaths) {
    if (pending.incomplete.has(path)) continue
    const hadBefore = pending.before.has(path)
    const before = pending.before.get(path) ?? null
    if (!hadBefore) {
      const tracked = await execFileNoThrowWithCwd(
        gitExe(),
        ['ls-files', '--error-unmatch', '--', path],
        { cwd: pending.repoRoot, timeout: 2000 },
      )
      if (tracked.code === 0) continue
    }
    const after = await readCandidate(pending.repoRoot, path)
    if (after === 'incomplete') continue
    if (after && totalNewBytes + after.size > MAX_TOTAL_BYTES) continue
    if (after) totalNewBytes += after.size
    if (before?.hash === after?.hash) continue
    const type = before ? (after ? 'modified' : 'deleted') : after ? 'created' : null
    if (!type) continue
    changes.push({
      path,
      type,
      oldContent: before?.content ?? '',
      newContent: after?.content ?? '',
      mtime: after?.mtime ?? Date.now(),
    })
  }
  if (changes.length === 0) return
  updateAndPersist(context, state => {
    const withBaselines = addBaselines(state, pending.before)
    return trackBulkFileChanges(withBaselines, changes)
  })
}

async function postFileTool(
  input: HookInput,
  context?: HookCallbackContext,
): Promise<void> {
  if (input.hook_event_name !== 'PostToolUse' || !context) return
  const repoRoot = getAttributionRepoRoot()
  let filePath: string
  let originalFile: string
  let userModified = false
  let newContent: string
  if (input.tool_name === FILE_EDIT_TOOL_NAME) {
    const parsedInput = editInputSchema().safeParse(input.tool_input)
    const parsedOutput = FileEditTool.outputSchema.safeParse(input.tool_response)
    if (!parsedInput.success || !parsedOutput.success) return
    filePath = parsedOutput.data.filePath
    originalFile = parsedOutput.data.originalFile
    userModified = parsedOutput.data.userModified
    try {
      newContent = await readFile(expandFilePath(filePath), 'utf8')
    } catch {
      return
    }
  } else if (input.tool_name === FILE_WRITE_TOOL_NAME) {
    const parsedInput = FileWriteTool.inputSchema.safeParse(input.tool_input)
    const parsedOutput = FileWriteTool.outputSchema.safeParse(input.tool_response)
    if (!parsedInput.success || !parsedOutput.success) return
    filePath = parsedOutput.data.filePath
    originalFile = parsedOutput.data.originalFile ?? ''
    newContent = parsedOutput.data.content
  } else {
    return
  }
  const normalized = normalizeRepoPath(repoRoot, filePath)
  if (!normalized) return
  const mtime = await getFileMtime(filePath)
  const before: CacheEntry = {
    content: originalFile,
    hash: computeContentHash(originalFile),
    mtime,
    size: Buffer.byteLength(originalFile),
    lastUsed: Date.now(),
  }
  const after: CacheEntry = {
    content: newContent,
    hash: computeContentHash(newContent),
    mtime,
    size: Buffer.byteLength(newContent),
    lastUsed: Date.now(),
  }
  setCache(repoRoot, normalized, after)
  updateAndPersist(context, state => {
    const withBaseline = addBaselines(state, new Map([[normalized, before]]))
    return trackFileModification(
      withBaseline,
      normalized,
      originalFile,
      newContent,
      userModified,
      mtime,
    )
  })
}

const attributionHook: HookCallback = {
  type: 'callback',
  internal: true,
  timeout: 15,
  callback: async (input, toolUseID, _signal, _index, context) => {
    try {
      sweepFileContentCache()
      if (!('tool_name' in input)) return {}
      await reconcileCommitBaseline(context)
      if (input.tool_name === BASH_TOOL_NAME) {
        if (input.hook_event_name === 'PreToolUse') {
          await preBash(input, toolUseID, context)
        } else if (input.hook_event_name === 'PostToolUse') {
          await postBash(input, toolUseID, context)
        }
      } else {
        await postFileTool(input, context)
      }
    } catch (error) {
      logForDebugging(`Attribution hook skipped an update: ${error}`)
    }
    return {} as HookJSONOutput
  },
}

const cleanupBashHook: HookCallback = {
  type: 'callback',
  internal: true,
  timeout: 1,
  callback: async (_input, toolUseID) => {
    if (toolUseID) pendingBash.delete(toolUseID)
    return {}
  },
}

function isRegistered(hook: HookCallback): boolean {
  const registered = getRegisteredHooks()
  if (!registered) return false
  return Object.values(registered).some(matchers =>
    matchers?.some(matcher =>
      matcher.hooks.some(candidate => candidate === hook),
    ),
  )
}

export function registerAttributionHooks(): void {
  if (isRegistered(attributionHook)) return
  clearAttributionCaches()
  registerHookCallbacks({
    PreToolUse: [{ matcher: BASH_TOOL_NAME, hooks: [attributionHook] }],
    PostToolUse: [
      { matcher: FILE_EDIT_TOOL_NAME, hooks: [attributionHook] },
      { matcher: FILE_WRITE_TOOL_NAME, hooks: [attributionHook] },
      { matcher: BASH_TOOL_NAME, hooks: [attributionHook] },
    ],
    PostToolUseFailure: [{ matcher: BASH_TOOL_NAME, hooks: [cleanupBashHook] }],
  })
  sweepTimer = setInterval(sweepFileContentCache, 60_000)
  sweepTimer.unref()
}
