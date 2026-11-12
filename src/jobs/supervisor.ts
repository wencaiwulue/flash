import { spawn, type ChildProcess } from 'child_process'
import { once } from 'events'
import { readFile } from 'fs/promises'
import { createInterface } from 'readline'
import { join, resolve } from 'path'
import {
  childRecordSchema,
  JOB_ENV_KEY,
  JobError,
  LOCAL_TEMPLATE_JOBS_VERSION,
  replyRecordSchema,
  supervisorRecordSchema,
  type ChildRecord,
  type JobRecord,
  type JobState,
  type ReplyRecord,
  type SupervisorRecord,
} from './schema.js'
import {
  appendJobDiagnostic,
  appendTranscriptLocked,
  assertSecureJobDirectory,
  getJobPaths,
  getProcessStartToken,
  readJob,
  readJobState,
  withJobLock,
  writeJobState,
  writeJsonAtomic,
} from './state.js'

export type SupervisorDeps = {
  execPath?: string
  scriptArgs?: string[]
  env?: NodeJS.ProcessEnv
  spawnProcess?: typeof spawn
  buildChildCommand?: (context: {
    job: JobRecord
    state: JobState
    prompt: string
    reply: ReplyRecord | null
    argv: string[]
  }) => { command: string; args: string[] }
}

function redactedArgv(argv: string[]): string[] {
  return argv.map((value, index) =>
    index === argv.length - 1 ? '<prompt>' : value,
  )
}

export function buildJobChildArgv(
  job: JobRecord,
  reply: ReplyRecord | null,
  prompt: string,
): string[] {
  const argv = [
    '--print',
    '--output-format',
    'stream-json',
    ...(reply
      ? ['--resume', job.session_id]
      : ['--session-id', job.session_id]),
  ]
  if (job.template.config.model) {
    argv.push('--model', job.template.config.model)
  }
  argv.push('--permission-mode', job.template.config.permission_mode)
  const tools = job.template.config.allowed_tools
  if (tools && !tools.includes('*')) {
    argv.push('--allowedTools', ...(tools.length ? tools : ['']))
  }
  argv.push(prompt)
  return argv
}

export async function spawnSupervisorProcess(
  jobDirectory: string,
  replyId: string | null,
  deps: SupervisorDeps = {},
): Promise<{ pid: number; startToken: string | null }> {
  await assertSecureJobDirectory(jobDirectory)
  const job = await readJob(jobDirectory)
  const paths = getJobPaths(jobDirectory)
  await writeJsonAtomic(join(paths.lock, replyId ? `startup-${replyId}.json` : 'startup-initial.json'), {
    version: LOCAL_TEMPLATE_JOBS_VERSION,
    job_id: job.job_id,
    reply_id: replyId,
    status: 'accepted',
    accepted_at: new Date().toISOString(),
  })
  const child = (deps.spawnProcess ?? spawn)(deps.execPath ?? process.execPath, [
    ...(deps.scriptArgs ?? [process.argv[1]!]),
    'template-job-supervisor',
    jobDirectory,
  ], {
    cwd: job.cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...(deps.env ?? process.env),
      [JOB_ENV_KEY]: jobDirectory,
      CLAUDE_CODE_ENTRYPOINT: 'template-job-supervisor',
    },
  })
  try {
    await Promise.race([
      once(child, 'spawn'),
      once(child, 'error').then(([error]) => Promise.reject(error)),
    ])
  } catch (error) {
    throw new JobError(
      'SPAWN_FAILED',
      error instanceof Error ? error.message : String(error),
    )
  }
  const pid = child.pid
  if (!pid) throw new JobError('SPAWN_FAILED', 'Supervisor did not expose a PID')
  child.unref()
  const startToken = await getProcessStartToken(pid)
  const record: SupervisorRecord = {
    version: LOCAL_TEMPLATE_JOBS_VERSION,
    job_id: job.job_id,
    session_id: job.session_id,
    reply_id: replyId,
    pid,
    start_token: startToken,
    started_at: new Date().toISOString(),
  }
  await writeJsonAtomic(paths.supervisor, supervisorRecordSchema.parse(record))
  await withJobLock(jobDirectory, async () => {
    const state = await readJobState(jobDirectory)
    if (
      (state.status === 'queued' || state.status === 'running') &&
      state.active_reply_id === replyId
    ) {
      await writeJobState(jobDirectory, { ...state, pid })
    }
  })
  return { pid, startToken }
}

function unavailableClassification(state: JobState, summary: string) {
  return {
    category: 'in_progress' as const,
    summary,
    confidence: 0,
    question: null,
    evidence: { assistant_message_uuids: [], tool_use_ids: [] },
    classified_at: new Date().toISOString(),
    generation: state.generation,
    model: 'unavailable',
    status: 'unavailable' as const,
    error_code: 'CLASSIFIER_UNAVAILABLE',
  }
}

export function mergeProcessOutcome(
  state: JobState,
  exitCode: number | null,
  spawnError?: { code: string; message: string },
): JobState {
  const now = new Date().toISOString()
  let status: JobState['status']
  let classification = state.classification
  let lastError = spawnError ?? null
  if (spawnError || exitCode !== 0) {
    status = 'failed'
    lastError ??= {
      code: 'CHILD_EXIT',
      message: `CLI exited with code ${exitCode ?? 'unknown'}`,
    }
  } else {
    const current =
      classification?.generation === state.generation ? classification : null
    if (!current || current.status !== 'ok' || current.confidence < 0.7) {
      status = 'waiting_for_input'
      classification = current
        ? { ...current, status: current.status === 'unavailable' ? 'unavailable' : 'stale' }
        : unavailableClassification(state, 'No usable structured classification was recorded')
    } else {
      switch (current.category) {
        case 'needs_input':
        case 'in_progress':
          status = 'waiting_for_input'
          break
        case 'blocked':
          status = 'blocked'
          break
        case 'completed':
          status = 'completed'
          break
        case 'failed':
          status = 'failed'
          lastError = { code: 'CLASSIFIER_FAILED', message: current.summary }
          break
      }
    }
  }
  return {
    ...state,
    status,
    pid: null,
    active_reply_id: null,
    updated_at: now,
    ended_at: now,
    exit_code: exitCode,
    classification,
    last_error: lastError,
  }
}

async function readReply(jobDirectory: string, replyId: string): Promise<ReplyRecord> {
  try {
    return replyRecordSchema.parse(
      JSON.parse(
        await readFile(
          `${getJobPaths(jobDirectory).replies}/${replyId}.json`,
          'utf8',
        ),
      ),
    )
  } catch {
    throw new JobError('JOB_CORRUPT', 'Reply record is missing or invalid')
  }
}

async function finalizeReply(
  jobDirectory: string,
  reply: ReplyRecord | null,
  state: JobState,
): Promise<void> {
  if (!reply) return
  const next: ReplyRecord = {
    ...reply,
    status: state.status === 'failed' ? 'failed' : 'completed',
    completed_at: state.ended_at ?? new Date().toISOString(),
    error: state.last_error,
  }
  await writeJsonAtomic(
    `${getJobPaths(jobDirectory).replies}/${reply.reply_id}.json`,
    next,
  )
}

export async function runJobSupervisor(
  requestedJobDirectory: string,
  deps: SupervisorDeps = {},
): Promise<JobState> {
  const jobDirectory = await assertSecureJobDirectory(requestedJobDirectory)
  const supervisorEnvironment = deps.env ?? process.env
  if (
    !supervisorEnvironment[JOB_ENV_KEY] ||
    resolve(supervisorEnvironment[JOB_ENV_KEY]!) !== resolve(jobDirectory)
  ) {
    throw new JobError('JOB_STATE_CONFLICT', `${JOB_ENV_KEY} does not match the job`)
  }
  const job = await readJob(jobDirectory)
  const paths = getJobPaths(jobDirectory)
  return withJobLock(jobDirectory, async () => {
    let state = await readJobState(jobDirectory)
    const replyId = state.active_reply_id
    const reply = replyId ? await readReply(jobDirectory, replyId) : null
    if (state.status !== 'queued' && state.status !== 'running') return state
    const now = new Date().toISOString()
    state = { ...state, status: 'running', pid: process.pid, updated_at: now }
    const supervisor: SupervisorRecord = {
      version: LOCAL_TEMPLATE_JOBS_VERSION,
      job_id: job.job_id,
      session_id: job.session_id,
      reply_id: replyId,
      pid: process.pid,
      start_token: await getProcessStartToken(process.pid),
      started_at: now,
    }
    await writeJsonAtomic(paths.supervisor, supervisor)
    await writeJobState(jobDirectory, state)
    await appendTranscriptLocked(jobDirectory, {
      job_id: job.job_id,
      direction: 'supervisor',
      kind: 'process',
      payload: { event: 'supervisor_start', pid: process.pid, generation: state.generation },
    })

    const prompt = reply?.prompt ?? job.rendered_prompt
    const argv = buildJobChildArgv(job, reply, prompt)
    const command = deps.buildChildCommand?.({
      job,
      state,
      prompt,
      reply,
      argv,
    }) ?? {
      command: deps.execPath ?? process.execPath,
      args: [...(deps.scriptArgs ?? [process.argv[1]!]), ...argv],
    }
    let child: ChildProcess
    let childRecord: ChildRecord | null = null
    try {
      child = (deps.spawnProcess ?? spawn)(command.command, command.args, {
        cwd: job.cwd,
        env: {
          ...(deps.env ?? process.env),
          [JOB_ENV_KEY]: jobDirectory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      const spawnError = {
        code: 'SPAWN_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }
      state = mergeProcessOutcome(state, null, spawnError)
      await writeJobState(jobDirectory, state)
      await finalizeReply(jobDirectory, reply, state)
      return state
    }

    let spawnFailure: Error | null = null
    child.once('error', error => {
      spawnFailure = error
      void appendJobDiagnostic(jobDirectory, error.message)
    })
    const closePromise = once(child, 'close')
    if (!child.pid) {
      const spawnError = { code: 'SPAWN_FAILED', message: 'CLI child did not expose a PID' }
      state = mergeProcessOutcome(state, null, spawnError)
      await writeJobState(jobDirectory, state)
      await finalizeReply(jobDirectory, reply, state)
      return state
    }
    const spawnedAt = new Date().toISOString()
    childRecord = {
      version: LOCAL_TEMPLATE_JOBS_VERSION,
      job_id: job.job_id,
      session_id: job.session_id,
      reply_id: replyId,
      pid: child.pid,
      start_token: await getProcessStartToken(child.pid),
      argv: redactedArgv(command.args),
      spawned_at: spawnedAt,
      ended_at: null,
      exit_code: null,
      signal: null,
    }
    await writeJsonAtomic(paths.child, childRecordSchema.parse(childRecord))
    await appendTranscriptLocked(jobDirectory, {
      job_id: job.job_id,
      direction: 'supervisor',
      kind: 'process',
      payload: { event: 'spawn', pid: child.pid, argv: redactedArgv(command.args) },
    })

    if (child.stderr) {
      const stderr = createInterface({ input: child.stderr })
      stderr.on('line', line => {
        void appendJobDiagnostic(jobDirectory, line)
      })
    }
    try {
      if (child.stdout) {
        const stdout = createInterface({ input: child.stdout })
        for await (const line of stdout) {
          if (!line.trim()) continue
          try {
            const message = JSON.parse(line) as Record<string, unknown>
            await appendTranscriptLocked(jobDirectory, {
              job_id: job.job_id,
              direction: 'inbound',
              kind: 'sdk',
              payload: { message },
            })
          } catch (error) {
            if (error instanceof JobError) throw error
            await appendTranscriptLocked(jobDirectory, {
              job_id: job.job_id,
              direction: 'supervisor',
              kind: 'error',
              payload: { code: 'INVALID_SDK_MESSAGE', message: 'CLI emitted non-JSON stdout' },
            })
          }
        }
      }
      const [exitCode, signal] = (await closePromise) as [number | null, string | null]
      const endedAt = new Date().toISOString()
      childRecord = {
        ...childRecord,
        ended_at: endedAt,
        exit_code: exitCode,
        signal,
      }
      await writeJsonAtomic(paths.child, childRecord)
      await appendTranscriptLocked(jobDirectory, {
        job_id: job.job_id,
        direction: 'supervisor',
        kind: 'process',
        payload: { event: 'exit', pid: childRecord.pid, exit_code: exitCode, signal },
      })
      const latest = await readJobState(jobDirectory)
      state = mergeProcessOutcome(
        latest,
        exitCode,
        spawnFailure
          ? { code: 'SPAWN_FAILED', message: (spawnFailure as Error).message }
          : undefined,
      )
      await appendTranscriptLocked(jobDirectory, {
        job_id: job.job_id,
        direction: 'supervisor',
        kind: 'classifier',
        payload: {
          generation: state.generation,
          status: state.classification?.status ?? 'unavailable',
          category: state.classification?.category ?? null,
          classification: state.classification,
        },
      })
      await writeJobState(jobDirectory, state)
      await finalizeReply(jobDirectory, reply, state)
      return state
    } catch (error) {
      const now = new Date().toISOString()
      state = {
        ...(await readJobState(jobDirectory)),
        status: 'failed',
        pid: null,
        active_reply_id: null,
        updated_at: now,
        ended_at: now,
        last_error: {
          code: 'recovery_uncertain',
          message: error instanceof Error ? error.message : String(error),
        },
      }
      await writeJobState(jobDirectory, state)
      await finalizeReply(jobDirectory, reply, state)
      throw error
    }
  })
}
