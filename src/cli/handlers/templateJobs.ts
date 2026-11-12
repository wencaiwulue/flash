import { readFile } from 'fs/promises'
import { createTemplateJob, getJobDetails, replyToJob } from '../../jobs/operations.js'
import { JobError } from '../../jobs/schema.js'
import {
  getJobPaths,
  listJobDirectories,
  readJob,
  readJobState,
  streamJobTranscript,
} from '../../jobs/state.js'
import { runJobSupervisor } from '../../jobs/supervisor.js'

type ParsedArgs = {
  positional: string[]
  json: boolean
  state: boolean
  transcript: boolean
  requestId?: string
  replyId?: string
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], json: false, state: false, transcript: false }
  let options = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (options && arg === '--') {
      options = false
      continue
    }
    if (!options || !arg.startsWith('--')) {
      result.positional.push(arg)
      continue
    }
    const [flag, inline] = arg.split('=', 2)
    const takeValue = (): string => {
      const value = inline ?? args[++index]
      if (!value) throw new JobError('INVALID_REQUEST', `${flag} requires a value`)
      return value
    }
    switch (flag) {
      case '--json':
        if (inline !== undefined) throw new JobError('INVALID_REQUEST', '--json takes no value')
        result.json = true
        break
      case '--state': result.state = true; break
      case '--transcript': result.transcript = true; break
      case '--request-id': result.requestId = takeValue(); break
      case '--reply-id': result.replyId = takeValue(); break
      default: throw new JobError('INVALID_REQUEST', `Unknown option: ${flag}`)
    }
  }
  return result
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function execute(args: string[]): Promise<void> {
  if (
    (args.length === 1 || args.length === 2) &&
    (args.includes('--help') || args.includes('-h'))
  ) {
    process.stdout.write(
      'Usage: claude new <template> [prompt...]\n' +
        '       claude list [job-id] [--json|--state|--transcript]\n' +
        '       claude reply <job-id> <prompt...>\n',
    )
    return
  }
  const [command, ...rest] = args
  const parsed = parseArgs(rest)
  if (parsed.json && (parsed.state || parsed.transcript)) {
    throw new JobError('INVALID_REQUEST', '--json cannot be combined with --state or --transcript')
  }
  if (parsed.state && parsed.transcript) {
    throw new JobError('INVALID_REQUEST', '--state and --transcript are mutually exclusive')
  }

  if (command === 'new') {
    if (parsed.state || parsed.transcript || parsed.replyId) {
      throw new JobError('INVALID_REQUEST', 'Invalid options for new')
    }
    const [template, ...prompt] = parsed.positional
    if (!template) throw new JobError('INVALID_REQUEST', 'Usage: claude new <template> [prompt...]')
    const result = await createTemplateJob({
      template,
      prompt: prompt.join(' '),
      ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
    })
    const output = {
      job_id: result.job.job_id,
      session_id: result.job.session_id,
      state: result.state.status,
      job_dir: result.jobDirectory,
    }
    if (parsed.json) writeJson(output)
    else process.stdout.write(`${output.job_id}\t${output.state}\t${output.job_dir}\n`)
    return
  }

  if (command === 'reply') {
    if (parsed.state || parsed.transcript || parsed.requestId) {
      throw new JobError('INVALID_REQUEST', 'Invalid options for reply')
    }
    const [jobId, ...prompt] = parsed.positional
    if (!jobId || prompt.length === 0) {
      throw new JobError('INVALID_REQUEST', 'Usage: claude reply <job-id> <prompt...>')
    }
    const result = await replyToJob({
      jobId,
      prompt: prompt.join(' '),
      ...(parsed.replyId ? { replyId: parsed.replyId } : {}),
    })
    const output = { reply_id: result.reply.reply_id, job_id: result.reply.job_id, state: result.state.status }
    if (parsed.json) writeJson(output)
    else process.stdout.write(`${output.reply_id}\t${output.job_id}\t${output.state}\n`)
    return
  }

  if (command !== 'list') {
    throw new JobError('INVALID_REQUEST', `Unknown template command: ${command ?? ''}`)
  }
  if (parsed.requestId || parsed.replyId) {
    throw new JobError('INVALID_REQUEST', 'Invalid options for list')
  }
  if (parsed.positional.length > 1) {
    throw new JobError('INVALID_REQUEST', 'list accepts at most one job ID')
  }
  const id = parsed.positional[0]
  if (!id) {
    if (parsed.state || parsed.transcript) {
      throw new JobError('INVALID_REQUEST', '--state and --transcript require a job ID')
    }
    const jobs = []
    for (const directory of await listJobDirectories()) {
      const [job, state] = await Promise.all([readJob(directory), readJobState(directory)])
      jobs.push({
        job_id: job.job_id,
        session_id: job.session_id,
        template: job.template.name,
        state: state.status,
        updated_at: state.updated_at,
        job_dir: directory,
        ...(parsed.json ? { record: state } : {}),
      })
    }
    if (parsed.json) writeJson({ version: 'local-template-jobs-v1', jobs })
    else {
      for (const job of jobs) {
        process.stdout.write(`${job.job_id}\t${job.state}\t${job.updated_at}\t${job.template}\n`)
      }
    }
    return
  }

  const details = await getJobDetails(id)
  if (parsed.transcript) {
    await streamJobTranscript(details.jobDirectory, process.stdout)
    return
  }
  if (parsed.state) {
    await readJobState(details.jobDirectory)
    const raw = await readFile(getJobPaths(details.jobDirectory).state, 'utf8')
    process.stdout.write(raw.endsWith('\n') ? raw : `${raw}\n`)
    return
  }
  const output = {
    job_id: details.job.job_id,
    session_id: details.job.session_id,
    template: details.job.template,
    cwd: details.job.cwd,
    state: details.state,
    job_dir: details.jobDirectory,
    paths: getJobPaths(details.jobDirectory),
    process_status: details.process_status,
  }
  if (parsed.json) writeJson(output)
  else {
    process.stdout.write(
      `${details.job.job_id}\t${details.state.status}\t${details.state.updated_at}\n` +
        (details.state.classification ? `${details.state.classification.summary}\n` : '') +
        (details.state.last_error ? `${details.state.last_error.code}: ${details.state.last_error.message}\n` : ''),
    )
  }
}

export async function templatesMain(args: string[]): Promise<never> {
  try {
    await execute(args)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    const jobError = error instanceof JobError
      ? error
      : new JobError('JOB_STATE_CONFLICT', error instanceof Error ? error.message : String(error))
    if (args.includes('--json')) {
      process.stderr.write(`${JSON.stringify({ error: {
        code: jobError.code,
        message: jobError.message,
        ...(jobError.details ? { details: jobError.details } : {}),
      } })}\n`)
    } else {
      process.stderr.write(`${jobError.code}: ${jobError.message}\n`)
    }
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}

/** Internal detached-supervisor entrypoint; not another public job command. */
export async function templateJobSupervisorMain(args: string[]): Promise<void> {
  const [jobDirectory, ...extra] = args
  if (!jobDirectory || extra.length > 0) {
    throw new JobError('INVALID_REQUEST', 'Invalid supervisor arguments')
  }
  const state = await runJobSupervisor(jobDirectory)
  if (state.status === 'failed') process.exitCode = 1
}
