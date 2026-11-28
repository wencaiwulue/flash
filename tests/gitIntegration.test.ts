import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFile } from 'child_process'
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import {
  resetStateForTests,
  setCwdState,
} from '../src/bootstrap/state.ts'
import {
  clearResolveGitDirCache,
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  getCommonDir,
  getHeadForDir,
  getRemoteUrlForDir,
  getWorktreeCountFromFs,
  isSafeRefName,
  isShallowClone,
  isValidGitSha,
  readGitHead,
  readWorktreeHeadSha,
  resetGitFileWatcher,
  resolveGitDir,
  resolveRef,
} from '../src/utils/git/gitFilesystem.ts'

const execFileAsync = promisify(execFile)
let tempDir: string
let originalCwd: string
let originalHome: string | undefined
let originalGitNoSystem: string | undefined
let originalGitPrompt: string | undefined

beforeEach(async () => {
  originalCwd = process.cwd()
  originalHome = process.env.HOME
  originalGitNoSystem = process.env.GIT_CONFIG_NOSYSTEM
  originalGitPrompt = process.env.GIT_TERMINAL_PROMPT
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'flash-git-integration-')))
  process.env.HOME = tempDir
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_TERMINAL_PROMPT = '0'
  resetStateForTests()
  resetGitFileWatcher()
  clearResolveGitDirCache()
})

afterEach(async () => {
  resetGitFileWatcher()
  clearResolveGitDirCache()
  resetStateForTests()
  process.chdir(originalCwd)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalGitNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = originalGitNoSystem
  if (originalGitPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT
  else process.env.GIT_TERMINAL_PROMPT = originalGitPrompt
  await rm(tempDir, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function initRepo(): Promise<{ repo: string; sha: string }> {
  const repo = join(tempDir, 'repo')
  await git(tempDir, 'init', '-b', 'main', repo)
  await git(repo, 'config', 'user.name', 'Offline Test')
  await git(repo, 'config', 'user.email', 'offline@example.invalid')
  await writeFile(join(repo, 'README.md'), 'initial\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-m', 'initial')
  const sha = await git(repo, 'rev-parse', 'HEAD')
  await git(repo, 'remote', 'add', 'origin', 'https://example.invalid/initial.git')
  return { repo, sha }
}

async function commitFile(repo: string, name: string, content: string): Promise<string> {
  await writeFile(join(repo, name), content)
  await git(repo, 'add', name)
  await git(repo, 'commit', '-m', `update ${name}`)
  return git(repo, 'rev-parse', 'HEAD')
}

async function waitForValue<T>(read: () => Promise<T>, expected: T): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (Object.is(await read(), expected)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(await read()).toEqual(expected)
}

describe('git filesystem direct metadata', () => {
  test('reads loose and packed refs, detached HEAD and safe ref constraints', async () => {
    const { repo, sha } = await initRepo()
    const gitDir = join(repo, '.git')

    expect(await resolveGitDir(repo)).toBe(gitDir)
    expect(await readGitHead(gitDir)).toEqual({ type: 'branch', name: 'main' })
    expect(await getHeadForDir(repo)).toBe(sha)
    expect(isValidGitSha(sha)).toBe(true)
    expect(isSafeRefName('feature/offline-1.2+build')).toBe(true)
    expect(isSafeRefName('../escape')).toBe(false)
    expect(isSafeRefName('feature/$(command)')).toBe(false)
    expect(isValidGitSha('not-a-sha')).toBe(false)

    await git(repo, 'pack-refs', '--all')
    expect(await resolveRef(gitDir, 'refs/heads/main')).toBe(sha)

    await git(repo, 'checkout', '--detach', sha)
    expect(await readGitHead(gitDir)).toEqual({ type: 'detached', sha })
    expect(await getHeadForDir(repo)).toBe(sha)
  })

  test('resolves worktree HEAD independently and shares common refs/config/shallow state', async () => {
    const { repo, sha } = await initRepo()
    const worktree = join(tempDir, 'feature-worktree')
    await git(repo, 'worktree', 'add', '-b', 'feature', worktree)

    const worktreeGitDir = await resolveGitDir(worktree)
    expect(worktreeGitDir).not.toBe(join(repo, '.git'))
    expect(await getCommonDir(worktreeGitDir!)).toBe(join(repo, '.git'))
    expect(await readWorktreeHeadSha(worktree)).toBe(sha)
    expect(await getRemoteUrlForDir(worktree)).toBe(
      'https://example.invalid/initial.git',
    )

    const featureSha = await commitFile(worktree, 'feature.txt', 'feature\n')
    expect(await readWorktreeHeadSha(worktree)).toBe(featureSha)
    expect(await getHeadForDir(repo)).toBe(sha)
    expect(featureSha).not.toBe(sha)

    setCwdState(worktree)
    clearResolveGitDirCache()
    expect(await getWorktreeCountFromFs()).toBe(2)
    expect(await isShallowClone()).toBe(false)
    await writeFile(join(repo, '.git', 'shallow'), `${sha}\n`)
    expect(await isShallowClone()).toBe(true)
  })
})

describe('GitFileWatcher real file events', () => {
  test('invalidates branch/head/config on checkout, commit, detach and remote edit', async () => {
    const { repo, sha } = await initRepo()
    setCwdState(repo)
    clearResolveGitDirCache()
    resetGitFileWatcher()

    expect(await getCachedBranch()).toBe('main')
    expect(await getCachedHead()).toBe(sha)
    expect(await getCachedRemoteUrl()).toBe('https://example.invalid/initial.git')
    expect(await getCachedDefaultBranch()).toBe('main')

    await git(repo, 'checkout', '-b', 'feature')
    await waitForValue(getCachedBranch, 'feature')
    const featureSha = await commitFile(repo, 'feature.txt', 'feature\n')
    await waitForValue(getCachedHead, featureSha)

    await git(repo, 'checkout', '--detach', 'main')
    await waitForValue(getCachedBranch, 'HEAD')
    await waitForValue(getCachedHead, sha)

    await git(repo, 'remote', 'set-url', 'origin', 'https://example.invalid/changed.git')
    await waitForValue(getCachedRemoteUrl, 'https://example.invalid/changed.git')
  })

  test('worktree watcher observes common config changes', async () => {
    const { repo } = await initRepo()
    const worktree = join(tempDir, 'feature-worktree')
    await git(repo, 'worktree', 'add', '-b', 'feature', worktree)
    setCwdState(worktree)
    clearResolveGitDirCache()
    resetGitFileWatcher()

    expect(await getCachedRemoteUrl()).toBe('https://example.invalid/initial.git')
    await git(repo, 'remote', 'set-url', 'origin', 'https://example.invalid/common.git')
    await waitForValue(getCachedRemoteUrl, 'https://example.invalid/common.git')
  })
})
