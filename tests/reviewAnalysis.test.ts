import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'review-analysis-config-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

const contextFixture = {
  model: 'offline-model',
  totalTokens: 120,
  maxTokens: 200,
  rawMaxTokens: 240,
  percentage: 60,
  categories: [
    { name: 'messages', tokens: 100, isDeferred: false },
    { name: 'tools', tokens: 20, isDeferred: true },
  ],
  messageBreakdown: { user: 2, assistant: 3 },
  apiUsage: { inputTokens: 10, outputTokens: 5 },
}
mock.module('../src/commands/context/context-noninteractive.ts', () => ({
  collectContextData: async () => contextFixture,
}))

const { CtxInspectTool } = await import('../src/tools/CtxInspectTool/CtxInspectTool.ts')
const {
  deduplicateSessionBranches,
  loadCachedSessionMeta,
  logToSessionMeta,
  saveSessionMeta,
} = await import('../src/commands/insights/sessionMeta.ts')
const { detectMultiClauding } = await import('../src/commands/insights.ts')

import type { LogOption } from '../src/types/logs.ts'
import type { ToolUseContext } from '../src/Tool.ts'

let tempRoot = ''
const sessionId = '00000000-0000-4000-8000-000000000001'

function timestamp(hour: number, minute: number, second: number) {
  return `2026-01-01T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`
}

function userMessage(content: unknown, timestamp: string) {
  return {
    type: 'user',
    uuid: `user-${timestamp}`,
    timestamp,
    message: { role: 'user', content },
  }
}

function assistantMessage(
  content: unknown,
  timestamp: string,
  usage?: { input_tokens: number; output_tokens: number },
) {
  return {
    type: 'assistant',
    uuid: `assistant-${timestamp}`,
    timestamp,
    message: {
      id: `assistant-${timestamp}`,
      type: 'message',
      role: 'assistant',
      model: 'offline-model',
      content,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  }
}

function sampleLog(): LogOption {
  const created = new Date('2026-01-01T10:00:00Z')
  const modified = new Date('2026-01-01T10:05:00Z')
  return {
    sessionId,
    created,
    modified,
    projectPath: '/tmp/offline-project',
    firstPrompt: 'fix bug',
    summary: 'offline summary',
    messages: [
      userMessage('fix bug', timestamp(10, 0, 0)),
      assistantMessage(
        [
          {
            type: 'tool_use',
            id: 'edit-1',
            name: 'Edit',
            input: { file_path: '/tmp/a.ts', old_string: 'a\n', new_string: 'b\n' },
          },
          {
            type: 'tool_use',
            id: 'bash-1',
            name: 'Bash',
            input: { command: 'git commit && git push' },
          },
        ],
        timestamp(10, 0, 5),
        { input_tokens: 5, output_tokens: 7 },
      ),
      userMessage(
        [
          {
            type: 'tool_result',
            tool_use_id: 'bash-1',
            content: 'exit code 1',
            is_error: true,
          },
        ],
        timestamp(10, 0, 10),
      ),
      userMessage('try again', timestamp(10, 0, 20)),
      assistantMessage('done', timestamp(10, 0, 25), {
        input_tokens: 2,
        output_tokens: 3,
      }),
      userMessage('[Request interrupted by user]', timestamp(10, 0, 30)),
    ],
  } as LogOption
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'review-analysis-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(moduleIsolationRoot, { recursive: true, force: true })
})

describe('CtxInspectTool', () => {
  test('returns model, token, deferred, message and API categories without gridRows', async () => {
    const result = await CtxInspectTool.call({}, {} as ToolUseContext)
    const report = JSON.parse(result.data.report)

    expect(report.model).toBe('offline-model')
    expect(report.totalTokens).toBe(120)
    expect(report.maxTokens).toBe(200)
    expect(report.rawMaxTokens).toBe(240)
    expect(report.percentage).toBe(60)
    expect(report.categories).toEqual([
      { name: 'messages', tokens: 100, deferred: false },
      { name: 'tools', tokens: 20, deferred: true },
    ])
    expect(report.messageBreakdown).toEqual({ user: 2, assistant: 3 })
    expect(report.apiUsage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(report.contextCollapse).toBeDefined()
    expect(report.gridRows).toBeUndefined()
  })
})

describe('insights session metadata', () => {
  test('extracts real message/tool/error/timing statistics', () => {
    const meta = logToSessionMeta(sampleLog())

    expect(meta).toMatchObject({
      session_id: sessionId,
      project_path: '/tmp/offline-project',
      duration_minutes: 5,
      user_message_count: 3,
      assistant_message_count: 2,
      tool_counts: { Edit: 1, Bash: 1 },
      languages: { TypeScript: 1 },
      git_commits: 1,
      git_pushes: 1,
      input_tokens: 7,
      output_tokens: 10,
      user_interruptions: 1,
      user_response_times: [15, 5],
      tool_errors: 1,
      tool_error_categories: { 'Command Failed': 1 },
      uses_task_agent: false,
      uses_mcp: false,
      uses_web_search: false,
      uses_web_fetch: false,
      lines_added: 1,
      lines_removed: 1,
      files_modified: 1,
      message_hours: [10, 10, 10],
    })
    expect(meta.user_message_timestamps).toEqual([
      timestamp(10, 0, 0),
      timestamp(10, 0, 20),
      timestamp(10, 0, 30),
    ])
  })

  test('deduplicates branches by user messages then duration', () => {
    const base = logToSessionMeta(sampleLog())
    const shorter = { ...base, user_message_count: 1, duration_minutes: 20 }
    const longer = { ...base, user_message_count: 2, duration_minutes: 5 }
    const longest = { ...base, user_message_count: 2, duration_minutes: 10 }
    const entries = [
      { log: sampleLog(), meta: shorter },
      { log: sampleLog(), meta: longer },
      { log: sampleLog(), meta: longest },
    ]

    expect(deduplicateSessionBranches(entries)).toHaveLength(1)
    expect(deduplicateSessionBranches(entries)[0]?.meta.duration_minutes).toBe(10)
    expect(deduplicateSessionBranches(entries)[0]?.meta.user_message_count).toBe(2)
  })

  test('persists SessionMeta atomically and reloads only valid cache entries', async () => {
    const meta = logToSessionMeta(sampleLog())
    await saveSessionMeta(meta)
    const path = join(tempRoot, 'config', 'usage-data', 'session-meta', `${sessionId}.json`)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await loadCachedSessionMeta(sessionId)).toEqual(meta)
    expect(await loadCachedSessionMeta('not-a-session-id')).toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf8')).session_id).toBe(sessionId)
  })
})

describe('multi-clauding detection', () => {
  test('detects A→B→A within thirty minutes without counting unrelated sessions', () => {
    const result = detectMultiClauding([
      { session_id: 'a', user_message_timestamps: [timestamp(10, 0, 0), timestamp(10, 20, 0)] },
      { session_id: 'b', user_message_timestamps: [timestamp(10, 10, 0)] },
      { session_id: 'c', user_message_timestamps: [timestamp(12, 0, 0)] },
    ])
    expect(result).toEqual({ overlap_events: 1, sessions_involved: 2, user_messages_during: 3 })

    expect(
      detectMultiClauding([
        { session_id: 'a', user_message_timestamps: [timestamp(10, 0, 0)] },
        { session_id: 'b', user_message_timestamps: [timestamp(10, 10, 0)] },
      ]),
    ).toEqual({ overlap_events: 0, sessions_involved: 0, user_messages_during: 0 })
  })
})
