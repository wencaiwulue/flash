import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AssistantMessage } from '../src/types/message.ts'
import type { JobClassification, JobState } from '../src/jobs/schema.ts'

const sideQueryMock = mock()
mock.module('../src/utils/sideQuery.ts', () => ({ sideQuery: sideQueryMock }))

let classifier: typeof import('../src/jobs/classifier.ts')
let stateModule: typeof import('../src/jobs/state.ts')
let mergeProcessOutcome: typeof import('../src/jobs/supervisor.ts').mergeProcessOutcome

beforeAll(async () => {
  classifier = await import('../src/jobs/classifier.ts')
  stateModule = await import('../src/jobs/state.ts')
  ;({ mergeProcessOutcome } = await import('../src/jobs/supervisor.ts'))
})

const temporaryDirectories: string[] = []
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  sideQueryMock.mockReset()
})

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
})

const jobId = randomUUID()
const startedAt = '2026-11-11T00:00:00.000Z'

function makeState(overrides: Partial<JobState> = {}): JobState {
  return {
    version: 'local-template-jobs-v1',
    job_id: jobId,
    status: 'running',
    generation: 3,
    active_reply_id: null,
    pid: 4242,
    started_at: startedAt,
    updated_at: startedAt,
    ended_at: null,
    exit_code: null,
    classification: null,
    last_error: null,
    ...overrides,
  }
}

function storedClassification(
  overrides: Partial<JobClassification> = {},
): JobClassification {
  return {
    category: 'completed',
    summary: 'Last good classification',
    confidence: 0.95,
    question: null,
    evidence: { assistant_message_uuids: [], tool_use_ids: [] },
    classified_at: startedAt,
    generation: 3,
    model: 'test-model',
    status: 'ok',
    ...overrides,
  }
}

async function fixture(state = makeState()): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), 'claude-job-classifier-'))
  temporaryDirectories.push(configDir)
  process.env.CLAUDE_CONFIG_DIR = configDir
  const jobDirectory = join(configDir, 'jobs', jobId)
  await mkdir(jobDirectory, { recursive: true, mode: 0o700 })
  await stateModule.writeJobState(jobDirectory, state)
  return jobDirectory
}

function assistant(
  text = 'The requested work is complete',
  withTool = false,
): AssistantMessage {
  const uuid = randomUUID()
  return {
    type: 'assistant',
    uuid,
    timestamp: startedAt,
    message: {
      content: [
        { type: 'text', text },
        ...(withTool
          ? [
              {
                type: 'tool_use',
                id: 'toolu_test_1',
                name: 'Bash',
                input: { command: 'do-not-forward-tool-input' },
              },
            ]
          : []),
      ],
    },
  } as unknown as AssistantMessage
}

function modelClassification(
  message: AssistantMessage,
  overrides: Record<string, unknown> = {},
) {
  return {
    category: 'completed',
    summary: 'Finished the requested work',
    confidence: 0.95,
    question: null,
    evidence: {
      assistant_message_uuids: [message.uuid],
      tool_use_ids: [],
    },
    ...overrides,
  }
}

function response(input: unknown) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'classify_job_turn', input }],
  }
}

describe('job classifier structured state', () => {
  test('writes bounded structured classification without overriding an active process', async () => {
    const message = assistant('Finished', true)
    const jobDirectory = await fixture()
    sideQueryMock.mockResolvedValue(response(modelClassification(message)))

    await classifier.classifyAndWriteState(jobDirectory, [message])
    const next = await stateModule.readJobState(jobDirectory)
    expect(next).toMatchObject({
      status: 'running',
      pid: 4242,
      generation: 3,
      exit_code: null,
      ended_at: null,
      classification: {
        category: 'completed',
        status: 'ok',
        generation: 3,
        evidence: {
          assistant_message_uuids: [message.uuid],
          tool_use_ids: [],
        },
      },
    })
    expect(next.updated_at).not.toBe(startedAt)

    const request = sideQueryMock.mock.calls[0]![0]
    expect(request.querySource).toBe('job_classifier')
    expect(request.tool_choice).toEqual({
      type: 'tool',
      name: 'classify_job_turn',
    })
    expect(request.tools[0].input_schema.additionalProperties).toBe(false)
    expect(request.skipSystemPromptPrefix).toBe(true)
    expect(request.temperature).toBe(0)
    expect(request.thinking).toBe(false)
    expect(Buffer.byteLength(request.messages[0].content, 'utf8')).toBeLessThanOrEqual(
      64 * 1024,
    )
    expect(request.messages[0].content).not.toContain(
      'do-not-forward-tool-input',
    )
    expect(JSON.parse(request.messages[0].content).messages[0].tool_uses[0]).toEqual({
      id: 'toolu_test_1',
      name: 'Bash',
      status: 'requested',
    })
  })

  test('bounds a very large turn payload', async () => {
    const message = assistant('x'.repeat(100_000))
    const jobDirectory = await fixture()
    sideQueryMock.mockResolvedValue(response(modelClassification(message)))
    await classifier.classifyAndWriteState(jobDirectory, [message])
    expect(
      Buffer.byteLength(
        sideQueryMock.mock.calls[0]![0].messages[0].content,
        'utf8',
      ),
    ).toBeLessThanOrEqual(64 * 1024)
  })

  test('empty turns preserve state and avoid a model call', async () => {
    const initial = makeState({ classification: storedClassification() })
    const jobDirectory = await fixture(initial)
    await classifier.classifyAndWriteState(jobDirectory, [])
    expect(sideQueryMock).not.toHaveBeenCalled()
    expect(await stateModule.readJobState(jobDirectory)).toEqual(initial)
  })

  test('low confidence is stale and cannot produce completed process state', async () => {
    const message = assistant()
    const jobDirectory = await fixture()
    sideQueryMock.mockResolvedValue(
      response(modelClassification(message, { confidence: 0.69 })),
    )
    await classifier.classifyAndWriteState(jobDirectory, [message])
    const classified = await stateModule.readJobState(jobDirectory)
    expect(classified.classification).toMatchObject({
      status: 'stale',
      error_code: 'LOW_CONFIDENCE',
      confidence: 0.69,
    })
    expect(classified.status).toBe('running')
    const exited = mergeProcessOutcome(classified, 0)
    expect(exited.status).toBe('waiting_for_input')
    expect(exited.classification?.status).toBe('stale')
  })

  test.each([
    [
      'needs_input',
      'waiting_for_input',
      { category: 'needs_input', question: 'Continue?' },
    ],
    ['blocked', 'blocked', { category: 'blocked' }],
    ['completed', 'completed', { category: 'completed' }],
    ['failed', 'failed', { category: 'failed' }],
    ['in_progress', 'waiting_for_input', { category: 'in_progress' }],
  ] as const)('normal exit maps %s to %s deterministically', async (_category, expected, overrides) => {
    const message = assistant()
    const jobDirectory = await fixture()
    sideQueryMock.mockResolvedValue(
      response(modelClassification(message, overrides)),
    )
    await classifier.classifyAndWriteState(jobDirectory, [message])
    const exited = mergeProcessOutcome(
      await stateModule.readJobState(jobDirectory),
      0,
    )
    expect(exited.status).toBe(expected)
    expect(exited.exit_code).toBe(0)
    expect(exited.pid).toBeNull()
  })

  test('nonzero process exit wins over a model completed suggestion', async () => {
    const message = assistant()
    const jobDirectory = await fixture()
    sideQueryMock.mockResolvedValue(response(modelClassification(message)))
    await classifier.classifyAndWriteState(jobDirectory, [message])
    const exited = mergeProcessOutcome(
      await stateModule.readJobState(jobDirectory),
      17,
    )
    expect(exited.status).toBe('failed')
    expect(exited.exit_code).toBe(17)
    expect(exited.classification?.category).toBe('completed')
    expect(exited.last_error?.code).toBe('CHILD_EXIT')
  })
})

describe('job classifier failure and generation safety', () => {
  test.each([
    ['no tool call', { stop_reason: 'end_turn', content: [] }],
    [
      'unknown field',
      response({ category: 'completed', extra: true }),
    ],
    [
      'forged evidence',
      response({
        category: 'completed',
        summary: 'done',
        confidence: 1,
        question: null,
        evidence: {
          assistant_message_uuids: [randomUUID()],
          tool_use_ids: [],
        },
      }),
    ],
    [
      'confidence out of range',
      response({
        category: 'completed',
        summary: 'done',
        confidence: 1.2,
        question: null,
        evidence: { assistant_message_uuids: [], tool_use_ids: [] },
      }),
    ],
    [
      'text JSON',
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"category":"completed"}' }],
      },
    ],
  ])('invalid output (%s) preserves the last good state', async (_name, modelResponse) => {
    const initial = makeState({ classification: storedClassification() })
    const jobDirectory = await fixture(initial)
    sideQueryMock.mockResolvedValue(modelResponse)
    await classifier.classifyAndWriteState(jobDirectory, [assistant()])
    expect(await stateModule.readJobState(jobDirectory)).toEqual(initial)
  })

  test('API failure preserves the last good state byte-for-byte', async () => {
    const initial = makeState({ classification: storedClassification() })
    const jobDirectory = await fixture(initial)
    const statePath = stateModule.getJobPaths(jobDirectory).state
    const before = await readFile(statePath, 'utf8')
    sideQueryMock.mockRejectedValue(new Error('service unavailable'))
    await classifier.classifyAndWriteState(jobDirectory, [assistant()])
    expect(await readFile(statePath, 'utf8')).toBe(before)
  })

  test('API failure with no prior classification falls back to waiting, never completed', async () => {
    const initial = makeState()
    const jobDirectory = await fixture(initial)
    sideQueryMock.mockRejectedValue(new Error('timeout'))
    await classifier.classifyAndWriteState(jobDirectory, [assistant()])
    const preserved = await stateModule.readJobState(jobDirectory)
    expect(preserved).toEqual(initial)
    const exited = mergeProcessOutcome(preserved, 0)
    expect(exited.status).toBe('waiting_for_input')
    expect(exited.classification?.status).toBe('unavailable')
  })

  test('a late result cannot overwrite a newer generation', async () => {
    const message = assistant()
    const initial = makeState()
    const jobDirectory = await fixture(initial)
    let resolveQuery!: (value: unknown) => void
    sideQueryMock.mockImplementation(
      () => new Promise(resolve => (resolveQuery = resolve)),
    )
    const pending = classifier.classifyAndWriteState(jobDirectory, [message])
    for (let index = 0; index < 100 && sideQueryMock.mock.calls.length === 0; index++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(sideQueryMock).toHaveBeenCalledTimes(1)

    const newer = makeState({
      generation: 4,
      updated_at: '2026-11-11T00:01:00.000Z',
    })
    await stateModule.writeJobState(jobDirectory, newer)
    resolveQuery(response(modelClassification(message)))
    await pending
    expect(await stateModule.readJobState(jobDirectory)).toEqual(newer)
  })

  test('corrupt state is reported and never replaced by a model result', async () => {
    const jobDirectory = await fixture()
    const statePath = stateModule.getJobPaths(jobDirectory).state
    await writeFile(statePath, '{partial', 'utf8')
    await expect(
      classifier.classifyAndWriteState(jobDirectory, [assistant()]),
    ).rejects.toMatchObject({ code: 'JOB_CORRUPT' })
    expect(sideQueryMock).not.toHaveBeenCalled()
    expect(await readFile(statePath, 'utf8')).toBe('{partial')
  })

  test('successful writes are atomic and leave no temporary state files', async () => {
    const message = assistant()
    const jobDirectory = await fixture()
    sideQueryMock.mockResolvedValue(response(modelClassification(message)))
    await classifier.classifyAndWriteState(jobDirectory, [message])
    const raw = await readFile(stateModule.getJobPaths(jobDirectory).state, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const files = await import('fs/promises').then(({ readdir }) =>
      readdir(jobDirectory),
    )
    expect(files.filter(file => file.endsWith('.tmp'))).toEqual([])
  })
})
