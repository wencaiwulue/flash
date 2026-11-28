import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'plan-worktree-config-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

const actualSessionStorage = await import('../src/utils/sessionStorage.ts')
const actualConfig = await import('../src/utils/config.ts')
mock.module('../src/utils/config.ts', () => ({
  ...actualConfig,
  saveCurrentProjectConfig: () => {},
}))
mock.module('../src/utils/sessionStorage.ts', () => ({
  ...actualSessionStorage,
  saveWorktreeState: () => {},
}))

const {
  clearAllPlanSlugs,
  copyPlanForFork,
  copyPlanForResume,
  getPlanSlug,
  getPlansDirectory,
} = await import('../src/utils/plans.ts')
const {
  createAgentWorktree,
  removeAgentWorktree,
  restoreWorktreeSession,
  validateWorktreeSlug,
  worktreeBranchName,
} = await import('../src/utils/worktree.ts')
const { ExitWorktreeTool } = await import('../src/tools/ExitWorktreeTool/ExitWorktreeTool.ts')
const { getCwd, runWithCwdOverride } = await import('../src/utils/cwd.ts')
const { setCwd } = await import('../src/utils/Shell.js')
const {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} = await import('../src/bootstrap/state.ts')

import type { SessionId } from '../src/types/ids.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { WorktreeSession } from '../src/utils/worktree.ts'

const originalCwd = getOriginalCwd()
const originalProjectRoot = getProjectRoot()
const originalShellCwd = getCwd()
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM
let tempRoot = ''
let repo = ''
let worktreePath = ''
let worktreeBranch: string | undefined
let headCommit = ''

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
}

function session(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    originalCwd: repo,
    worktreePath,
    worktreeName: 'feature-test',
    worktreeBranch,
    originalHeadCommit: headCommit,
    sessionId: 'session-worktree-test',
    ...overrides,
  }
}

beforeEach(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'plan-worktree-')))
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  repo = join(tempRoot, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.name', 'Offline Test'])
  git(repo, ['config', 'user.email', 'offline@example.invalid'])
  writeFileSync(join(repo, 'README.md'), 'parent\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-qm', 'initial'])
  headCommit = git(repo, ['rev-parse', 'HEAD']).trim()
  clearAllPlanSlugs()
  getPlansDirectory.cache.clear?.()
})

afterEach(async () => {
  restoreWorktreeSession(null)
  if (worktreePath && existsSync(worktreePath)) {
    await removeAgentWorktree(worktreePath, worktreeBranch, repo)
  }
  clearAllPlanSlugs()
  getPlansDirectory.cache.clear?.()
  setOriginalCwd(originalCwd)
  setProjectRoot(originalProjectRoot)
  setCwd(originalShellCwd)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal
  if (originalGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNoSystem
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
  repo = ''
  worktreePath = ''
  worktreeBranch = undefined
  headCommit = ''
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(moduleIsolationRoot, { recursive: true, force: true })
})

describe('plan slug, resume, and fork', () => {
  test('reuses the resumed slug but gives a fork a distinct file with identical content', async () => {
    const plansDir = getPlansDirectory()
    writeFileSync(join(plansDir, 'original-plan.md'), 'plan body\n')
    const target = 'resume-target' as SessionId
    const fork = 'fork-target' as SessionId
    const log = { messages: [{ slug: 'original-plan' }] } as never

    expect(await copyPlanForResume(log, target)).toBe(true)
    expect(getPlanSlug(target)).toBe('original-plan')
    expect(await copyPlanForFork(log, fork)).toBe(true)
    const forkSlug = getPlanSlug(fork)
    expect(forkSlug).not.toBe('original-plan')
    expect(readFileSync(join(plansDir, `${forkSlug}.md`), 'utf8')).toBe('plan body\n')
    expect(readFileSync(join(plansDir, 'original-plan.md'), 'utf8')).toBe('plan body\n')
  })

  test('flattens nested worktree slugs and rejects traversal or empty segments', () => {
    expect(worktreeBranchName('user/feature')).toBe('worktree-user+feature')
    for (const slug of ['', '../escape', '/absolute', 'a//b', 'a/../b']) {
      expect(() => validateWorktreeSlug(slug)).toThrow()
    }
  })
})

describe('ExitWorktreeTool real safety gates', () => {
  test('rejects removal without an active session', async () => {
    restoreWorktreeSession(null)
    const result = await ExitWorktreeTool.validateInput({ action: 'remove' })
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    expect(result.message).toContain('No filesystem changes were made')
  })

  test('refuses dirty removal until discard_changes is explicit, then removes only that worktree', async () => {
    const created = await runWithCwdOverride(repo, () => createAgentWorktree('feature-test'))
    worktreePath = realpathSync(created.worktreePath)
    worktreeBranch = created.worktreeBranch
    headCommit = created.headCommit!
    restoreWorktreeSession(session())
    writeFileSync(join(worktreePath, 'dirty.txt'), 'dirty\n')

    const refused = await ExitWorktreeTool.validateInput({ action: 'remove' })
    expect(refused.result).toBe(false)
    expect(refused.errorCode).toBe(2)
    expect(refused.message).toContain('1 uncommitted file')
    expect(existsSync(join(worktreePath, 'dirty.txt'))).toBe(true)

    const allowed = await ExitWorktreeTool.validateInput({ action: 'remove', discard_changes: true })
    expect(allowed.result).toBe(true)
    const result = await ExitWorktreeTool.call(
      { action: 'remove', discard_changes: true },
      {} as ToolUseContext,
    )
    expect(result.data.discardedFiles).toBe(1)
    expect(existsSync(worktreePath)).toBe(false)
    expect(existsSync(join(repo, 'README.md'))).toBe(true)
  })

  test('fails closed when the original HEAD baseline is missing', async () => {
    const created = await runWithCwdOverride(repo, () => createAgentWorktree('feature-test'))
    worktreePath = realpathSync(created.worktreePath)
    worktreeBranch = created.worktreeBranch
    restoreWorktreeSession(session({ originalHeadCommit: undefined }))

    const result = await ExitWorktreeTool.validateInput({ action: 'remove' })
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(3)
    expect(result.message).toContain('Could not verify worktree state')
    expect(existsSync(worktreePath)).toBe(true)
  })

  test('keeps the worktree and dirty file while restoring the original session cwd', async () => {
    const created = await runWithCwdOverride(repo, () => createAgentWorktree('feature-test'))
    worktreePath = realpathSync(created.worktreePath)
    worktreeBranch = created.worktreeBranch
    headCommit = created.headCommit!
    restoreWorktreeSession(session())
    writeFileSync(join(worktreePath, 'dirty.txt'), 'dirty\n')

    const result = await ExitWorktreeTool.call({ action: 'keep' }, {} as ToolUseContext)
    expect(result.data.action).toBe('keep')
    expect(result.data.originalCwd).toBe(repo)
    expect(existsSync(join(worktreePath, 'dirty.txt'))).toBe(true)
    expect(getCwd()).toBe(repo)
    expect(getOriginalCwd()).toBe(repo)
  })
})
