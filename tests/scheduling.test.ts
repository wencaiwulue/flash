import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'scheduling-config-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

const actualSettings = await import('../src/utils/settings/settings.ts')
mock.module('../src/utils/settings/settings.ts', () => ({
  ...actualSettings,
  getSettings_DEPRECATED: () => ({ minSleepDurationMs: 0, maxSleepDurationMs: -1 }),
}))
mock.module('../src/utils/auth.ts', () => ({
  checkAndRefreshOAuthTokenIfNeeded: async () => {},
  getClaudeAIOAuthTokens: () => ({ accessToken: 'dummy-offline-token' }),
}))
mock.module('../src/services/oauth/client.ts', () => ({
  getOrganizationUUID: async () => 'org-offline',
}))
const axiosRequests: Array<Record<string, unknown>> = []
mock.module('axios', () => ({
  default: {
    request: async (options: Record<string, unknown>) => {
      axiosRequests.push(options)
      return { status: 200, data: { ok: true, action: options.method } }
    },
  },
}))
const sideQueryCalls: Array<Record<string, unknown>> = []
let sideQueryImplementation: (options: Record<string, unknown>) => Promise<unknown>
mock.module('../src/utils/sideQuery.ts', () => ({
  sideQuery: async (options: Record<string, unknown>) => {
    sideQueryCalls.push(options)
    return sideQueryImplementation(options)
  },
}))
mock.module('../src/utils/model/model.ts', () => ({
  getSmallFastModel: () => 'offline-classifier',
}))

const {
  activateProactive,
  deactivateProactive,
  getNextTickAt,
  getProactiveControlState,
  isProactiveActive,
  pauseProactive,
  resumeProactive,
  setContextBlocked,
  setProactiveNextTickAt,
  subscribeToProactiveChanges,
} = await import('../src/proactive/index.ts')
const { SleepTool, resolveSleepDuration } = await import('../src/tools/SleepTool/SleepTool.ts')
const { RemoteTriggerTool } = await import('../src/tools/RemoteTriggerTool/RemoteTriggerTool.ts')
const { classifyAndWriteState } = await import('../src/jobs/classifier.ts')
const {
  createJobDirectory,
  readJobState,
  writeJobState,
} = await import('../src/jobs/state.ts')
const { LOCAL_TEMPLATE_JOBS_VERSION } = await import('../src/jobs/schema.ts')

import type { ToolUseContext } from '../src/Tool.ts'
import type { AssistantMessage } from '../src/types/message.ts'
import type { JobState } from '../src/jobs/schema.ts'

let tempRoot = ''

function toolContext(): ToolUseContext {
  const calls: boolean[] = []
  return {
    abortController: new AbortController(),
    setHasInterruptibleToolInProgress: (value: boolean) => calls.push(value),
    _calls: calls,
  } as unknown as ToolUseContext
}

function assistant(uuid: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      model: 'offline',
      content: [{ type: 'text', text: 'working' }],
      stop_reason: null,
      stop_sequence: null,
    },
  } as AssistantMessage
}

function classification(uuid = 'assistant-1') {
  return {
    category: 'completed',
    summary: 'done',
    confidence: 0.9,
    question: null,
    evidence: { assistant_message_uuids: [uuid], tool_use_ids: [] },
  }
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'scheduling-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
  axiosRequests.length = 0
  sideQueryCalls.length = 0
  sideQueryImplementation = async () => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'classify_job_turn', input: classification() }],
  })
})

afterEach(async () => {
  deactivateProactive()
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

describe('proactive core', () => {
  test('transitions activation, pause, resume, context block and deactivation with subscriptions', () => {
    const states: boolean[] = []
    const unsubscribe = subscribeToProactiveChanges(() => states.push(isProactiveActive()))
    expect(activateProactive('command')).toBe(true)
    expect(activateProactive('command')).toBe(false)
    expect(getProactiveControlState()).toEqual({ active: true, paused: false, contextBlocked: false })

    setProactiveNextTickAt(123)
    expect(getNextTickAt()).toBe(123)
    expect(pauseProactive()).toBe(true)
    expect(getNextTickAt()).toBeNull()
    expect(resumeProactive()).toBe(true)
    expect(setContextBlocked(true)).toBe(true)
    expect(getProactiveControlState()).toEqual({ active: true, paused: false, contextBlocked: true })
    expect(deactivateProactive()).toBe(true)
    expect(getProactiveControlState()).toEqual({ active: false, paused: false, contextBlocked: false })
    expect(deactivateProactive()).toBe(false)

    const count = states.length
    unsubscribe()
    activateProactive('command')
    expect(states.length).toBe(count)
  })
})

describe('SleepTool', () => {
  test('resolves duration bounds and rejects missing or duplicate inputs', async () => {
    expect(resolveSleepDuration(5, { minSleepDurationMs: 10, maxSleepDurationMs: 20 })).toBe(10)
    expect(resolveSleepDuration(25, { minSleepDurationMs: 10, maxSleepDurationMs: 20 })).toBe(20)
    expect(resolveSleepDuration(25, { minSleepDurationMs: 0, maxSleepDurationMs: -1 })).toBe(25)
    expect((await SleepTool.validateInput({})).result).toBe(false)
    expect((await SleepTool.validateInput({ duration: 1, duration_ms: 1 })).result).toBe(false)
  })

  test('sleeps with interruptible flags and reports early abort', async () => {
    const normal = toolContext()
    const normalResult = await SleepTool.call({ duration: 1 }, normal)
    expect(normalResult.data.effectiveMs).toBe(1)
    expect(normalResult.data.interrupted).toBe(false)
    expect(normal._calls).toEqual([true, false])

    const aborted = toolContext()
    aborted.abortController.abort()
    const interrupted = await SleepTool.call({ duration: 1000 }, aborted)
    expect(interrupted.data.interrupted).toBe(true)
    expect(interrupted.data.elapsedMs).toBeLessThan(1000)
    expect(aborted._calls).toEqual([true, false])
  })
})

describe('RemoteTriggerTool', () => {
  test('builds list/run requests with offline auth and returns HTTP status/json', async () => {
    const context = toolContext()
    const listed = await RemoteTriggerTool.call({ action: 'list' }, context)
    expect(listed.data.status).toBe(200)
    expect(JSON.parse(listed.data.json)).toEqual({ ok: true, action: 'GET' })
    expect(axiosRequests[0]).toMatchObject({ method: 'GET', timeout: 20_000 })

    const run = await RemoteTriggerTool.call({ action: 'run', trigger_id: 'trigger-1' }, context)
    expect(JSON.parse(run.data.json)).toEqual({ ok: true, action: 'POST' })
    expect(axiosRequests[1]).toMatchObject({
      method: 'POST',
      data: {},
      headers: {
        Authorization: 'Bearer dummy-offline-token',
        'anthropic-beta': 'ccr-triggers-2026-01-30',
        'x-organization-uuid': 'org-offline',
      },
    })
    expect(String(axiosRequests[1]!.url)).toContain('/v1/code/triggers/trigger-1/run')
  })

  test('rejects missing trigger_id or body before making an HTTP request', async () => {
    const context = toolContext()
    await expect(RemoteTriggerTool.call({ action: 'get' }, context)).rejects.toThrow('get requires trigger_id')
    await expect(RemoteTriggerTool.call({ action: 'create' }, context)).rejects.toThrow('create requires body')
    await expect(RemoteTriggerTool.call({ action: 'update', trigger_id: 'x' }, context)).rejects.toThrow('update requires body')
    expect(axiosRequests).toHaveLength(0)
  })
})

describe('jobs classifier', () => {
  test('writes a valid high-confidence classification without changing process fields', async () => {
    const directory = await createJobDirectory('00000000-0000-4000-8000-000000000001')
    const now = new Date().toISOString()
    const initial: JobState = {
      version: LOCAL_TEMPLATE_JOBS_VERSION,
      job_id: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      generation: 1,
      active_reply_id: null,
      pid: 1234,
      started_at: now,
      updated_at: now,
      ended_at: null,
      exit_code: null,
      classification: null,
      last_error: null,
    }
    await writeJobState(directory, initial)

    await classifyAndWriteState(directory, [assistant('assistant-1')])
    const state = await readJobState(directory)
    expect(state.status).toBe('running')
    expect(state.pid).toBe(1234)
    expect(state.classification).toMatchObject({
      category: 'completed',
      confidence: 0.9,
      generation: 1,
      model: 'offline-classifier',
      status: 'ok',
    })
    expect(sideQueryCalls).toHaveLength(1)
  })

  test('leaves the last good state unchanged when evidence is invalid', async () => {
    const directory = await createJobDirectory('00000000-0000-4000-8000-000000000001')
    const now = new Date().toISOString()
    const initial: JobState = {
      version: LOCAL_TEMPLATE_JOBS_VERSION,
      job_id: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      generation: 1,
      active_reply_id: null,
      pid: 1234,
      started_at: now,
      updated_at: now,
      ended_at: null,
      exit_code: null,
      classification: null,
      last_error: null,
    }
    await writeJobState(directory, initial)
    sideQueryImplementation = async () => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'classify_job_turn', input: classification('not-present') }],
    })

    await classifyAndWriteState(directory, [assistant('assistant-1')])
    expect(await readJobState(directory)).toEqual(initial)
  })

  test('marks low confidence stale and ignores a result from an older generation', async () => {
    const directory = await createJobDirectory('00000000-0000-4000-8000-000000000001')
    const now = new Date().toISOString()
    const initial: JobState = {
      version: LOCAL_TEMPLATE_JOBS_VERSION,
      job_id: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      generation: 1,
      active_reply_id: null,
      pid: 1234,
      started_at: now,
      updated_at: now,
      ended_at: null,
      exit_code: null,
      classification: null,
      last_error: null,
    }
    await writeJobState(directory, initial)
    sideQueryImplementation = async () => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'classify_job_turn', input: { ...classification(), confidence: 0.2 } }],
    })

    await classifyAndWriteState(directory, [assistant('assistant-1')])
    const stale = await readJobState(directory)
    expect(stale.classification).toMatchObject({ status: 'stale', error_code: 'LOW_CONFIDENCE' })

    sideQueryImplementation = async () => {
      await writeJobState(directory, { ...stale, generation: 2 })
      return {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'classify_job_turn', input: classification() }],
      }
    }
    await classifyAndWriteState(directory, [assistant('assistant-1')])
    expect((await readJobState(directory)).generation).toBe(2)
    expect((await readJobState(directory)).classification).toEqual(stale.classification)
  })
})
