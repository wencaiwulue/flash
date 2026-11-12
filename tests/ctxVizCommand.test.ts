import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import ctxViz from '../src/commands/ctx_viz/index.ts'
import { analyzeContextViz } from '../src/commands/ctx_viz/ctx_viz.tsx'
import {
  buildContextVizExport,
  buildMessageTokenRows,
} from '../src/commands/ctx_viz/messageTokens.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'
import type { Message } from '../src/types/message.ts'
import type { ContextData } from '../src/utils/analyzeContext.ts'
import { writeNewDiagnosticJson } from '../src/utils/diagnosticExport.ts'

function user(text: string): Message {
  return {
    type: 'user', uuid: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  }
}

function assistantWithTool(): Message {
  return {
    type: 'assistant', uuid: randomUUID(), timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      id: 'msg_test', type: 'message', role: 'assistant', model: 'test', stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/secret' } }],
    },
  } as Message
}

function contextData(messageTokens: number): ContextData {
  return {
    categories: [{ name: 'Messages', tokens: messageTokens, color: 'purple_FOR_SUBAGENTS_ONLY' }],
    totalTokens: messageTokens,
    maxTokens: 100,
    rawMaxTokens: 100,
    percentage: messageTokens,
    gridRows: [],
    model: 'test-model',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: false,
    apiUsage: null,
  }
}

describe('/ctx_viz', () => {
  test('registers real JSX metadata and lazy usage handling', async () => {
    expect(ctxViz.name).toBe('ctx_viz')
    expect(ctxViz.isHidden).not.toBe(true)
    const { call } = await ctxViz.load()
    let output = ''
    await call(value => { output = value ?? '' }, {} as LocalJSXCommandContext, '--bad')
    expect(output).toContain('Usage: /ctx_viz')
  })

  test('per-message rows sum to the exact shared message total and handle empty contexts', () => {
    const messages = [user('a'.repeat(20)), assistantWithTool(), user('tool result')]
    const rows = buildMessageTokenRows(messages, 101)
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(101)
    expect(rows[1]?.category).toBe('tool-call')
    expect(buildMessageTokenRows([], 0)).toEqual([])
    expect(buildMessageTokenRows(messages, 0).every(row => row.tokens === 0)).toBe(true)
  })

  test('uses the /context API view and microcompact view without mutating messages', async () => {
    const original = [user('private body'), assistantWithTool()]
    const before = JSON.stringify(original)
    const apiView = [...original]
    const microcompact = mock(async (messages: Message[]) => ({ messages }))
    const analyze = mock(async () => contextData(17))
    const context = {
      messages: original,
      getAppState: () => ({ toolPermissionContext: {}, agentDefinitions: {} }),
      options: { mainLoopModel: 'test-model', tools: [] },
    } as unknown as LocalJSXCommandContext
    const result = await analyzeContextViz(context, {
      toApiView: messages => {
        expect(messages).toBe(original)
        return apiView
      },
      microcompactMessages: microcompact as never,
      analyzeContextUsage: analyze as never,
    })
    expect(result.data.totalTokens).toBe(17)
    expect(result.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(17)
    expect(microcompact).toHaveBeenCalledWith(apiView)
    expect(JSON.stringify(original)).toBe(before)
  })

  test('JSON has no message body, attachment, tool input, or overwrite behavior', async () => {
    const rows = buildMessageTokenRows([user('sensitive body'), assistantWithTool()], 9)
    const exported = buildContextVizExport(contextData(9), rows)
    const serialized = JSON.stringify(exported)
    expect(serialized).not.toContain('sensitive body')
    expect(serialized).not.toContain('/secret')
    expect(serialized).not.toContain('file_path')
    expect(exported.messages.reduce((sum, row) => sum + row.tokens, 0)).toBe(9)
    const dir = await mkdtemp(join(tmpdir(), 'claude-ctx-viz-'))
    try {
      const path = join(dir, 'context.json')
      await writeNewDiagnosticJson(path, exported)
      expect(JSON.parse(await readFile(path, 'utf8')).messages).toHaveLength(2)
      await expect(writeNewDiagnosticJson(path, exported)).rejects.toThrow()
      await expect(writeNewDiagnosticJson(join(dir, 'missing', 'context.json'), exported)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
