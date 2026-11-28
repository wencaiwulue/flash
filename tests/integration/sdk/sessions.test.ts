import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SDKMessage,
  SDKResultSuccess,
} from '../../../src/entrypoints/sdk/coreTypes.js'
import type { Options } from '../../../src/entrypoints/sdk/runtimeTypes.js'
import {
  canonicalizePath,
  sanitizePath,
} from '../../../src/utils/sessionStoragePortable.ts'
import { createResponseGate } from '../support/mock-anthropic.ts'
import {
  createSdkHarness,
  withDeadline,
  type SdkHarness,
} from '../support/sdk.ts'

const TEST_TIMEOUT_MS = 25_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type QueryRun = {
  messages: SDKMessage[]
  sessionId: string
  result: SDKResultSuccess
}

async function classicOptions(
  harness: SdkHarness,
  options: Options = {},
): Promise<Options> {
  return {
    ...harness.baseOptions,
    cwd: await canonicalizePath(harness.sandbox.project),
    tools: [],
    ...options,
  }
}

function successResult(messages: SDKMessage[]): SDKResultSuccess | undefined {
  return messages.find(
    (message): message is SDKResultSuccess =>
      message.type === 'result' && message.subtype === 'success',
  )
}

function initSessionId(messages: SDKMessage[]): string | undefined {
  return messages.find(
    message => message.type === 'system' && message.subtype === 'init',
  )?.session_id
}

async function runText(
  harness: SdkHarness,
  prompt: string,
  response: string,
  options: Options = {},
): Promise<QueryRun> {
  harness.mock.enqueue({ type: 'text', text: response })
  const query = harness.track(harness.sdk.query({
    prompt,
    options: await classicOptions(harness, options),
  }))
  const { messages, error } = await harness.collect(query)
  expect(error).toBeUndefined()
  const result = successResult(messages)
  expect(result).toBeDefined()
  expect(result).toMatchObject({ is_error: false, result: response })
  const sessionId = initSessionId(messages)
  expect(sessionId).toMatch(UUID_PATTERN)
  expect(result!.session_id).toBe(sessionId)
  return { messages, sessionId: sessionId!, result: result! }
}

function modelRequests(harness: SdkHarness) {
  return harness.mock.requests.filter(request => request.path === '/v1/messages')
}

function requestMessages(harness: SdkHarness, index: number): string {
  const request = modelRequests(harness)[index]
  expect(request).toBeDefined()
  return JSON.stringify(request!.body?.messages)
}

async function projectTranscriptDirs(harness: SdkHarness): Promise<string[]> {
  const projects = join(harness.sandbox.home, '.claude', 'projects')
  const canonical = await canonicalizePath(harness.sandbox.project)
  return [...new Set([harness.sandbox.project, canonical])].map(project =>
    join(projects, sanitizePath(project)),
  )
}

async function transcriptPath(
  harness: SdkHarness,
  sessionId: string,
): Promise<string> {
  const candidates = (await projectTranscriptDirs(harness)).map(dir =>
    join(dir, `${sessionId}.jsonl`),
  )
  for (const candidate of candidates) {
    try {
      await stat(candidate)
      return candidate
    } catch {
      // The writer may use either the supplied cwd or its canonical form.
    }
  }
  return candidates[0]!
}

async function readTranscript(
  harness: SdkHarness,
  sessionId: string,
): Promise<string> {
  return readFile(await transcriptPath(harness, sessionId), 'utf8')
}

async function snapshotTranscripts(
  harness: SdkHarness,
): Promise<Array<[string, string]>> {
  const snapshots: Array<[string, string]> = []
  for (const dir of await projectTranscriptDirs(harness)) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const name of names.filter(name => name.endsWith('.jsonl')).sort()) {
      snapshots.push([
        join(dir, name),
        (await readFile(join(dir, name))).toString('base64'),
      ])
    }
  }
  return snapshots.sort(([left], [right]) => left.localeCompare(right))
}

async function collectExpectedError(
  harness: SdkHarness,
  options: Options,
): Promise<{ messages: SDKMessage[]; error: unknown }> {
  // Setup failures reject the query's cleanup promise as well. Consume that
  // rejection explicitly instead of making the shared harness close it again.
  const query = harness.sdk.query({
    prompt: 'This prompt must not reach the model.',
    options: await classicOptions(harness, options),
  })
  try {
    return await harness.collect(query)
  } finally {
    await query.return(undefined).catch(() => {})
  }
}

describe('classic SDK query sessions', () => {
  test('allocates a fresh UUID per query and keeps their transcripts separate', async () => {
    const harness = await createSdkHarness()
    try {
      const firstPrompt = 'SDK_34A_FRESH_FIRST_PROMPT'
      const firstResponse = 'SDK_34A_FRESH_FIRST_RESPONSE'
      const secondPrompt = 'SDK_34A_FRESH_SECOND_PROMPT'
      const secondResponse = 'SDK_34A_FRESH_SECOND_RESPONSE'
      const first = await runText(harness, firstPrompt, firstResponse)
      const second = await runText(harness, secondPrompt, secondResponse)

      expect(first.sessionId).toMatch(UUID_PATTERN)
      expect(second.sessionId).toMatch(UUID_PATTERN)
      expect(second.sessionId).not.toBe(first.sessionId)
      const firstTranscript = await readTranscript(harness, first.sessionId)
      const secondTranscript = await readTranscript(harness, second.sessionId)
      expect(firstTranscript).toContain(firstPrompt)
      expect(firstTranscript).toContain(firstResponse)
      expect(firstTranscript).not.toContain(secondPrompt)
      expect(firstTranscript).not.toContain(secondResponse)
      expect(secondTranscript).toContain(secondPrompt)
      expect(secondTranscript).toContain(secondResponse)
      expect(secondTranscript).not.toContain(firstPrompt)
      expect(secondTranscript).not.toContain(firstResponse)
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('rejects incompatible options and resumeSessionAt without observable side effects', async () => {
    const harness = await createSdkHarness()
    try {
      await runText(
        harness,
        'SDK_34A_VALIDATION_BASELINE',
        'SDK_34A_VALIDATION_BASELINE_RESPONSE',
      )
      const beforeFiles = await snapshotTranscripts(harness)
      const beforeRequests = modelRequests(harness).length
      const cases: Array<{ options: Options; diagnostic: RegExp }> = [
        {
          options: { continue: true, resume: randomUUID() },
          diagnostic: /continue.*resume.*mutually exclusive/i,
        },
        {
          options: { resume: randomUUID(), resumeSessionAt: randomUUID() },
          diagnostic: /resumeSessionAt.*not supported/i,
        },
        {
          options: { resumeSessionAt: randomUUID() },
          diagnostic: /resumeSessionAt.*not supported/i,
        },
      ]

      for (const { options, diagnostic } of cases) {
        const { messages, error } = await collectExpectedError(harness, options)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(diagnostic)
        expect(messages).toEqual([])
        expect(modelRequests(harness)).toHaveLength(beforeRequests)
        expect(await snapshotTranscripts(harness)).toEqual(beforeFiles)
      }
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('resumes the requested ID and sends its user and assistant history', async () => {
    const harness = await createSdkHarness()
    try {
      const firstPrompt = 'SDK_34A_RESUME_ORIGINAL_PROMPT'
      const firstResponse = 'SDK_34A_RESUME_ORIGINAL_RESPONSE'
      const secondPrompt = 'SDK_34A_RESUME_NEXT_PROMPT'
      const secondResponse = 'SDK_34A_RESUME_NEXT_RESPONSE'
      const source = await runText(harness, firstPrompt, firstResponse)
      const resumed = await runText(harness, secondPrompt, secondResponse, {
        resume: source.sessionId,
      })

      expect(resumed.sessionId).toBe(source.sessionId)
      const secondRequest = requestMessages(harness, 1)
      expect(secondRequest).toContain(firstPrompt)
      expect(secondRequest).toContain(firstResponse)
      expect(secondRequest).toContain(secondPrompt)
      const transcript = await readTranscript(harness, source.sessionId)
      expect(transcript).toContain(firstResponse)
      expect(transcript).toContain(secondPrompt)
      expect(transcript).toContain(secondResponse)
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('rejects malformed and missing resume IDs without writing or querying', async () => {
    const harness = await createSdkHarness()
    try {
      await runText(
        harness,
        'SDK_34A_INVALID_RESUME_BASELINE',
        'SDK_34A_INVALID_RESUME_BASELINE_RESPONSE',
      )
      const beforeFiles = await snapshotTranscripts(harness)
      const beforeRequests = modelRequests(harness).length
      const missingId = randomUUID()

      const malformed = await collectExpectedError(harness, {
        resume: 'not-a-uuid',
      })
      expect(malformed.error).toBeInstanceOf(Error)
      expect((malformed.error as Error).message).toMatch(/invalid session id/i)
      expect(malformed.messages).toEqual([])

      const missing = await collectExpectedError(harness, { resume: missingId })
      expect(missing.error).toBeInstanceOf(Error)
      expect((missing.error as Error).message).toContain(missingId)
      expect((missing.error as Error).message).toMatch(/not found/i)
      expect(missing.messages).toEqual([])
      expect(modelRequests(harness)).toHaveLength(beforeRequests)
      expect(await snapshotTranscripts(harness)).toEqual(beforeFiles)
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('continues the most recently modified session from the public project listing', async () => {
    const harness = await createSdkHarness()
    try {
      const firstMarker = 'SDK_34A_CONTINUE_OLDER'
      const secondMarker = 'SDK_34A_CONTINUE_LATEST'
      const first = await runText(harness, firstMarker, `${firstMarker}_RESPONSE`)
      const second = await runText(harness, secondMarker, `${secondMarker}_RESPONSE`)
      expect(second.sessionId).not.toBe(first.sessionId)

      const secondPath = await transcriptPath(harness, second.sessionId)
      const latestTime = new Date(Date.now() + 2_000)
      await utimes(secondPath, latestTime, latestTime)
      const listed = await harness.sdk.listSessions({
        dir: harness.sandbox.project,
      })
      expect(listed[0]?.sessionId).toBe(second.sessionId)
      expect(listed.map(session => session.sessionId)).toContain(first.sessionId)

      const continued = await runText(
        harness,
        'SDK_34A_CONTINUE_NEW_PROMPT',
        'SDK_34A_CONTINUE_NEW_RESPONSE',
        { continue: true },
      )
      expect(continued.sessionId).toBe(second.sessionId)
      const request = requestMessages(harness, 2)
      expect(request).toContain(secondMarker)
      expect(request).toContain(`${secondMarker}_RESPONSE`)
      expect(request).not.toContain(firstMarker)
      expect(request).toContain('SDK_34A_CONTINUE_NEW_PROMPT')
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('fails continue cleanly when the current project has no history', async () => {
    const harness = await createSdkHarness()
    try {
      const { messages, error } = await collectExpectedError(harness, {
        continue: true,
      })
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/no conversation|no session/i)
      expect(messages).toEqual([])
      expect(modelRequests(harness)).toHaveLength(0)
      expect(await snapshotTranscripts(harness)).toEqual([])
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('forks a resumed session without changing the source and resumes the fork independently', async () => {
    const harness = await createSdkHarness()
    try {
      const sourcePrompt = 'SDK_34A_FORK_SOURCE_PROMPT'
      const sourceResponse = 'SDK_34A_FORK_SOURCE_RESPONSE'
      const source = await runText(harness, sourcePrompt, sourceResponse)
      const sourcePath = await transcriptPath(harness, source.sessionId)
      const sourceBytes = await readFile(sourcePath)

      const fork = await runText(
        harness,
        'SDK_34A_FORK_NEW_PROMPT',
        'SDK_34A_FORK_NEW_RESPONSE',
        { resume: source.sessionId, forkSession: true },
      )
      expect(fork.sessionId).not.toBe(source.sessionId)
      expect(fork.sessionId).toMatch(UUID_PATTERN)
      expect(fork.result.session_id).toBe(fork.sessionId)
      const forkRequest = requestMessages(harness, 1)
      expect(forkRequest).toContain(sourcePrompt)
      expect(forkRequest).toContain(sourceResponse)
      expect(forkRequest).toContain('SDK_34A_FORK_NEW_PROMPT')
      expect((await readFile(sourcePath)).equals(sourceBytes)).toBe(true)

      const resumedFork = await runText(
        harness,
        'SDK_34A_FORK_INDEPENDENT_PROMPT',
        'SDK_34A_FORK_INDEPENDENT_RESPONSE',
        { resume: fork.sessionId },
      )
      expect(resumedFork.sessionId).toBe(fork.sessionId)
      const independentRequest = requestMessages(harness, 2)
      expect(independentRequest).toContain(sourceResponse)
      expect(independentRequest).toContain('SDK_34A_FORK_NEW_RESPONSE')
      expect(independentRequest).toContain('SDK_34A_FORK_INDEPENDENT_PROMPT')
      expect((await readFile(sourcePath)).equals(sourceBytes)).toBe(true)
      expect(await readTranscript(harness, fork.sessionId)).toContain(
        'SDK_34A_FORK_INDEPENDENT_RESPONSE',
      )
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('resumes the persisted user boundary after an external abort of a gated response', async () => {
    const harness = await createSdkHarness()
    const gate = createResponseGate()
    const abortController = new AbortController()
    try {
      const abortedPrompt = 'SDK_34A_ABORT_PERSISTED_PROMPT'
      harness.mock.enqueue({
        type: 'text',
        text: 'SDK_34A_ABORT_GATED_RESPONSE',
        gate,
      })
      const query = harness.track(harness.sdk.query({
        prompt: abortedPrompt,
        options: await classicOptions(harness, { abortController }),
      }))
      const init = await withDeadline(query.next(), 'aborted query init')
      expect(init.done).toBe(false)
      if (init.done || init.value.type !== 'system' || init.value.subtype !== 'init') {
        throw new Error('Expected the aborted query to emit init first')
      }
      const sessionId = init.value.session_id
      expect(sessionId).toMatch(UUID_PATTERN)

      const abortedCollection = harness.collect(query)
      await harness.waitFor(() => modelRequests(harness).length === 1)
      await harness.waitFor(async () => {
        try {
          return (await readTranscript(harness, sessionId)).includes(abortedPrompt)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      })
      abortController.abort('SDK 34A external abort after transcript boundary')
      const aborted = await abortedCollection
      expect(aborted.error).toBeInstanceOf(Error)
      expect(modelRequests(harness)).toHaveLength(1)
      const persisted = await readTranscript(harness, sessionId)
      expect(persisted).toContain(abortedPrompt)

      const resumed = await runText(
        harness,
        'SDK_34A_ABORT_RESUME_PROMPT',
        'SDK_34A_ABORT_RESUME_RESPONSE',
        { resume: sessionId },
      )
      expect(resumed.sessionId).toBe(sessionId)
      const resumeRequest = requestMessages(harness, 1)
      expect(resumeRequest).toContain(abortedPrompt)
      expect(resumeRequest).toContain('SDK_34A_ABORT_RESUME_PROMPT')
      expect(await readTranscript(harness, sessionId)).toContain(
        'SDK_34A_ABORT_RESUME_RESPONSE',
      )
    } finally {
      gate.release()
      abortController.abort('SDK 34A test cleanup')
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)
})
