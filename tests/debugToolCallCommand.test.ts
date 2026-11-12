import { describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import debugToolCall from '../src/commands/debug-tool-call/index.ts'
import {
  collectToolCalls,
  formatSavedToolCalls,
  inspectSavedInputSchema,
} from '../src/commands/debug-tool-call/inspection.ts'
import type { Tool } from '../src/Tool.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'
import type { Message } from '../src/types/message.ts'

function assistant(id: string, name = 'Read', input: unknown = { file_path: '/tmp/a' }): Message {
  return {
    type: 'assistant', uuid: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id: randomUUID(), type: 'message', role: 'assistant', model: 'test', stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as Message
}

function result(id: string, content: unknown, isError = false): Message {
  return {
    type: 'user', uuid: randomUUID(), timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  } as Message
}

describe('/debug-tool-call', () => {
  test('registers a real read-only JSX command with lazy missing-id handling', async () => {
    expect(debugToolCall.name).toBe('debug-tool-call')
    expect(debugToolCall.isHidden).not.toBe(true)
    const { call } = await debugToolCall.load()
    let output = ''
    await call(
      value => { output = value ?? '' },
      { messages: [], options: { tools: [] } } as LocalJSXCommandContext,
      'missing',
    )
    expect(output).toContain('No saved tool_use')
  })

  test('pairs success, failure, missing, and duplicate ids without replay', () => {
    const calls = collectToolCalls([
      assistant('duplicate'), assistant('duplicate'), result('duplicate', 'ok'),
      result('duplicate', 'failure', true), assistant('missing'),
    ])
    expect(calls).toHaveLength(3)
    expect(calls[0]?.results).toHaveLength(2)
    expect(calls[1]?.results[1]?.isError).toBe(true)
    expect(calls[2]?.results).toHaveLength(0)
    const text = formatSavedToolCalls(calls, [], false)
    expect(text).toContain('Result 2/2: error')
    expect(text).toContain('Result: missing')
    expect(text).toContain('elapsed=1000ms')
    expect(text).toContain('no replay')
  })

  test('validates saved input with schemas only and never calls execution or permission paths', () => {
    const execution = mock(async () => ({}))
    const permissions = mock(async () => ({}))
    const validateInput = mock(async () => ({ result: true }))
    const tool = {
      name: 'Read',
      inputSchema: z.object({ file_path: z.string() }),
      call: execution,
      checkPermissions: permissions,
      validateInput,
    } as unknown as Tool
    const valid = collectToolCalls([assistant('one')])[0]!
    const invalid = collectToolCalls([assistant('two', 'Read', { file_path: 42 })])[0]!
    expect(inspectSavedInputSchema(valid, tool).status).toBe('valid')
    expect(inspectSavedInputSchema(invalid, tool).status).toBe('invalid')
    formatSavedToolCalls([valid, invalid], [tool], true)
    expect(execution).not.toHaveBeenCalled()
    expect(permissions).not.toHaveBeenCalled()
    expect(validateInput).not.toHaveBeenCalled()
  })

  test('shows MCP names and truncates large saved results', () => {
    const mcpTool = {
      name: 'mcp__server__lookup',
      mcpInfo: { serverName: 'server', toolName: 'lookup' },
      inputJSONSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    } as Tool
    const call = collectToolCalls([
      assistant('mcp-1', 'mcp__server__lookup', { query: 3 }),
      result('mcp-1', 'x'.repeat(5000)),
    ])[0]!
    expect(inspectSavedInputSchema(call, mcpTool).status).toBe('invalid')
    const output = formatSavedToolCalls([call], [mcpTool], true)
    expect(output).toContain('MCP server/lookup')
    expect(output).toContain('truncated 1000 characters')
  })
})
