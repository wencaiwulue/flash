import { createHash } from 'crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { getSessionId, setCwdState, setOriginalCwd } from '../bootstrap/state.js'
import type { AttributionSnapshotMessage } from '../types/logs.js'
import {
  calculateCommitAttribution,
  createEmptyAttributionState,
  getAttributionRepoRoot,
  getStagedFiles,
  isGitTransientState,
  restoreAttributionStateFromSnapshots,
} from './commitAttribution.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'
import { lock } from './lockfile.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

const MANAGED_MARKER = '# Claude Code managed prepare-commit-msg dispatcher v1'
const USER_HOOK_SUFFIX = '.claude-user'
const INTERNAL_FLAG = '--internal-prepare-commit-msg-attribution'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function atomicWrite(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function resolveHooksDirectory(
  worktreePath: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return resolve(worktreePath, explicit)
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-parse', '--git-path', 'hooks'],
    { cwd: worktreePath, timeout: 5000 },
  )
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error('Unable to resolve the Git hooks directory')
  }
  return resolve(worktreePath, result.stdout.trim())
}

async function resolveGitDirectory(worktreePath: string): Promise<string> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-parse', '--absolute-git-dir'],
    { cwd: worktreePath, timeout: 5000 },
  )
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error('Commit attribution requires a Git worktree')
  }
  return result.stdout.trim()
}

function dispatcher(worktreePath: string): string {
  const executable = process.execPath
  const cliPath = resolve(process.argv[1]!)
  return `#!/bin/sh
${MANAGED_MARKER}
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
user_hook="$hook_dir/prepare-commit-msg${USER_HOOK_SUFFIX}"
if [ -f "$user_hook" ] || [ -L "$user_hook" ]; then
  if [ -x "$user_hook" ]; then
    "$user_hook" "$@"
    status=$?
  else
    /bin/sh "$user_hook" "$@"
    status=$?
  fi
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
fi
${shellQuote(executable)} ${shellQuote(cliPath)} ${INTERNAL_FLAG} ${shellQuote(resolve(worktreePath))} "$1"
status=$?
if [ "$status" -ne 0 ]; then
  printf '%s\n' 'Claude Code attribution was unavailable; continuing commit.' >&2
fi
exit 0
`
}

/**
 * Install an idempotent dispatcher without overwriting a user's existing hook.
 * The optional explicit directory is required by worktree/husky callers.
 */
export async function installPrepareCommitMsgHook(
  worktreePath: string,
  hooksDirectory?: string,
): Promise<void> {
  const worktree = resolve(worktreePath)
  const hooks = await resolveHooksDirectory(worktree, hooksDirectory)
  await mkdir(hooks, { recursive: true })
  const release = await lock(hooks, {
    realpath: false,
    retries: { retries: 20, factor: 1.2, minTimeout: 20, maxTimeout: 250 },
  })
  const hookPath = join(hooks, 'prepare-commit-msg')
  const userPath = join(hooks, `prepare-commit-msg${USER_HOOK_SUFFIX}`)
  try {
    let existing: string | null = null
    try {
      existing = await readFile(hookPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const managed = existing?.includes(MANAGED_MARKER) ?? false
    let movedUserHook = false
    if (existing !== null && !managed) {
      try {
        await lstat(userPath)
        throw new Error(
          'Cannot preserve prepare-commit-msg: prepare-commit-msg.claude-user already exists',
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(hookPath, userPath)
      movedUserHook = true
    }
    try {
      await atomicWrite(hookPath, dispatcher(worktree), 0o755)
      await chmod(hookPath, 0o755)
    } catch (error) {
      if (movedUserHook) await rename(userPath, hookPath).catch(() => {})
      throw error
    }
  } finally {
    await release()
  }
}

/** Remove only our dispatcher and restore the preserved user hook, if any. */
export async function uninstallPrepareCommitMsgHook(
  worktreePath: string,
  hooksDirectory?: string,
): Promise<void> {
  const worktree = resolve(worktreePath)
  const hooks = await resolveHooksDirectory(worktree, hooksDirectory)
  const release = await lock(hooks, { realpath: false })
  const hookPath = join(hooks, 'prepare-commit-msg')
  const userPath = join(hooks, `prepare-commit-msg${USER_HOOK_SUFFIX}`)
  try {
    const content = await readFile(hookPath, 'utf8')
    if (!content.includes(MANAGED_MARKER)) {
      throw new Error('Refusing to remove an unmanaged prepare-commit-msg hook')
    }
    try {
      await lstat(userPath)
      // rename atomically replaces only the dispatcher we just verified.
      await rename(userPath, hookPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await unlink(hookPath)
    }
  } finally {
    await release()
  }
}

function stateFileName(): string {
  return `${createHash('sha256').update(getSessionId()).digest('hex')}.json`
}

/** Persist only hashes/counts needed by the independent Git-hook fast-path. */
export async function persistAttributionStateForGit(
  snapshot: AttributionSnapshotMessage,
): Promise<void> {
  const cwd = getAttributionRepoRoot()
  const gitDir = await resolveGitDirectory(cwd)
  const stateDir = join(gitDir, 'claude-code', 'attribution')
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  await atomicWrite(
    join(stateDir, stateFileName()),
    jsonStringify(snapshot),
    0o600,
  )
}

async function readAttributionStates(gitDir: string) {
  const stateDir = join(gitDir, 'claude-code', 'attribution')
  let names: string[]
  try {
    names = await readdir(stateDir)
  } catch {
    return []
  }
  const states = []
  for (const name of names.sort().slice(0, 64)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try {
      const stats = await stat(join(stateDir, name))
      if (!stats.isFile() || stats.size > 8 * 1024 * 1024) continue
      const snapshot = jsonParse(
        await readFile(join(stateDir, name), 'utf8'),
      ) as AttributionSnapshotMessage
      if (snapshot.type !== 'attribution-snapshot') continue
      states.push(restoreAttributionStateFromSnapshots([snapshot]))
    } catch {
      // A damaged state file disables only that session's estimate.
    }
  }
  return states
}

/**
 * Independent prepare-commit-msg helper. It loads no project hooks, starts no
 * model request, and never recursively installs Git hooks.
 */
export async function runPrepareCommitMsgAttribution(
  worktreePath: string,
  messagePath: string,
): Promise<void> {
  const worktree = resolve(worktreePath)
  const resolvedMessagePath = resolve(worktree, messagePath)
  setOriginalCwd(worktree)
  setCwdState(worktree)
  const { getAttributionTexts } = await import('./attribution.js')
  const attributionText = getAttributionTexts().commit
  if (!attributionText) return
  if (await isGitTransientState()) return
  const stagedFiles = await getStagedFiles()
  if (stagedFiles.length === 0) return
  const gitDir = await resolveGitDirectory(worktree)
  const states = await readAttributionStates(gitDir)
  if (states.length === 0) return
  const data = await calculateCommitAttribution(states, stagedFiles)
  const { buildPRTrailers } = await import('./attributionTrailer.js')
  const counters = states.reduce((combined, state) => {
    combined.promptCount += state.promptCount
    combined.promptCountAtLastCommit += state.promptCountAtLastCommit
    combined.permissionPromptCount += state.permissionPromptCount
    combined.permissionPromptCountAtLastCommit +=
      state.permissionPromptCountAtLastCommit
    combined.escapeCount += state.escapeCount
    combined.escapeCountAtLastCommit += state.escapeCountAtLastCommit
    return combined
  }, createEmptyAttributionState())
  const trailerLines = [
    ...attributionText.split('\n').filter(Boolean),
    ...buildPRTrailers(data, counters),
  ]
  if (trailerLines.length === 0) return

  const original = await readFile(resolvedMessagePath, 'utf8')
  const args = ['interpret-trailers', '--if-exists', 'replace', '--if-missing', 'add']
  for (const line of trailerLines) args.push('--trailer', line)
  // Git ignores a would-be trailer paragraph containing a plain user marker.
  // Remove only our four managed keys from that final paragraph, then let
  // interpret-trailers append/replace the canonical values. All user text and
  // unrelated trailers (including Co-Authored-By) remain byte-for-byte intact.
  const lines = original.split('\n')
  let lastNonEmpty = lines.length - 1
  while (lastNonEmpty >= 0 && lines[lastNonEmpty]!.trim() === '') {
    lastNonEmpty--
  }
  let finalParagraphStart = 0
  for (let index = lastNonEmpty; index >= 0; index--) {
    if (lines[index]!.trim() === '') {
      finalParagraphStart = index + 1
      break
    }
  }
  const managed = /^Claude-Code-(?:Contribution|Prompts|Permission-Prompts|Escapes):/
  const cleaned = lines
    .filter(
      (line, index) => index < finalParagraphStart || !managed.test(line),
    )
    .join('\n')
  const result = await execFileNoThrowWithCwd(gitExe(), args, {
    cwd: worktree,
    timeout: 5000,
    input: cleaned,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.code !== 0) throw new Error('git interpret-trailers failed')
  const mode = (await stat(resolvedMessagePath)).mode & 0o777
  await atomicWrite(resolvedMessagePath, result.stdout, mode)
}

export { INTERNAL_FLAG as PREPARE_COMMIT_MSG_ATTRIBUTION_FLAG }
