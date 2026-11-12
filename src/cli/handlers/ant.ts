import type { Command as CommanderCommand } from '@commander-js/extra-typings'
import { randomBytes } from 'crypto'
import { open, lstat, link, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { getTools } from '../../tools.js'
import { getEmptyToolPermissionContext, type Tools } from '../../Tool.js'
import type { LogOption } from '../../types/logs.js'
import type { Task } from '../../utils/tasks.js'
import {
  createTask,
  DEFAULT_TASKS_MODE_TASK_LIST_ID,
  getTask,
  getTasksDir,
  listTasks,
  TaskStatusSchema,
  updateTask,
} from '../../utils/tasks.js'
import {
  getErrorLogByIndex,
  loadErrorLogs,
} from '../../utils/log.js'
import { renderMessagesToPlainText } from '../../utils/exportRenderer.js'
import {
  getLastSessionLog,
  getLogByIndex,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
  loadTranscriptFromFile,
} from '../../utils/sessionStorage.js'
import { writeToStderr, writeToStdout } from '../../utils/process.js'
import { validateUuid } from '../../utils/uuid.js'
import { jsonStringify } from '../../utils/slowOperations.js'

function fail(message: string): void {
  writeToStderr(`Error: ${message}\n`)
  process.exitCode = 1
}

function formatLogList(logs: LogOption[]): string {
  if (logs.length === 0) return 'No logs found.\n'
  return `${logs
    .map(
      log =>
        `${log.value}\t${log.modified.toISOString()}\t${log.messageCount} messages\t${log.firstPrompt}`,
    )
    .join('\n')}\n`
}

function cliTools(): Tools {
  return getTools(getEmptyToolPermissionContext())
}

async function resolveConversationLog(
  source: string | number,
): Promise<LogOption | null> {
  if (typeof source === 'number') {
    if (!Number.isSafeInteger(source) || source < 0) return null
    return getLogByIndex(source)
  }
  const sessionId = validateUuid(source)
  return sessionId ? getLastSessionLog(sessionId) : null
}

export async function logHandler(
  logId: string | number | undefined,
): Promise<void> {
  if (logId === undefined) {
    writeToStdout(formatLogList(await loadMessageLogs()))
    return
  }
  const loaded = await resolveConversationLog(logId)
  if (!loaded) {
    fail(`Conversation log not found: ${String(logId)}`)
    return
  }
  const log = isLiteLog(loaded) ? await loadFullLog(loaded) : loaded
  writeToStdout(await renderMessagesToPlainText(log.messages, cliTools()))
}

export async function errorHandler(number: number | undefined): Promise<void> {
  if (number === undefined) {
    writeToStdout(formatLogList(await loadErrorLogs()))
    return
  }
  if (!Number.isSafeInteger(number)) {
    fail('Error log index must be an integer.')
    return
  }
  const log = await getErrorLogByIndex(number)
  if (!log?.fullPath) {
    fail(`Error log not found at index ${number}.`)
    return
  }
  // Error logs may contain credentials or source fragments. Do not parse or
  // evaluate them; cap display to the most recent 1 MiB for terminal safety.
  const handle = await open(log.fullPath, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, 1024 * 1024)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, size - length))
    if (size > length) writeToStderr('Showing the last 1 MiB of the error log.\n')
    writeToStdout(buffer.toString('utf8'))
  } finally {
    await handle.close()
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  // Write a private temporary file fully, then publish it with link(2). link
  // fails with EEXIST rather than replacing an existing destination, and the
  // rename only removes the temporary name (the destination is never renamed).
  const temporary = join(
    dirname(path),
    `.claude-export-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  )
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, path)
    await unlink(temporary)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function exportHandler(
  source: string,
  outputFile: string,
): Promise<void> {
  let log: LogOption | null = null
  if (/\.jsonl?$/.test(source)) {
    const info = await lstat(source).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) {
      fail('Transcript source must be a regular, non-symlink JSON or JSONL file.')
      return
    }
    log = await loadTranscriptFromFile(source)
  } else if (/^(0|[1-9]\d*)$/.test(source)) {
    log = await getLogByIndex(Number(source))
  } else if (validateUuid(source)) {
    log = await resolveConversationLog(source)
  } else {
    fail('Source must be a decimal log index, session UUID, or .json/.jsonl file.')
    return
  }
  if (!log) {
    fail(`Conversation log not found: ${source}`)
    return
  }
  const fullLog = isLiteLog(log) ? await loadFullLog(log) : log
  const rendered = await renderMessagesToPlainText(fullLog.messages, cliTools())
  await writeExclusive(outputFile, rendered)
  writeToStdout(`Exported ${fullLog.messages.length} messages to ${outputFile}\n`)
}

function taskList(options: { list?: string }): string {
  return options.list ?? DEFAULT_TASKS_MODE_TASK_LIST_ID
}

function printTask(task: Task): void {
  writeToStdout(`${jsonStringify(task, null, 2)}\n`)
}

export async function taskCreateHandler(
  subject: string,
  options: { description?: string; list?: string },
): Promise<void> {
  const id = await createTask(taskList(options), {
    subject,
    description: options.description ?? '',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  })
  writeToStdout(`${id}\n`)
}

export async function taskListHandler(options: {
  list?: string
  pending?: boolean
  json?: boolean
}): Promise<void> {
  const tasks = (await listTasks(taskList(options)))
    .filter(task => !options.pending || task.status === 'pending')
    .sort((a, b) => {
      const aId = Number(a.id)
      const bId = Number(b.id)
      if (Number.isSafeInteger(aId) && Number.isSafeInteger(bId)) return aId - bId
      return a.id.localeCompare(b.id, undefined, { numeric: true })
    })
  if (options.json) {
    writeToStdout(`${jsonStringify(tasks, null, 2)}\n`)
    return
  }
  if (tasks.length === 0) {
    writeToStdout('No tasks found.\n')
    return
  }
  writeToStdout(
    `${tasks
      .map(task => {
        const owner = task.owner ? ` owner=${task.owner}` : ''
        return `${task.id}\t${task.status}\t${task.subject}${owner}`
      })
      .join('\n')}\n`,
  )
}

export async function taskGetHandler(
  id: string,
  options: { list?: string },
): Promise<void> {
  const task = await getTask(taskList(options), id)
  if (!task) {
    fail(`Task not found: ${id}`)
    return
  }
  printTask(task)
}

export async function taskUpdateHandler(
  id: string,
  options: {
    list?: string
    status?: string
    subject?: string
    description?: string
    owner?: string
    clearOwner?: boolean
  },
): Promise<void> {
  if (options.owner !== undefined && options.clearOwner) {
    fail('--owner and --clear-owner are mutually exclusive.')
    return
  }
  const updates: Partial<Omit<Task, 'id'>> = {}
  if (options.status !== undefined) {
    const parsed = TaskStatusSchema().safeParse(options.status)
    if (!parsed.success) {
      fail(`Invalid task status: ${options.status}`)
      return
    }
    updates.status = parsed.data
  }
  if (options.subject !== undefined) updates.subject = options.subject
  if (options.description !== undefined) updates.description = options.description
  if (options.owner !== undefined) updates.owner = options.owner
  if (options.clearOwner) updates.owner = undefined
  const task = await updateTask(taskList(options), id, updates)
  if (!task) {
    fail(`Task not found: ${id}`)
    return
  }
  printTask(task)
}

export async function taskDirHandler(options: {
  list?: string
}): Promise<void> {
  writeToStdout(`${getTasksDir(taskList(options))}\n`)
}

type CompletionNode = {
  path: string[]
  description: string
  options: string[]
  children: CompletionNode[]
}

function cleanDescription(value: string): string {
  return value.replace(/[\r\n\0]/g, ' ').trim()
}

function completionTree(program: CommanderCommand): CompletionNode {
  const walk = (command: CommanderCommand, path: string[]): CompletionNode => ({
    path,
    description: cleanDescription(command.description()),
    options: command.options.flatMap(option => {
      const value = option.required || option.optional
        ? option.argChoices?.length
          ? ` <${option.argChoices.join('|')}>`
          : ' <value>'
        : ''
      return [option.short, option.long]
        .filter((flag): flag is string => Boolean(flag))
        .map(flag => `${flag}${value}`)
    }),
    children: command.commands
      .filter(child => !(child as unknown as { _hidden?: boolean })._hidden)
      .map(child => walk(child as CommanderCommand, [...path, child.name()])),
  })
  return walk(program, [])
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function bashCompletion(root: CompletionNode, name: string): string {
  const functionName = `_claude_completion_${randomBytes(4).toString('hex')}`
  const lines = ['# Generated by claude completion; static data only.', `${functionName}() {`, '  local cur="${COMP_WORDS[COMP_CWORD]}"', '  local words=""', `  case "${'${COMP_WORDS[@]:1:COMP_CWORD-1}'}" in`]
  const visit = (node: CompletionNode): void => {
    const key = node.path.join(' ')
    const words = [...node.children.map(child => child.path.at(-1)!), ...node.options].join(' ')
    lines.push(`    ${shQuote(key)}) words=${shQuote(words)} ;;`)
    node.children.forEach(visit)
  }
  visit(root)
  lines.push('  esac', '  COMPREPLY=( $(compgen -W "$words" -- "$cur") )', '}', `complete -F ${functionName} ${shQuote(name)}`, '')
  return lines.join('\n')
}

function zshCompletion(root: CompletionNode, name: string): string {
  const lines = ['#compdef ' + name.replace(/[^A-Za-z0-9_.-]/g, '_'), '# Generated static completion; descriptions are single-quoted data.', `_${name.replace(/[^A-Za-z0-9_]/g, '_')}_completion() {`, '  local -a commands', '  local -a options', '  case $words[2,$((CURRENT-1))] in']
  const visit = (node: CompletionNode): void => {
    lines.push(`    ${shQuote(node.path.join(' '))})`)
    lines.push('      commands=(')
    for (const child of node.children) lines.push(`        ${shQuote(`${child.path.at(-1)}:${child.description}`)}`)
    lines.push('      )', '      options=(')
    for (const option of node.options) lines.push(`        ${shQuote(option)}`)
    lines.push('      )', '      _describe command commands', '      _arguments $options', '      ;;')
    node.children.forEach(visit)
  }
  visit(root)
  lines.push('  esac', '}', `compdef _${name.replace(/[^A-Za-z0-9_]/g, '_')}_completion ${shQuote(name)}`, '')
  return lines.join('\n')
}

function fishCompletion(root: CompletionNode, name: string): string {
  const lines = ['# Generated static fish completion.']
  const quotedName = shQuote(name)
  const visit = (node: CompletionNode): void => {
    const condition = node.path.length
      ? `__fish_seen_subcommand_from ${node.path.map(shQuote).join(' ')}`
      : '__fish_use_subcommand'
    for (const child of node.children) {
      lines.push(`complete -c ${quotedName} -n ${shQuote(condition)} -a ${shQuote(child.path.at(-1)!)} -d ${shQuote(child.description)}`)
    }
    for (const option of node.options) {
      const match = /^(?:-([^-]), )?(--?[A-Za-z0-9][^\s]*)(?: <(.*)>)?$/.exec(option)
      if (!match) continue
      const flag = match[2]!
      const args = [`complete -c ${quotedName}`, `-n ${shQuote(condition)}`]
      if (flag.startsWith('--')) args.push(`-l ${shQuote(flag.slice(2))}`)
      else args.push(`-s ${shQuote(flag.slice(1))}`)
      if (match[3]) args.push('-r')
      lines.push(args.join(' '))
    }
    node.children.forEach(visit)
  }
  visit(root)
  lines.push('')
  return lines.join('\n')
}

export function generateCompletion(
  shell: string,
  program: CommanderCommand,
): string {
  const tree = completionTree(program)
  switch (shell) {
    case 'bash':
      return bashCompletion(tree, program.name())
    case 'zsh':
      return zshCompletion(tree, program.name())
    case 'fish':
      return fishCompletion(tree, program.name())
    default:
      throw new Error(`Unsupported shell ${shell}. Expected bash, zsh, or fish.`)
  }
}

export async function completionHandler(
  shell: string,
  options: { output?: string },
  program: CommanderCommand,
): Promise<void> {
  let script: string
  try {
    script = generateCompletion(shell, program)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return
  }
  if (options.output) await writeExclusive(options.output, script)
  else writeToStdout(script)
}
