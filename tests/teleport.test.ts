import { describe, expect, mock, test } from 'bun:test'
import type { ReactElement } from 'react'
import type { LocalJSXCommandContext } from '../src/types/command.ts'

const fetchSession = mock(async (id: string) => ({ id, title: `Session ${id}` }))
const validateSessionRepository = mock(async () => ({ status: 'match' }))
const validateGitState = mock(async () => {})
const checkOutTeleportedSessionBranch = mock(async () => ({
  branchName: 'remote-branch',
  branchError: null,
}))
const processMessagesForTeleportResume = mock(() => [{ type: 'restored' }])
const getKnownPathsForRepo = mock(() => [] as string[])
const filterExistingPaths = mock(async (paths: string[]) => paths)

const teleportApiActual = await import('../src/utils/teleport/api.ts?actual')
const teleportActual = await import('../src/utils/teleport.tsx?actual')
const repoPathActual = await import('../src/utils/githubRepoPathMapping.ts?actual')
const shellActual = await import('../src/utils/Shell.ts?actual')
const bootstrapStateActual = await import('../src/bootstrap/state.ts?actual')
const resumeWrapperActual = await import('../src/components/TeleportResumeWrapper.tsx?actual')
const repoMismatchActual = await import('../src/components/TeleportRepoMismatchDialog.tsx?actual')

mock.module('../src/utils/teleport/api.ts', () => ({ ...teleportApiActual, fetchSession }))
mock.module('../src/utils/teleport.tsx', () => ({
  ...teleportActual,
  validateSessionRepository,
  validateGitState,
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
}))
mock.module('../src/utils/githubRepoPathMapping.ts', () => ({
  ...repoPathActual,
  getKnownPathsForRepo,
  filterExistingPaths,
}))
mock.module('../src/utils/Shell.ts', () => ({ ...shellActual, setCwd: mock(() => {}) }))
mock.module('../src/bootstrap/state.ts', () => ({
  ...bootstrapStateActual,
  setOriginalCwd: mock(() => {}),
}))
mock.module('../src/components/TeleportResumeWrapper.tsx', () => ({
  ...resumeWrapperActual,
  TeleportResumeWrapper: () => null,
}))
mock.module('../src/components/TeleportRepoMismatchDialog.tsx', () => ({
  ...repoMismatchActual,
  TeleportRepoMismatchDialog: () => null,
}))

const teleport = (await import('../src/commands/teleport/index.ts')).default
const { call, restoreDownloadedSession } = await import(
  '../src/commands/teleport/teleport.tsx'
)
const { TeleportResumeWrapper } = await import(
  '../src/components/TeleportResumeWrapper.tsx'
)
const context = { setMessages: mock(() => {}) } as unknown as LocalJSXCommandContext
const onDone = mock(() => {})

describe('/teleport', () => {
  test('uses the existing picker when no id is supplied', async () => {
    expect(teleport.name).toBe('teleport')
    expect(teleport.availability).toEqual(['claude-ai'])
    expect((await teleport.load()).call).toBeFunction()
    const element = (await call(onDone, context, '')) as ReactElement
    expect(element.type).toBe(TeleportResumeWrapper)
    expect(element.props.initialSession).toBeUndefined()
    expect(fetchSession).not.toHaveBeenCalled()
  })

  test('fetches and validates a direct session id before rendering resume', async () => {
    const element = (await call(onDone, context, 'session-123')) as ReactElement
    expect(fetchSession).toHaveBeenCalledWith('session-123')
    expect(validateSessionRepository).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-123' }),
    )
    expect(element.props.session.id).toBe('session-123')
  })

  test('network and invalid-session failures do not touch the workspace', async () => {
    fetchSession.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    validateGitState.mockClear()
    checkOutTeleportedSessionBranch.mockClear()
    expect(await call(onDone, context, 'missing')).toBeNull()
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('offline'))
    expect(validateGitState).not.toHaveBeenCalled()
    expect(checkOutTeleportedSessionBranch).not.toHaveBeenCalled()
  })

  test('repo mismatch requires a known checkout and never falls back to cleaning', async () => {
    validateSessionRepository.mockImplementationOnce(async () => ({
      status: 'mismatch',
      sessionRepo: 'owner/repo',
    }))
    expect(await call(onDone, context, 'other-repo')).toBeNull()
    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('from a checkout of owner/repo'),
    )
    expect(checkOutTeleportedSessionBranch).not.toHaveBeenCalled()
  })

  test('dirty worktree cancellation prevents checkout and transcript replacement', async () => {
    validateGitState.mockImplementationOnce(async () => {
      throw new Error('uncommitted changes')
    })
    checkOutTeleportedSessionBranch.mockClear()
    context.setMessages.mockClear()
    await restoreDownloadedSession(
      { log: [], branch: 'remote-branch' },
      context,
      onDone,
    )
    expect(checkOutTeleportedSessionBranch).not.toHaveBeenCalled()
    expect(context.setMessages).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('Existing workspace changes were preserved'),
    )
  })

  test('successful restore reuses checkout and message processing', async () => {
    validateGitState.mockImplementationOnce(async () => {})
    context.setMessages.mockClear()
    await restoreDownloadedSession({ log: [], branch: 'remote' }, context, onDone)
    expect(checkOutTeleportedSessionBranch).toHaveBeenCalledWith('remote')
    expect(processMessagesForTeleportResume).toHaveBeenCalled()
    expect(context.setMessages).toHaveBeenCalledTimes(1)
  })
})
