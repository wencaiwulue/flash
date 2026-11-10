import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  isSessionPersistenceDisabled,
  setOriginalCwd,
  setSessionPersistenceDisabled,
} from '../src/bootstrap/state.ts'
import { createSdkQuery } from '../src/utils/sdkQuery.ts'
import {
  FileCheckpointing,
  type UpdateFileHistoryState,
} from '../src/utils/fileCheckpointing.ts'
import {
  type FileHistoryState,
  fileHistoryMakeSnapshot,
  fileHistoryTrackEdit,
} from '../src/utils/fileHistory.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalApiKey = process.env.ANTHROPIC_API_KEY
const originalSdkCheckpointing =
  process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
const originalDisableCheckpointing =
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
const originalCwd = getOriginalCwd()
const originalPersistenceDisabled = isSessionPersistenceDisabled()

let tempDir: string
let projectDir: string

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function createCheckpointing(enabled?: boolean): {
  checkpoints: FileCheckpointing
  update: UpdateFileHistoryState
  state: () => FileHistoryState
} {
  let state: FileHistoryState = {
    snapshots: [],
    trackedFiles: new Set(),
    snapshotSequence: 0,
    checkpointingEnabled: enabled,
  }
  const update: UpdateFileHistoryState = updater => {
    state = updater(state)
  }
  return {
    checkpoints: new FileCheckpointing(() => state, update),
    update,
    state: () => state,
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claude-sdk-rewind-'))
  projectDir = join(tempDir, 'project')
  await mkdir(projectDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.ANTHROPIC_API_KEY = 'test-only-no-model-call'
  delete process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
  delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  setOriginalCwd(projectDir)
  setSessionPersistenceDisabled(false)
})

afterEach(async () => {
  restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
  restoreEnv('ANTHROPIC_API_KEY', originalApiKey)
  restoreEnv(
    'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
    originalSdkCheckpointing,
  )
  restoreEnv(
    'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING',
    originalDisableCheckpointing,
  )
  setOriginalCwd(originalCwd)
  setSessionPersistenceDisabled(originalPersistenceDisabled)
  await rm(tempDir, { recursive: true, force: true })
})

describe('SDK file rewind', () => {
  test('dryRun does not write; rewind restores existing files and deletes new files', async () => {
    const { checkpoints, update } = createCheckpointing(true)
    const messageId = randomUUID()
    const existingFile = join(projectDir, 'existing.txt')
    const newFile = join(projectDir, 'new.txt')
    await writeFile(existingFile, 'before\n')

    await checkpoints.makeSnapshot(messageId)
    await fileHistoryTrackEdit(update, existingFile, messageId)
    await fileHistoryTrackEdit(update, newFile, messageId)
    await writeFile(existingFile, 'after\n')
    await writeFile(newFile, 'new\n')

    const preview = await checkpoints.rewindFiles(messageId, { dryRun: true })
    expect(preview.canRewind).toBe(true)
    expect(new Set(preview.filesChanged)).toEqual(
      new Set([existingFile, newFile]),
    )
    expect(await readFile(existingFile, 'utf8')).toBe('after\n')
    expect(await readFile(newFile, 'utf8')).toBe('new\n')

    const result = await checkpoints.rewindFiles(messageId)
    expect(result).toEqual({ canRewind: true })
    expect(await readFile(existingFile, 'utf8')).toBe('before\n')
    await expect(access(newFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('an unknown user UUID returns an error without changing files', async () => {
    const { checkpoints, update } = createCheckpointing(true)
    const messageId = randomUUID()
    const file = join(projectDir, 'file.txt')
    await writeFile(file, 'before')
    await checkpoints.makeSnapshot(messageId)
    await fileHistoryTrackEdit(update, file, messageId)
    await writeFile(file, 'after')

    const result = await checkpoints.rewindFiles(randomUUID())
    expect(result.canRewind).toBe(false)
    expect(result.error).toContain('No file checkpoint')
    expect((await checkpoints.rewindFiles('not-a-uuid')).canRewind).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('after')
  })

  test('rewind waits for the matching asynchronous snapshot', async () => {
    let state: FileHistoryState = {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
      checkpointingEnabled: true,
    }
    const update: UpdateFileHistoryState = updater => {
      state = updater(state)
    }
    let releaseSnapshot!: () => void
    const gate = new Promise<void>(resolve => {
      releaseSnapshot = resolve
    })
    const checkpoints = new FileCheckpointing(
      () => state,
      update,
      async (updateState, messageId) => {
        await gate
        await fileHistoryMakeSnapshot(updateState, messageId)
      },
    )
    const messageId = randomUUID()
    const snapshot = checkpoints.makeSnapshot(messageId)
    let rewindCompleted = false
    const rewind = checkpoints.rewindFiles(messageId, { dryRun: true }).then(
      result => {
        rewindCompleted = true
        return result
      },
    )

    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(rewindCompleted).toBe(false)
      expect(checkpoints.makeSnapshot(messageId)).toBe(snapshot)
    } finally {
      releaseSnapshot()
    }

    await snapshot
    const result = await rewind
    expect(result.canRewind).toBe(true)
    expect(result.filesChanged).toEqual([])
    expect(state.snapshots.map(snapshot => snapshot.messageId)).toEqual([
      messageId,
    ])
  })

  test('per-query options isolate concurrent enabled and disabled states', async () => {
    const enabled = createCheckpointing(true)
    const disabled = createCheckpointing(false)
    const enabledId = randomUUID()
    const disabledId = randomUUID()

    await Promise.all([
      enabled.checkpoints.makeSnapshot(enabledId),
      disabled.checkpoints.makeSnapshot(disabledId),
    ])

    expect(enabled.state().snapshots).toHaveLength(1)
    expect(disabled.state().snapshots).toHaveLength(0)
    expect(
      (await disabled.checkpoints.rewindFiles(disabledId)).canRewind,
    ).toBe(false)
    expect(process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBeUndefined()
  })

  test('checkpoint backups do not enable transcript persistence', async () => {
    setSessionPersistenceDisabled(true)
    const { checkpoints } = createCheckpointing(true)
    await checkpoints.makeSnapshot(randomUUID())

    expect(isSessionPersistenceDisabled()).toBe(true)
    await expect(
      access(join(process.env.CLAUDE_CONFIG_DIR!, 'projects')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('persistence state is restored and conflicting concurrent options fail clearly', async () => {
    let releasePrompt!: () => void
    const promptGate = new Promise<void>(resolve => {
      releasePrompt = resolve
    })
    async function* waitingPrompt(): AsyncIterable<never> {
      await promptGate
    }
    async function* emptyPrompt(): AsyncIterable<never> {}

    const first = createSdkQuery({
      prompt: waitingPrompt(),
      options: {
        enableFileCheckpointing: true,
        persistSession: false,
        tools: [],
      },
    })
    const firstNext = first.next()
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (isSessionPersistenceDisabled()) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(isSessionPersistenceDisabled()).toBe(true)

      const second = createSdkQuery({
        prompt: emptyPrompt(),
        options: { persistSession: true, tools: [] },
      })
      await expect(second.next()).rejects.toThrow(
        'Concurrent SDK queries with different persistSession options',
      )
    } finally {
      releasePrompt()
      await firstNext
    }
    expect(isSessionPersistenceDisabled()).toBe(false)
  })

  test('the SDK query rejects rewind when the option is disabled without running a model', async () => {
    process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
    const query = createSdkQuery({
      prompt: 'not sent to a model',
      options: { enableFileCheckpointing: false },
    })
    const result = await query.rewindFiles(randomUUID() as UUID, {
      dryRun: true,
    })
    expect(result.canRewind).toBe(false)
    expect(result.error).toContain('not enabled')
  })
})
