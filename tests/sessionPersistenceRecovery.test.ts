import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { resetStateForTests, switchSession } from '../src/bootstrap/state.ts'
import type { SessionId, UUID } from '../src/types/ids.ts'
import type { TranscriptMessage } from '../src/types/logs.ts'
import type {
  AssistantMessage,
  CompactMetadata,
  SystemCompactBoundaryMessage,
  UserMessage,
} from '../src/types/message.ts'
import {
  adoptResumedSessionFile,
  buildConversationChain,
  cacheSessionTitle,
  flushSessionStorage,
  getTranscriptPath,
  loadTranscriptFile,
  recordTranscript,
  removeTranscriptMessage,
  resetProjectForTesting,
  saveAgentSetting,
  saveMode,
  setSessionFileForTesting,
} from '../src/utils/sessionStorage.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const originalNodeEnv = process.env.NODE_ENV

let tempDir: string
let projectDir: string

type ConversationFixture = (UserMessage | AssistantMessage) & {
  parentUuid: UUID | null
  isSidechain: boolean
}

type CompactBoundaryFixture = SystemCompactBoundaryMessage & {
  parentUuid: UUID | null
  isSidechain: boolean
}

function createTestMessage(
  type: 'user' | 'assistant',
  content: string,
  parentUuid: UUID | null = null,
): ConversationFixture {
  return {
    type,
    uuid: randomUUID() as UUID,
    parentUuid,
    message: { role: type, content },
    isMeta: false,
    isSidechain: false,
    timestamp: new Date().toISOString(),
  } as unknown as ConversationFixture
}

function createCompactBoundary(
  preservedSegment?: CompactMetadata['preservedSegment'],
): CompactBoundaryFixture {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: randomUUID() as UUID,
    parentUuid: null,
    isMeta: true,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    content: '[Compact boundary]',
    level: 'info',
    compactMetadata: {
      trigger: 'manual',
      preTokens: 100,
      preservedSegment,
    },
  } as CompactBoundaryFixture
}

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    entries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
    { mode: 0o600 },
  )
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flash-session-recovery-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.NODE_ENV = 'test'
  projectDir = join(tempDir, 'project')
  await mkdir(projectDir, { recursive: true })
})

afterAll(async () => {
  resetStateForTests()
  resetProjectForTesting()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalTestPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  }
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  await rm(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetStateForTests()
  resetProjectForTesting()
})

describe('Session Persistence - Crash Recovery', () => {
  test('a new process recovers complete JSONL entries after an abrupt writer exit', async () => {
    const sessionId = randomUUID() as SessionId
    const transcriptPath = join(tempDir, `${sessionId}.jsonl`)
    const msg1 = createTestMessage('user', 'Hello')
    const msg2 = createTestMessage('assistant', 'Hi there', msg1.uuid)
    const helperPath = join(tempDir, 'crash-helper.ts')
    await writeFile(
      helperPath,
      `
        import { appendFile, writeFile } from 'fs/promises'
        const entries = ${JSON.stringify([msg1, msg2])}
        const path = process.argv[2]
        await writeFile(path, entries.map(entry => JSON.stringify(entry)).join('\\n') + '\\n', { mode: 0o600 })
        await appendFile(path, '{"type":"user","uuid":"')
        process.exit(42)
      `,
    )

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [helperPath, transcriptPath], {
        cwd: tempDir,
        stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('exit', resolve)
    })
    expect(exitCode).toBe(42)

    const { messages, leafUuids } = await loadTranscriptFile(transcriptPath)
    expect([...messages.keys()].sort()).toEqual([msg1.uuid, msg2.uuid].sort())
    expect(leafUuids).toEqual(new Set([msg2.uuid]))
    expect(
      buildConversationChain(messages, messages.get(msg2.uuid)!).map(
        message => message.uuid,
      ),
    ).toEqual([msg1.uuid, msg2.uuid])
  })

  test('loadTranscriptFile isolates invalid lines without dropping valid messages', async () => {
    const transcriptPath = join(tempDir, `${randomUUID()}.jsonl`)
    const msg1 = createTestMessage('user', 'Valid message')
    const msg2 = createTestMessage('assistant', 'Valid response', msg1.uuid)
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(
      transcriptPath,
      [
        'not json at all',
        JSON.stringify(msg1),
        '{"partial": "json"}',
        JSON.stringify(msg2),
        'another invalid line',
      ].join('\n') + '\n',
      { mode: 0o600 },
    )

    const { messages } = await loadTranscriptFile(transcriptPath)
    expect([...messages.keys()].sort()).toEqual([msg1.uuid, msg2.uuid].sort())
  })
})

describe('Session Persistence - Lazy File Creation', () => {
  test('cache-only metadata does not materialize a file before the first message', async () => {
    const sessionId = randomUUID() as SessionId
    switchSession(sessionId, projectDir)
    const transcriptPath = getTranscriptPath()
    expect(await Bun.file(transcriptPath).exists()).toBe(false)

    cacheSessionTitle('Test Session Title')
    saveAgentSetting('test-setting')
    saveMode('normal')
    await flushSessionStorage()
    expect(await Bun.file(transcriptPath).exists()).toBe(false)

    const msg1 = createTestMessage('user', 'First real message')
    await recordTranscript([msg1])
    await flushSessionStorage()

    expect(await Bun.file(transcriptPath).exists()).toBe(true)
    const content = await readFile(transcriptPath, 'utf8')
    expect(content).toContain('First real message')
    expect(content).toContain('Test Session Title')
    expect(content).toContain('test-setting')
    expect(content).toContain('"mode":"normal"')
  })

  test('adoptResumedSessionFile appends to the restored transcript', async () => {
    const sessionId = randomUUID() as SessionId
    switchSession(sessionId, projectDir)
    const msg1 = createTestMessage('user', 'Original message')
    const msg2 = createTestMessage('assistant', 'Original response', msg1.uuid)
    await recordTranscript([msg1, msg2])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPath()

    resetStateForTests()
    resetProjectForTesting()
    switchSession(sessionId, projectDir)
    adoptResumedSessionFile()

    const msg3 = createTestMessage('user', 'New message after resume', msg2.uuid)
    await recordTranscript([msg3])
    await flushSessionStorage()

    const { messages } = await loadTranscriptFile(transcriptPath)
    expect([...messages.keys()].sort()).toEqual(
      [msg1.uuid, msg2.uuid, msg3.uuid].sort(),
    )
  })
})

describe('Session Persistence - Tombstone', () => {
  test('removeTranscriptMessage truncates a trailing message', async () => {
    switchSession(randomUUID() as SessionId, projectDir)
    const msg1 = createTestMessage('user', 'First message')
    const msg2 = createTestMessage('assistant', 'Response', msg1.uuid)
    const msg3 = createTestMessage('user', 'Last message', msg2.uuid)
    await recordTranscript([msg1, msg2, msg3])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPath()
    const originalSize = (await stat(transcriptPath)).size

    await removeTranscriptMessage(msg3.uuid)
    await flushSessionStorage()

    expect((await stat(transcriptPath)).size).toBeLessThan(originalSize)
    const { messages } = await loadTranscriptFile(transcriptPath)
    expect([...messages.keys()].sort()).toEqual([msg1.uuid, msg2.uuid].sort())
  })

  test('removeTranscriptMessage rewrites a small file when the target is outside the tail window', async () => {
    switchSession(randomUUID() as SessionId, projectDir)
    const target = createTestMessage('user', 'Message to delete')
    const middle = createTestMessage('assistant', 'Middle message', target.uuid)
    const padding = createTestMessage('user', 'x'.repeat(70 * 1024), middle.uuid)
    const last = createTestMessage('assistant', 'Last message', padding.uuid)
    await recordTranscript([target, middle, padding, last])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPath()
    expect((await stat(transcriptPath)).size).toBeLessThan(50 * 1024 * 1024)

    await removeTranscriptMessage(target.uuid)
    await flushSessionStorage()

    const { messages } = await loadTranscriptFile(transcriptPath)
    expect(messages.has(target.uuid)).toBe(false)
    expect(messages.has(middle.uuid)).toBe(true)
    expect(messages.has(padding.uuid)).toBe(true)
    expect(messages.has(last.uuid)).toBe(true)
  })

  test('removeTranscriptMessage leaves an over-50MiB file byte-for-byte unchanged on the guarded slow path', async () => {
    const sessionId = randomUUID() as SessionId
    const transcriptPath = join(tempDir, `${sessionId}-large.jsonl`)
    const target = createTestMessage('user', 'Early target')
    const padding = createTestMessage(
      'user',
      'x'.repeat(51 * 1024 * 1024),
      target.uuid,
    )
    const last = createTestMessage('assistant', 'Last message', padding.uuid)
    await writeJsonl(transcriptPath, [target, padding, last])
    const originalBytes = await readFile(transcriptPath)
    expect(originalBytes.byteLength).toBeGreaterThan(50 * 1024 * 1024)

    switchSession(sessionId, projectDir)
    setSessionFileForTesting(transcriptPath)
    await removeTranscriptMessage(target.uuid)
    await flushSessionStorage()

    const afterBytes = await readFile(transcriptPath)
    expect(afterBytes.equals(originalBytes)).toBe(true)
    const { messages } = await loadTranscriptFile(transcriptPath)
    expect(messages.has(target.uuid)).toBe(true)
    expect(messages.has(padding.uuid)).toBe(true)
    expect(messages.has(last.uuid)).toBe(true)
  })
})

describe('Session Persistence - Compact Boundary', () => {
  test('an over-5MiB transcript loads only the last boundary suffix without a preserved segment', async () => {
    const transcriptPath = join(tempDir, `${randomUUID()}-large-compact.jsonl`)
    const old1 = createTestMessage('user', 'Old message 1')
    const old2 = createTestMessage('assistant', 'Old response', old1.uuid)
    const padding = createTestMessage(
      'user',
      'x'.repeat(6 * 1024 * 1024),
      old2.uuid,
    )
    const boundary = createCompactBoundary()
    const summary = createTestMessage(
      'assistant',
      '[History summarized]',
      boundary.uuid,
    )
    const new1 = createTestMessage('user', 'New question', summary.uuid)
    const new2 = createTestMessage('assistant', 'New answer', new1.uuid)
    await writeJsonl(transcriptPath, [
      old1,
      old2,
      padding,
      boundary,
      summary,
      new1,
      new2,
    ])
    expect((await stat(transcriptPath)).size).toBeGreaterThan(5 * 1024 * 1024)

    const { messages } = await loadTranscriptFile(transcriptPath)
    expect([...messages.keys()].sort()).toEqual(
      [boundary.uuid, summary.uuid, new1.uuid, new2.uuid].sort(),
    )
    expect(
      buildConversationChain(messages, messages.get(new2.uuid)!).map(
        message => message.uuid,
      ),
    ).toEqual([boundary.uuid, summary.uuid, new1.uuid, new2.uuid])
  })

  test('preservedSegment relinks the head and anchor sibling and prunes other pre-boundary messages', async () => {
    const transcriptPath = join(tempDir, `${randomUUID()}-preserved.jsonl`)
    const pruned1 = createTestMessage('user', 'Pruned message 1')
    const pruned2 = createTestMessage('assistant', 'Pruned response', pruned1.uuid)
    const preserved1 = createTestMessage('user', 'Preserved 1', pruned2.uuid)
    const preserved2 = createTestMessage('assistant', 'Preserved 2', preserved1.uuid)
    const preserved3 = createTestMessage('user', 'Preserved 3', preserved2.uuid)
    const boundary = createCompactBoundary({
      headUuid: preserved1.uuid,
      tailUuid: preserved3.uuid,
      anchorUuid: randomUUID() as UUID,
    })
    const summary = createTestMessage(
      'assistant',
      '[History summarized]',
      boundary.uuid,
    )
    boundary.compactMetadata.preservedSegment!.anchorUuid = summary.uuid
    const new1 = createTestMessage('user', 'New question', summary.uuid)
    const new2 = createTestMessage('assistant', 'New answer', new1.uuid)
    await writeJsonl(transcriptPath, [
      pruned1,
      pruned2,
      preserved1,
      preserved2,
      preserved3,
      boundary,
      summary,
      new1,
      new2,
    ])

    const { messages } = await loadTranscriptFile(transcriptPath)
    expect(messages.has(pruned1.uuid)).toBe(false)
    expect(messages.has(pruned2.uuid)).toBe(false)
    expect(messages.get(preserved1.uuid)?.parentUuid).toBe(summary.uuid)
    expect(messages.get(new1.uuid)?.parentUuid).toBe(preserved3.uuid)
    expect(messages.get(preserved2.uuid)?.parentUuid).toBe(preserved1.uuid)
    expect(messages.get(preserved3.uuid)?.parentUuid).toBe(preserved2.uuid)

    const conversation = buildConversationChain(
      messages,
      messages.get(new2.uuid)!,
    ).filter(message => message.type === 'user' || message.type === 'assistant')
    expect(conversation.map(message => message.uuid)).toEqual([
      summary.uuid,
      preserved1.uuid,
      preserved2.uuid,
      preserved3.uuid,
      new1.uuid,
      new2.uuid,
    ])
  })

  test('a small transcript without a preserved segment retains pre-boundary entries', async () => {
    const transcriptPath = join(tempDir, `${randomUUID()}.jsonl`)
    const old1 = createTestMessage('user', 'Old message 1')
    const old2 = createTestMessage('assistant', 'Old response', old1.uuid)
    const boundary = createCompactBoundary()
    const summary = createTestMessage(
      'assistant',
      '[History summarized]',
      boundary.uuid,
    )
    const new1 = createTestMessage('user', 'New question', summary.uuid)
    await writeJsonl(transcriptPath, [old1, old2, boundary, summary, new1])

    const { messages } = await loadTranscriptFile(transcriptPath)
    expect([...messages.keys()].sort()).toEqual(
      [old1.uuid, old2.uuid, boundary.uuid, summary.uuid, new1.uuid].sort(),
    )
  })
})
