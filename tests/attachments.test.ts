import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createAttachmentMessage,
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  getAttachments,
  getDateChangeAttachments,
  memoryFilesToAttachments,
  tryGetPDFReference,
} from '../src/utils/attachments.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { randomUUID } from 'crypto'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flash-attachments-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function context(overrides: Record<string, unknown> = {}): ToolUseContext {
  const state = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    sessionHooks: new Map(),
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'offline-test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state,
    setAppState: () => {},
    messages: [],
    ...overrides,
  } as unknown as ToolUseContext
}

function queued() {
  return [{ value: 'queued-safe-result', mode: 'prompt', uuid: randomUUID() }] as any
}

describe('attachments behavior', () => {
  test('deduplicates mentions and preserves line ranges', () => {
    expect(extractAtMentionedFiles('check @a.ts and @a.ts and @b.md#L2-4').sort()).toEqual([
      'a.ts',
      'b.md#L2-4',
    ])
    expect(extractMcpResourceMentions('use @server:path and @server:path')).toEqual([
      'server:path',
    ])
  })

  test('isolates producer errors and still returns queued commands', async () => {
    const broken = context({
      getAppState: () => {
        throw new Error('producer failed')
      },
    })

    const result = await getAttachments(null, broken, null, queued())

    expect(result).toContainEqual(expect.objectContaining({
      type: 'queued_command',
      prompt: 'queued-safe-result',
    }))
  }, 5000)

  test('bounds a hanging MCP resource read and preserves settled attachments', async () => {
    const never = new Promise(() => {})
    const client = {
      name: 'slow-server',
      type: 'connected',
      client: { readResource: () => never },
    }
    const contextWithSlowMcp = context({
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'offline-test-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [client],
        mcpResources: {
          'slow-server': [{ uri: 'slow://resource', name: 'Slow resource' }],
        },
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
    })
    const started = Date.now()

    const result = await getAttachments(
      '@slow-server:slow://resource',
      contextWithSlowMcp,
      null,
      queued(),
    )

    expect(Date.now() - started).toBeLessThan(3000)
    expect(result).toContainEqual(expect.objectContaining({
      type: 'queued_command',
      prompt: 'queued-safe-result',
    }))
  }, 5000)

  test('deduplicates nested memory paths across calls', () => {
    const shared = context()
    const memory = [{ path: join(tempDir, 'CLAUDE.md'), content: '# Project', type: 'Project' }]

    const first = memoryFilesToAttachments(memory as any, shared as any)
    const second = memoryFilesToAttachments(memory as any, shared as any)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  test('returns lightweight PDF references for large documents', async () => {
    const path = join(tempDir, 'large.pdf')
    await writeFile(path, `%PDF-1.4\n${'x'.repeat(11 * 1024 * 1024)}`)

    const result = await tryGetPDFReference(path)

    expect(result).toMatchObject({
      type: 'pdf_reference',
      filename: path,
      pageCount: 113,
    })
  })

  test('emits no duplicate date-change attachment on the same date', () => {
    const first = getDateChangeAttachments([])
    const second = getDateChangeAttachments([])

    expect(first).toEqual([])
    expect(second).toEqual([])
  })

  test('wraps an attachment without altering its payload', () => {
    const attachment = { type: 'date_change', newDate: '2024-01-01' } as const
    const message = createAttachmentMessage(attachment)
    expect(message.type).toBe('attachment')
    expect(message.attachment).toBe(attachment)
    expect(message.uuid).toBeDefined()
  })
})
