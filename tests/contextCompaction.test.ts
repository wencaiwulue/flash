import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../src/Tool.ts'
import {
  createPostCompactFileAttachments,
  stripImagesFromMessages,
  stripReinjectedAttachments,
  truncateHeadForPTLRetry,
} from '../src/services/compact/compact.ts'
import type {
  AttachmentMessage,
  Message,
} from '../src/types/message.ts'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'
import {
  createAssistantMessage,
  createUserMessage,
} from '../src/utils/messages.ts'

const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'

function ptlResponse() {
  return createAssistantMessage({
    content: 'prompt is too long',
    isApiErrorMessage: true,
  })
}

function messageText(message: Message): unknown {
  if (!('message' in message)) return undefined
  const content = message.message.content
  if (message.type === 'assistant' && Array.isArray(content)) {
    return content.map(block => block.type === 'text' ? block.text : '').join('')
  }
  return content
}

describe('context compaction - PTL recovery', () => {
  test('drops the oldest API round and preserves the remaining tail', () => {
    const messages: Message[] = []
    for (let i = 0; i < 6; i++) {
      messages.push(
        createUserMessage({ content: `user-${i}` }),
        createAssistantMessage({ content: `assistant-${i}` }),
      )
    }
    const finalUuid = messages.at(-1)!.uuid

    const result = truncateHeadForPTLRetry(messages, ptlResponse())

    expect(result).not.toBeNull()
    expect(result![0]).toMatchObject({
      type: 'user',
      isMeta: true,
      message: { content: PTL_RETRY_MARKER },
    })
    expect(result!.at(-1)!.uuid).toBe(finalUuid)
    expect(result!.some(message => messageText(message) === 'user-0')).toBe(false)
    expect(result!.some(message => messageText(message) === 'assistant-0')).toBe(true)
    expect(result!.some(message => messageText(message) === 'assistant-1')).toBe(true)
    expect(result!.some(message => messageText(message) === 'assistant-5')).toBe(true)
    expect(messages).toHaveLength(12)
  })

  test('removes an earlier retry marker and still makes truncation progress', () => {
    const messages: Message[] = [
      createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }),
    ]
    for (let i = 0; i < 4; i++) {
      messages.push(
        createUserMessage({ content: `user-${i}` }),
        createAssistantMessage({ content: `assistant-${i}` }),
      )
    }

    const result = truncateHeadForPTLRetry(messages, ptlResponse())

    expect(result).not.toBeNull()
    expect(result!.filter(message => messageText(message) === PTL_RETRY_MARKER)).toHaveLength(1)
    expect(result!.some(message => messageText(message) === 'user-0')).toBe(false)
    expect(result!.some(message => messageText(message) === 'assistant-1')).toBe(true)
    expect(result!.at(-1)).toBe(messages.at(-1))
  })

  test('returns null when no round can be dropped without emptying input', () => {
    const messages = [createUserMessage({ content: 'only one round' })]
    expect(truncateHeadForPTLRetry(messages, ptlResponse())).toBeNull()
  })
})

describe('context compaction - reinjected attachments', () => {
  test('filters reinjected skill attachments only when skill search is enabled', () => {
    const discovery = {
      type: 'attachment',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      attachment: { type: 'skill_discovery', skills: [] },
    } as unknown as AttachmentMessage
    const listing = {
      ...discovery,
      uuid: randomUUID(),
      attachment: { type: 'skill_listing', skills: [] },
    } as unknown as AttachmentMessage
    const messages: Message[] = [createUserMessage({ content: 'control' }), discovery, listing]

    const result = stripReinjectedAttachments(messages)

    // The focused runner uses the external default; scripts/test.ts enables
    // the same feature profile as the full build. Verify the active gate's
    // behavior in both environments without changing the input.
    if (feature('EXPERIMENTAL_SKILL_SEARCH')) {
      expect(result.map(message => message.uuid)).toEqual([messages[0].uuid])
    } else {
      expect(result).toBe(messages)
      expect(result.map(message => message.uuid)).toEqual(messages.map(message => message.uuid))
    }
    expect(messages).toHaveLength(3)
  })
})

describe('context compaction - media stripping and long sessions', () => {
  test('replaces image and document blocks without mutating the input', () => {
    const messages: Message[] = [
      createUserMessage({
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image-data' } },
          { type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'doc-data' } },
          { type: 'text', text: 'after' },
        ],
      }),
    ]
    const original = structuredClone(messages)

    const result = stripImagesFromMessages(messages)
    const content = (result[0] as any).message.content

    expect(content.map((block: any) => block.type)).toEqual(['text', 'text', 'text', 'text'])
    expect(content.map((block: any) => block.text)).toEqual(['before', '[image]', '[document]', 'after'])
    expect(messages).toEqual(original)
    expect(stripImagesFromMessages(result)).toEqual(result)
  })

  test('replaces nested tool_result media and preserves tool metadata', () => {
    const messages: Message[] = [
      createUserMessage({
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: [
            { type: 'text', text: 'result' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image-data' } },
          ],
        }],
      }),
    ]

    const result = stripImagesFromMessages(messages)
    const toolResult = (result[0] as any).message.content[0]

    expect(toolResult.tool_use_id).toBe('tool-1')
    expect(toolResult.content[0]).toEqual({ type: 'text', text: 'result' })
    expect(toolResult.content[1]).toEqual({ type: 'text', text: '[image]' })
  })

  test('retains order, text and the final message across a long session', () => {
    const messages: Message[] = []
    for (let i = 0; i < 100; i++) {
      messages.push(
        createUserMessage({
          content: i % 10 === 0
            ? [
                { type: 'text', text: `Message ${i}` },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `image-${i}` } },
              ]
            : `Message ${i}`,
        }),
        createAssistantMessage({ content: `Response ${i}` }),
      )
    }
    const original = structuredClone(messages)

    const result = stripImagesFromMessages(messages)

    expect(result).toHaveLength(200)
    expect(result.map(message => message.uuid)).toEqual(messages.map(message => message.uuid))
    expect(messageText(result.at(-1)!)).toBe('Response 99')
    for (const message of result) {
      if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
      for (const block of message.message.content) {
        expect(block.type).not.toBe('image')
        expect(block.type).not.toBe('document')
      }
    }
    expect(messages).toEqual(original)
  })
})

describe('context compaction - post-compact file restoration', () => {
  let testDir: string
  let context: ToolUseContext

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'flash-compact-files-'))
    context = {
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(),
      getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
      options: { tools: [] },
    } as unknown as ToolUseContext
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('restores fresh content for the most recent files up to maxFiles', async () => {
    const files = ['old.ts', 'middle.ts', 'new.ts'].map(name => join(testDir, name))
    for (const [index, file] of files.entries()) {
      await writeFile(file, `fresh-content-${index}`)
    }
    const readFileState = Object.fromEntries(files.map((file, index) => [file, {
      content: `stale-content-${index}`,
      timestamp: index + 1,
    }]))

    const result = await createPostCompactFileAttachments(readFileState, context, 2)

    expect(result).toHaveLength(2)
    expect(result.map(message => (message.attachment as any).filename)).toEqual([files[2], files[1]])
    for (const [index, message] of result.entries()) {
      const attachment = message.attachment as any
      expect(attachment.type).toBe('file')
      expect(attachment.content.file.content).toContain(`fresh-content-${2 - index}`)
      expect(attachment.content.file.content).not.toContain('stale-content')
    }
  })

  test('skips files already visible in preserved Read tool calls', async () => {
    const preservedFile = join(testDir, 'preserved.ts')
    const restoreFile = join(testDir, 'restore.ts')
    await writeFile(preservedFile, 'already visible')
    await writeFile(restoreFile, 'needs restoration')
    const readFileState = {
      [preservedFile]: { content: 'stale preserved', timestamp: 2 },
      [restoreFile]: { content: 'stale restore', timestamp: 1 },
    }
    const preservedMessages: Message[] = [
      createAssistantMessage({
        content: [{
          type: 'tool_use',
          id: 'read-preserved',
          name: 'Read',
          input: { file_path: preservedFile },
        }],
      }),
    ]

    const result = await createPostCompactFileAttachments(
      readFileState,
      context,
      5,
      preservedMessages,
    )

    expect(result).toHaveLength(1)
    expect((result[0].attachment as any).filename).toBe(restoreFile)
    expect((result[0].attachment as any).content.file.content).toContain('needs restoration')
  })
})
