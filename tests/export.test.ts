import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import {
  call,
  extractFirstPrompt,
  sanitizeFilename,
} from '../src/commands/export/export.tsx'
import type { ToolUseContext } from '../src/Tool.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { setCwdState } from '../src/bootstrap/state.ts'
import type { Message } from '../src/types/message.ts'
import { streamRenderedMessages } from '../src/utils/exportRenderer.tsx'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'

let tempDir: string
let cwd: string
let outside: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flash-export-'))
  cwd = join(tempDir, 'cwd')
  outside = join(tempDir, 'outside')
  await mkdir(cwd, { recursive: true })
  await mkdir(outside, { recursive: true })
  setCwdState(cwd)
})

afterEach(async () => {
  setCwdState(process.cwd())
  await rm(tempDir, { recursive: true, force: true })
})

function userMessage(content: string): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content },
  } as Message
}

function context(messages: Message[]): ToolUseContext {
  return {
    messages,
    options: {
      messages,
      tools: [],
      commands: [],
      verbose: false,
      safeMode: false,
      forkNumber: 0,
      readFileState: createFileStateCacheWithSizeLimit(10),
      toolPermissionContext: getEmptyToolPermissionContext(),
      sessionId: 'offline-export',
      isNonInteractiveSession: true,
    },
  } as unknown as ToolUseContext
}

describe('/export prompt and filename helpers', () => {
  test('extracts only the first line of the first user prompt and truncates at 50 chars', () => {
    const long = 'x'.repeat(60)
    expect(extractFirstPrompt([userMessage(`${long}\nsecond line`)])).toBe(
      `${'x'.repeat(49)}…`,
    )
    expect(extractFirstPrompt([])).toBe('')
    expect(sanitizeFilename('  Hello, Work Tree / Demo!  ')).toBe(
      'hello-work-tree-demo',
    )
  })
})

describe('/export streaming renderer', () => {
  test('renders every message in bounded chunks with ordered progress and plain text', async () => {
    const messages = Array.from({ length: 45 }, (_, index) =>
      userMessage(`message-${index + 1}`),
    )
    const chunks: string[] = []
    const progress: number[] = []

    await streamRenderedMessages(
      messages,
      [],
      chunk => {
        chunks.push(chunk)
      },
      { columns: 100, chunkSize: 5, onProgress: value => progress.push(value) },
    )

    expect(chunks).toHaveLength(9)
    expect(progress).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45])
    const output = stripAnsi(chunks.join(''))
    expect(output).toContain('message-1')
    expect(output).toContain('message-45')
    expect(output).not.toContain('message-46')
    expect(output).not.toMatch(/\[[0-9;]*m/)
  })
})

describe('/export file safety', () => {
  test('writes a new text export inside the workspace', async () => {
    const onDone = mock()
    await call(onDone, context([userMessage('offline export')]), 'new-export')

    const destination = join(cwd, 'new-export.txt')
    expect(onDone).toHaveBeenCalledWith(`Conversation exported to: ${destination}`)
    expect(await readFile(destination, 'utf8')).toContain('offline export')
  })


  test('rejects traversal and absolute destinations without creating files', async () => {
    const traversalDone = mock()
    await call(traversalDone, context([userMessage('offline')]), '../outside/escape.txt')
    expect(traversalDone).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export conversation'),
    )
    expect(await Bun.file(join(outside, 'escape.txt')).exists()).toBe(false)

    const absoluteDone = mock()
    const absolute = join(outside, 'absolute.txt')
    await call(absoluteDone, context([userMessage('offline')]), absolute)
    expect(absoluteDone).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export conversation'),
    )
    expect(await Bun.file(absolute).exists()).toBe(false)
  })

  test('rejects a symlinked parent outside the workspace', async () => {
    await symlink(outside, join(cwd, 'linked'), 'dir')
    const onDone = mock()

    await call(onDone, context([userMessage('offline')]), 'linked/escape.txt')

    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export conversation'),
    )
    expect(await Bun.file(join(outside, 'escape.txt')).exists()).toBe(false)
  })

  test('never overwrites an existing destination', async () => {
    const destination = join(cwd, 'existing.txt')
    await writeFile(destination, 'original-content')
    const onDone = mock()

    await call(onDone, context([userMessage('offline')]), 'existing.txt')

    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export conversation'),
    )
    expect(await readFile(destination, 'utf8')).toBe('original-content')
  })

  test('does not create missing parent directories', async () => {
    const onDone = mock()
    await call(onDone, context([userMessage('offline')]), 'missing/out.txt')

    expect(onDone).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export conversation'),
    )
    expect(await Bun.file(join(cwd, 'missing')).exists()).toBe(false)
  })
})
