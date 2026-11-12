import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { promisify } from 'util'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { lock } from '../utils/lockfile.js'
import { validateUuid } from '../utils/uuid.js'
import {
  asJobError,
  JobError,
  jobRecordSchema,
  jobStateSchema,
  LOCAL_TEMPLATE_JOBS_VERSION,
  supervisorRecordSchema,
  transcriptRecordSchema,
  type JobRecord,
  type JobState,
  type SupervisorRecord,
  type TranscriptRecord,
} from './schema.js'
import type { ZodType } from 'zod'

const execFileAsync = promisify(execFile)

export function getJobsRoot(): string {
  return resolve(getClaudeConfigHomeDir(), 'jobs')
}

export function getJobPaths(jobDirectory: string) {
  return {
    directory: jobDirectory,
    job: join(jobDirectory, 'job.json'),
    state: join(jobDirectory, 'state.json'),
    transcript: join(jobDirectory, 'transcript.jsonl'),
    child: join(jobDirectory, 'child.json'),
    supervisor: join(jobDirectory, 'supervisor.json'),
    stderr: join(jobDirectory, 'stderr.log'),
    lock: join(jobDirectory, 'lock'),
    replies: join(jobDirectory, 'replies'),
  }
}

export async function ensureJobsRoot(): Promise<string> {
  const root = getJobsRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new JobError('JOB_STATE_CONFLICT', 'Jobs root is not a real directory')
  }
  await chmod(root, 0o700)
  await mkdir(join(root, 'requests'), { recursive: true, mode: 0o700 })
  return root
}

export async function createJobDirectory(jobId: string): Promise<string> {
  if (!validateUuid(jobId)) {
    throw new JobError('INVALID_REQUEST', 'Job ID must be a UUID')
  }
  const root = await ensureJobsRoot()
  const directory = join(root, jobId)
  await mkdir(directory, { mode: 0o700 })
  await chmod(directory, 0o700)
  const paths = getJobPaths(directory)
  await mkdir(paths.lock, { mode: 0o700 })
  await mkdir(paths.replies, { mode: 0o700 })
  return directory
}

export async function assertSecureJobDirectory(
  jobDirectory: string,
): Promise<string> {
  const root = await ensureJobsRoot()
  const absolute = resolve(jobDirectory)
  if (dirname(absolute) !== root || !validateUuid(absolute.slice(root.length + 1))) {
    throw new JobError('JOB_NOT_FOUND', 'Job directory is outside the jobs root')
  }
  const [rootInfo, jobInfo] = await Promise.all([lstat(root), lstat(absolute)])
  if (
    rootInfo.isSymbolicLink() ||
    jobInfo.isSymbolicLink() ||
    !jobInfo.isDirectory()
  ) {
    throw new JobError('JOB_STATE_CONFLICT', 'Job directory must not be a symlink')
  }
  const [canonicalRoot, canonicalJob] = await Promise.all([
    realpath(root),
    realpath(absolute),
  ])
  if (canonicalJob !== join(canonicalRoot, absolute.slice(root.length + 1))) {
    throw new JobError('JOB_STATE_CONFLICT', 'Job directory resolves outside jobs root')
  }
  await chmod(absolute, 0o700)
  return absolute
}

export async function readJsonValidated<T>(
  path: string,
  schema: ZodType<T>,
): Promise<T> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw error
    throw asJobError(error)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new JobError('JOB_CORRUPT', `Invalid job data in ${path}`, {
      issues: parsed.error.issues.map(issue => ({
        path: issue.path,
        code: issue.code,
      })),
    })
  }
  return parsed.data
}

export function readJob(jobDirectory: string): Promise<JobRecord> {
  return readJsonValidated(getJobPaths(jobDirectory).job, jobRecordSchema)
}

export function readJobState(jobDirectory: string): Promise<JobState> {
  return readJsonValidated(getJobPaths(jobDirectory).state, jobStateSchema)
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export function writeJobState(
  jobDirectory: string,
  state: JobState,
): Promise<void> {
  const parsed = jobStateSchema.safeParse(state)
  if (!parsed.success) {
    throw new JobError('JOB_STATE_CONFLICT', 'Refusing to write invalid job state')
  }
  return writeJsonAtomic(getJobPaths(jobDirectory).state, parsed.data)
}

export async function withJobLock<T>(
  jobDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  await assertSecureJobDirectory(jobDirectory)
  const paths = getJobPaths(jobDirectory)
  await mkdir(paths.lock, { recursive: true, mode: 0o700 })
  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(paths.state, {
      lockfilePath: join(paths.lock, 'state.lock'),
      stale: 60_000,
      retries: { retries: 40, minTimeout: 25, maxTimeout: 100, factor: 1 },
      realpath: false,
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'ELOCKED') {
      throw new JobError('JOB_BUSY', 'Another turn holds the job lock')
    }
    throw error
  }
  try {
    return await operation()
  } finally {
    await release()
  }
}

export async function resolveJobId(prefix: string): Promise<string> {
  if (!/^[a-f0-9-]+$/i.test(prefix) || prefix.length > 36) {
    throw new JobError('JOB_NOT_FOUND', 'Invalid job ID')
  }
  if (validateUuid(prefix)) {
    const directory = join(await ensureJobsRoot(), prefix)
    try {
      await assertSecureJobDirectory(directory)
      await readJob(directory)
      return directory
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        throw new JobError('JOB_NOT_FOUND', `Job not found: ${prefix}`)
      }
      throw error
    }
  }
  const root = await ensureJobsRoot()
  const entries = await readdir(root, { withFileTypes: true })
  const matches = entries
    .filter(
      entry =>
        entry.isDirectory() &&
        validateUuid(entry.name) &&
        entry.name.startsWith(prefix),
    )
    .map(entry => entry.name)
  if (matches.length === 0) {
    throw new JobError('JOB_NOT_FOUND', `Job not found: ${prefix}`)
  }
  if (matches.length > 1) {
    throw new JobError('JOB_ID_AMBIGUOUS', `Job ID is ambiguous: ${prefix}`, {
      matches,
    })
  }
  return assertSecureJobDirectory(join(root, matches[0]!))
}

async function readLastTranscriptLine(path: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const size = (await handle.stat()).size
    if (size === 0) return null
    let position = size
    let trailing = Buffer.alloc(0)
    while (position > 0) {
      const length = Math.min(8192, position)
      position -= length
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, position)
      trailing = Buffer.concat([buffer, trailing])
      const firstNewline = trailing.indexOf(0x0a)
      const lastNewline = trailing.lastIndexOf(0x0a)
      if ((firstNewline !== -1 && firstNewline !== lastNewline) || position === 0) {
        const lines = trailing.toString('utf8').split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i]) return lines[i]!
        }
      }
    }
    return null
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  } finally {
    if (handle) await handle.close()
  }
}

/** Append while the caller holds the job lock. */
export async function appendTranscriptLocked(
  jobDirectory: string,
  record: Omit<TranscriptRecord, 'version' | 'seq' | 'timestamp' | 'job_id'> & {
    job_id: string
    timestamp?: string
  },
): Promise<TranscriptRecord> {
  const paths = getJobPaths(jobDirectory)
  const lastLine = await readLastTranscriptLine(paths.transcript)
  let seq = 1
  if (lastLine) {
    try {
      const previous = transcriptRecordSchema.parse(JSON.parse(lastLine))
      seq = previous.seq + 1
    } catch {
      throw new JobError('JOB_CORRUPT', 'Invalid supervisor transcript')
    }
  }
  const value = transcriptRecordSchema.parse({
    version: LOCAL_TEMPLATE_JOBS_VERSION,
    seq,
    timestamp: record.timestamp ?? new Date().toISOString(),
    job_id: record.job_id,
    direction: record.direction,
    kind: record.kind,
    payload: record.payload,
  })
  const handle = await open(paths.transcript, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
    await chmod(paths.transcript, 0o600)
  } finally {
    await handle.close()
  }
  return value
}

export async function appendTranscript(
  jobDirectory: string,
  record: Parameters<typeof appendTranscriptLocked>[1],
): Promise<TranscriptRecord> {
  return withJobLock(jobDirectory, () =>
    appendTranscriptLocked(jobDirectory, record),
  )
}

export async function appendJobDiagnostic(
  jobDirectory: string,
  message: string,
): Promise<void> {
  const path = getJobPaths(jobDirectory).stderr
  const safe = message
    .replace(/(?:sk-ant-|sk-|Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .slice(-64 * 1024)
  try {
    const info = await stat(path)
    if (info.size > 1024 * 1024) {
      await rename(path, `${path}.1`).catch(() => {})
    }
  } catch {
    // A missing log is expected on the first write.
  }
  await appendFile(path, `${new Date().toISOString()} ${safe}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(path, 0o600)
}

export type ProcessProbe = 'alive' | 'dead' | 'reused' | 'unknown'

export async function getProcessStartToken(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (process.platform === 'linux') {
    try {
      const contents = await readFile(join('/proc', String(pid), 'stat'), 'utf8')
      const end = contents.lastIndexOf(')')
      const fields = contents.slice(end + 2).split(' ')
      return fields[19] ?? null
    } catch {
      return null
    }
  }
  if (process.platform === 'darwin' || process.platform.includes('bsd')) {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: 1500,
      })
      return stdout.trim() || null
    } catch {
      return null
    }
  }
  return null
}

export async function probeProcessIdentity(
  pid: number,
  expectedStartToken: string | null,
): Promise<ProcessProbe> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ESRCH') return 'dead'
    return 'unknown'
  }
  if (!expectedStartToken) return 'unknown'
  const actual = await getProcessStartToken(pid)
  if (!actual) return 'unknown'
  return actual === expectedStartToken ? 'alive' : 'reused'
}

export async function reconcileJob(jobDirectory: string): Promise<JobState> {
  let state = await readJobState(jobDirectory)
  if (state.status !== 'queued' && state.status !== 'running') return state
  let supervisor: SupervisorRecord
  try {
    supervisor = await readJsonValidated(
      getJobPaths(jobDirectory).supervisor,
      supervisorRecordSchema,
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return state
    throw error
  }
  if (supervisor.job_id !== state.job_id || supervisor.pid !== state.pid) {
    return state
  }
  const probe = await probeProcessIdentity(
    supervisor.pid,
    supervisor.start_token,
  )
  if (probe === 'alive' || probe === 'unknown' || probe === 'reused') return state
  return withJobLock(jobDirectory, async () => {
    state = await readJobState(jobDirectory)
    if (state.status !== 'queued' && state.status !== 'running') return state
    const now = new Date().toISOString()
    const next: JobState = {
      ...state,
      status: 'failed',
      pid: null,
      active_reply_id: null,
      updated_at: now,
      ended_at: now,
      last_error: {
        code: 'recovery_uncertain',
        message: 'Supervisor exited without recording a result; side effects are uncertain',
      },
    }
    await writeJobState(jobDirectory, next)
    await appendTranscriptLocked(jobDirectory, {
      job_id: state.job_id,
      direction: 'supervisor',
      kind: 'error',
      payload: { code: 'recovery_uncertain' },
    })
    return next
  })
}

export async function listJobDirectories(): Promise<string[]> {
  const root = await ensureJobsRoot()
  const entries = await readdir(root, { withFileTypes: true })
  const jobs: { directory: string; updatedAt: string }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !validateUuid(entry.name)) continue
    const directory = join(root, entry.name)
    try {
      await assertSecureJobDirectory(directory)
      const state = await reconcileJob(directory)
      jobs.push({ directory, updatedAt: state.updated_at })
    } catch (error) {
      if (error instanceof JobError && error.code === 'JOB_CORRUPT') throw error
    }
  }
  return jobs
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(job => job.directory)
}

export function streamJobTranscript(
  jobDirectory: string,
  output: NodeJS.WritableStream,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const input = createReadStream(getJobPaths(jobDirectory).transcript)
    input.on('error', error => reject(asJobError(error)))
    output.on('error', reject)
    input.on('end', resolvePromise)
    input.pipe(output, { end: false })
  })
}

export function isPathInside(root: string, candidate: string): boolean {
  const relativeRoot = resolve(root)
  const relativeCandidate = resolve(candidate)
  return (
    relativeCandidate === relativeRoot ||
    relativeCandidate.startsWith(relativeRoot + sep)
  )
}
