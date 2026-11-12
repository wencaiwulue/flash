import { createHash, randomUUID } from 'crypto'
import { open, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { getProjectDir } from '../utils/sessionStorage.js'
import { validateUuid } from '../utils/uuid.js'
import { renderTemplatePrompt, resolveTemplate } from './discovery.js'
import {
  JobError,
  replyRecordSchema,
  supervisorRecordSchema,
  type JobRecord,
  type JobState,
  type ReplyRecord,
} from './schema.js'
import {
  appendTranscriptLocked,
  createJobDirectory,
  ensureJobsRoot,
  getJobPaths,
  probeProcessIdentity,
  readJob,
  readJobState,
  readJsonValidated,
  reconcileJob,
  resolveJobId,
  withJobLock,
  writeJobState,
  writeJsonAtomic,
} from './state.js'
import { spawnSupervisorProcess } from './supervisor.js'

export type CreateJobOptions = {
  template: string
  prompt?: string
  requestId?: string
  cwd?: string
}

export type ReplyJobOptions = {
  jobId: string
  prompt: string
  replyId?: string
}

export type JobCommandDeps = {
  spawnSupervisor?: typeof spawnSupervisorProcess
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

type RequestIndex = {
  version: 'local-template-jobs-v1'
  request_id: string
  request_hash: string
  job_id: string
}

async function readRequestIndex(requestId: string): Promise<RequestIndex | null> {
  try {
    const value = JSON.parse(
      await readFile(join(await ensureJobsRoot(), 'requests', `${requestId}.json`), 'utf8'),
    ) as Partial<RequestIndex>
    if (
      value.version !== 'local-template-jobs-v1' ||
      value.request_id !== requestId ||
      !validateUuid(value.job_id) ||
      typeof value.request_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.request_hash)
    ) {
      throw new Error('invalid request index')
    }
    return value as RequestIndex
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw new JobError('JOB_CORRUPT', 'Invalid request idempotency record')
  }
}

async function reserveRequest(index: RequestIndex): Promise<boolean> {
  const root = await ensureJobsRoot()
  const path = join(root, 'requests', `${index.request_id}.json`)
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(index, null, 2)}\n`, 'utf8')
    await handle.sync()
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false
    throw error
  } finally {
    if (handle) await handle.close()
  }
}

export async function createTemplateJob(
  options: CreateJobOptions,
  deps: JobCommandDeps = {},
): Promise<{ job: JobRecord; state: JobState; jobDirectory: string }> {
  const requestId = options.requestId ?? randomUUID()
  if (!validateUuid(requestId)) {
    throw new JobError('INVALID_REQUEST', '--request-id must be a UUID')
  }
  const invocationCwd = options.cwd ?? process.cwd()
  const { snapshot, workingDirectory } = await resolveTemplate(
    options.template,
    invocationCwd,
  )
  const initialPrompt = options.prompt ?? ''
  const renderedPrompt = renderTemplatePrompt(snapshot.body, initialPrompt)
  const requestHash = canonicalHash({
    template: snapshot,
    prompt: initialPrompt,
    cwd: workingDirectory,
  })
  const existing = await readRequestIndex(requestId)
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new JobError(
        'IDEMPOTENCY_CONFLICT',
        'Request ID was already used with different input',
      )
    }
    const jobDirectory = await resolveJobId(existing.job_id)
    return {
      job: await readJob(jobDirectory),
      state: await reconcileJob(jobDirectory),
      jobDirectory,
    }
  }

  const jobId = randomUUID()
  const sessionId = randomUUID()
  const createdAt = new Date().toISOString()
  const jobDirectory = await createJobDirectory(jobId)
  const paths = getJobPaths(jobDirectory)
  const job: JobRecord = {
    version: 'local-template-jobs-v1',
    job_id: jobId,
    session_id: sessionId,
    request_id: requestId,
    created_at: createdAt,
    cwd: workingDirectory,
    template: snapshot,
    transcript_path: join(getProjectDir(workingDirectory), `${sessionId}.jsonl`),
    initial_prompt: initialPrompt,
    rendered_prompt: renderedPrompt,
    request_hash: requestHash,
  }
  let state: JobState = {
    version: 'local-template-jobs-v1',
    job_id: jobId,
    status: 'queued',
    generation: 1,
    active_reply_id: null,
    pid: null,
    started_at: createdAt,
    updated_at: createdAt,
    ended_at: null,
    exit_code: null,
    classification: null,
    last_error: null,
  }
  try {
    await writeJsonAtomic(paths.job, job)
    await writeJobState(jobDirectory, state)
    await withJobLock(jobDirectory, () =>
      appendTranscriptLocked(jobDirectory, {
        job_id: jobId,
        direction: 'outbound',
        kind: 'user',
        payload: { prompt: renderedPrompt, request_id: requestId },
      }),
    )
    const reserved = await reserveRequest({
      version: 'local-template-jobs-v1',
      request_id: requestId,
      request_hash: requestHash,
      job_id: jobId,
    })
    if (!reserved) {
      const winner = await readRequestIndex(requestId)
      await rm(jobDirectory, { recursive: true, force: true })
      if (!winner || winner.request_hash !== requestHash) {
        throw new JobError(
          'IDEMPOTENCY_CONFLICT',
          'Request ID was already used with different input',
        )
      }
      const winnerDirectory = await resolveJobId(winner.job_id)
      return {
        job: await readJob(winnerDirectory),
        state: await reconcileJob(winnerDirectory),
        jobDirectory: winnerDirectory,
      }
    }
  } catch (error) {
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  const spawn = deps.spawnSupervisor ?? spawnSupervisorProcess
  try {
    await spawn(jobDirectory, null)
  } catch (error) {
    const now = new Date().toISOString()
    state = {
      ...state,
      status: 'failed',
      updated_at: now,
      ended_at: now,
      last_error: {
        code: 'SPAWN_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    }
    await writeJobState(jobDirectory, state)
    throw new JobError('SPAWN_FAILED', 'Failed to start job supervisor', {
      job_id: jobId,
    })
  }
  state = await readJobState(jobDirectory)
  return { job, state, jobDirectory }
}

function replyPath(jobDirectory: string, replyId: string): string {
  return join(getJobPaths(jobDirectory).replies, `${replyId}.json`)
}

export async function replyToJob(
  options: ReplyJobOptions,
  deps: JobCommandDeps = {},
): Promise<{ reply: ReplyRecord; state: JobState; jobDirectory: string }> {
  const replyId = options.replyId ?? randomUUID()
  if (!validateUuid(replyId)) {
    throw new JobError('INVALID_REQUEST', '--reply-id must be a UUID')
  }
  if (!options.prompt.trim()) {
    throw new JobError('INVALID_REQUEST', 'Reply prompt must not be empty')
  }
  const jobDirectory = await resolveJobId(options.jobId)
  const job = await readJob(jobDirectory)
  const promptHash = canonicalHash(options.prompt)
  await reconcileJob(jobDirectory)
  let acceptedState: JobState | null = null
  let createdReply = false
  const existingReply = await withJobLock(jobDirectory, async () => {
    let existing: ReplyRecord | null = null
    try {
      const parsed = replyRecordSchema.safeParse(
        JSON.parse(await readFile(replyPath(jobDirectory, replyId), 'utf8')),
      )
      if (!parsed.success) throw new Error('invalid reply record')
      existing = parsed.data
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw new JobError('JOB_CORRUPT', 'Invalid reply idempotency record')
      }
    }
    if (existing) {
      if (existing.prompt_hash !== promptHash) {
        throw new JobError(
          'IDEMPOTENCY_CONFLICT',
          'Reply ID was already used with a different prompt',
        )
      }
      acceptedState = await readJobState(jobDirectory)
      return existing
    }

    let state = await readJobState(jobDirectory)
    if (state.status === 'queued' || state.status === 'running') {
      throw new JobError('JOB_BUSY', 'A turn is already running for this job')
    }
    if (state.status === 'failed' || state.status === 'cancelled') {
      throw new JobError(
        'JOB_STATE_CONFLICT',
        `Cannot reply to a ${state.status} job`,
      )
    }
    if (
      state.status !== 'waiting_for_input' &&
      state.status !== 'blocked' &&
      state.status !== 'completed'
    ) {
      throw new JobError('JOB_STATE_CONFLICT', 'Job is not accepting replies')
    }
    const now = new Date().toISOString()
    state = {
      ...state,
      status: 'running',
      generation: state.generation + 1,
      active_reply_id: replyId,
      pid: null,
      updated_at: now,
      ended_at: null,
      exit_code: null,
      classification: null,
      last_error: null,
    }
    const reply: ReplyRecord = {
      version: 'local-template-jobs-v1',
      reply_id: replyId,
      job_id: job.job_id,
      prompt: options.prompt,
      prompt_hash: promptHash,
      generation: state.generation,
      status: 'accepted',
      accepted_at: now,
      completed_at: null,
      error: null,
    }
    await writeJsonAtomic(replyPath(jobDirectory, replyId), reply)
    await appendTranscriptLocked(jobDirectory, {
      job_id: job.job_id,
      direction: 'outbound',
      kind: 'user',
      payload: { prompt: options.prompt, reply_id: replyId },
    })
    await writeJobState(jobDirectory, state)
    acceptedState = state
    createdReply = true
    return reply
  })

  if (
    !createdReply ||
    existingReply.status !== 'accepted' ||
    (acceptedState as JobState | null)?.active_reply_id !== replyId
  ) {
    return { reply: existingReply, state: acceptedState!, jobDirectory }
  }
  const spawn = deps.spawnSupervisor ?? spawnSupervisorProcess
  try {
    await spawn(jobDirectory, replyId)
  } catch (error) {
    const failed = await withJobLock(jobDirectory, async () => {
      const state = await readJobState(jobDirectory)
      const now = new Date().toISOString()
      const next = {
        ...state,
        status: 'failed' as const,
        pid: null,
        active_reply_id: null,
        updated_at: now,
        ended_at: now,
        last_error: {
          code: 'SPAWN_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      }
      await writeJobState(jobDirectory, next)
      const failedReply: ReplyRecord = {
        ...existingReply,
        status: 'failed',
        completed_at: now,
        error: next.last_error,
      }
      await writeJsonAtomic(replyPath(jobDirectory, replyId), failedReply)
      return next
    })
    throw new JobError('SPAWN_FAILED', 'Failed to start reply supervisor', {
      job_id: job.job_id,
      state: failed,
    })
  }
  return {
    reply: existingReply,
    state: acceptedState!,
    jobDirectory,
  }
}

export async function getJobDetails(jobId: string): Promise<{
  job: JobRecord
  state: JobState
  jobDirectory: string
  process_status: 'alive' | 'dead' | 'reused' | 'unknown' | 'not_running'
}> {
  const jobDirectory = await resolveJobId(jobId)
  const job = await readJob(jobDirectory)
  const state = await reconcileJob(jobDirectory)
  let processStatus: 'alive' | 'dead' | 'reused' | 'unknown' | 'not_running' = 'not_running'
  if (state.pid) {
    processStatus = 'unknown'
    try {
      const supervisor = await readJsonValidated(
        getJobPaths(jobDirectory).supervisor,
        supervisorRecordSchema,
      )
      if (supervisor.job_id === job.job_id && supervisor.pid === state.pid) {
        processStatus = await probeProcessIdentity(supervisor.pid, supervisor.start_token)
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
  }
  return {
    job,
    state,
    jobDirectory,
    process_status: processStatus,
  }
}
