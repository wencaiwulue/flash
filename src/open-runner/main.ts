import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { OpenRunnerClient } from './client.js'
import {
  OpenRunnerError,
  errorResponse,
  isUuid,
  readTokenFile,
  type PermissionMode,
} from './protocol.js'
import { startOpenRunnerServer } from './server.js'
import { runOpenRunnerWorker } from './worker.js'

type Args = { _: string[]; [key: string]: unknown }

function parseArgs(args: string[]): Args {
  const result: Args = { _: [] as string[] }
  const valueFlags = new Set([
    'host', 'port', 'state-dir', 'worker-token-file', 'admin-token-file',
    'server', 'runner-id', 'workspace', 'token-file', 'max-work', 'work-id',
    'prompt', 'cwd', 'model', 'permission-mode', 'max-attempts',
    'max-runtime-ms', 'after', 'limit', 'reason', 'state',
  ])
  const booleanFlags = new Set(['once'])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') {
      result._.push(...args.slice(index + 1))
      break
    }
    if (!arg.startsWith('--')) {
      result._.push(arg)
      continue
    }
    const [rawFlag, inline] = arg.slice(2).split('=', 2)
    const flag = rawFlag!
    if (booleanFlags.has(flag)) {
      if (inline !== undefined) throw new OpenRunnerError('INVALID_REQUEST', `--${flag} takes no value`, 400)
      result[flag] = true
      continue
    }
    if (!valueFlags.has(flag)) throw new OpenRunnerError('INVALID_REQUEST', `Unknown option --${flag}`, 400)
    const value = inline ?? args[++index]
    if (value === undefined) throw new OpenRunnerError('INVALID_REQUEST', `--${flag} requires a value`, 400)
    result[flag] = value
  }
  return result
}

function required(args: Args, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value) {
    throw new OpenRunnerError('INVALID_REQUEST', `--${name} is required`, 400)
  }
  return value
}

function integer(args: Args, name: string, fallback?: number): number | undefined {
  const raw = args[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new OpenRunnerError('INVALID_REQUEST', `--${name} must be an integer`, 400)
  return value
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function client(args: Args): Promise<OpenRunnerClient> {
  return new OpenRunnerClient({
    serverUrl: required(args, 'server'),
    token: await readTokenFile(required(args, 'token-file')),
  })
}

function isHelpRequest(argv: string[]): boolean {
  return (
    (argv.length === 1 || argv.length === 2) &&
    (argv.includes('--help') || argv.includes('-h'))
  )
}

function printWorkerUsage(): void {
  process.stdout.write(
    'Usage: claude open-runner run --server <url> --token-file <path> --runner-id <uuid> --workspace <dir> [--once]\n' +
      '       claude open-runner submit|status|events|cancel [options]\n' +
      '       claude open-runner-server --worker-token-file <path> --admin-token-file <path> [--host <addr>] [--port <n>]\n',
  )
}

async function executeOpenRunnerMain(argv: string[]): Promise<void> {
  if (isHelpRequest(argv)) {
    printWorkerUsage()
    return
  }
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  if (command === 'run') {
    const runnerId = required(args, 'runner-id')
    if (!isUuid(runnerId)) throw new OpenRunnerError('INVALID_REQUEST', '--runner-id must be a UUID', 400)
    const records = await runOpenRunnerWorker({
      client: await client(args),
      runnerId,
      workspace: required(args, 'workspace'),
      ...(args['state-dir'] ? { stateDir: String(args['state-dir']) } : {}),
      maxWork: integer(args, 'max-work', 1),
      once: Boolean(args.once),
    })
    for (const record of records) output({ protocol: 'open-runner-v1', work: record })
    return
  }
  if (command === 'submit') {
    const workId = required(args, 'work-id')
    const mode = (args['permission-mode'] ?? 'default') as string
    if (!['default', 'acceptEdits', 'plan'].includes(mode)) {
      throw new OpenRunnerError('INVALID_REQUEST', 'Invalid --permission-mode', 400)
    }
    const work = await (await client(args)).submit({
      work_id: workId,
      input: {
        prompt: required(args, 'prompt'),
        cwd: typeof args.cwd === 'string' ? args.cwd : '.',
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        permission_mode: mode as PermissionMode,
      },
      ...(integer(args, 'max-attempts') !== undefined ? { max_attempts: integer(args, 'max-attempts')! } : {}),
      ...(integer(args, 'max-runtime-ms') !== undefined ? { max_runtime_ms: integer(args, 'max-runtime-ms')! } : {}),
    })
    output({ protocol: 'open-runner-v1', work })
    return
  }
  if (command === 'status' || command === 'events' || command === 'cancel') {
    const workId = args._[0] ?? (typeof args['work-id'] === 'string' ? args['work-id'] : undefined)
    if (!workId) throw new OpenRunnerError('INVALID_REQUEST', 'A work ID is required', 400)
    const openClient = await client(args)
    if (command === 'status') {
      output({ protocol: 'open-runner-v1', work: await openClient.getWork(workId) })
    } else if (command === 'events') {
      output({
        protocol: 'open-runner-v1',
        ...(await openClient.readEvents(workId, integer(args, 'after', 0), integer(args, 'limit', 100))),
      })
    } else {
      output({
        protocol: 'open-runner-v1',
        work: await openClient.cancel(workId, typeof args.reason === 'string' ? args.reason : undefined),
      })
    }
    return
  }
  throw new OpenRunnerError('INVALID_REQUEST', `Unknown open-runner command: ${command ?? ''}`, 400)
}

function reportCommandError(error: unknown): void {
  process.stderr.write(`${JSON.stringify(errorResponse(error))}\n`)
  process.exitCode = 1
}

export async function openRunnerMain(argv: string[]): Promise<void> {
  try {
    await executeOpenRunnerMain(argv)
  } catch (error) {
    reportCommandError(error)
  }
}

export async function openRunnerServerMain(argv: string[]): Promise<void> {
  try {
    await executeOpenRunnerServerMain(argv)
  } catch (error) {
    reportCommandError(error)
  }
}

async function executeOpenRunnerServerMain(argv: string[]): Promise<void> {
  if (isHelpRequest(argv)) {
    printWorkerUsage()
    return
  }
  const args = parseArgs(argv)
  if (args._.length) throw new OpenRunnerError('INVALID_REQUEST', 'Unexpected server arguments', 400)
  const server = await startOpenRunnerServer({
    host: typeof args.host === 'string' ? args.host : '127.0.0.1',
    port: integer(args, 'port', 0),
    stateDir:
      typeof args['state-dir'] === 'string'
        ? args['state-dir']
        : join(getClaudeConfigHomeDir(), 'open-runner', 'server'),
    workerTokenFile: required(args, 'worker-token-file'),
    adminTokenFile: required(args, 'admin-token-file'),
  })
  output({ ...server.serverInfo, protocol: 'open-runner-v1' })
  await new Promise<void>(resolve => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      void server.stop().then(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
