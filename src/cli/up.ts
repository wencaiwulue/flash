import { lstat, readFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { createInterface } from 'readline/promises'
import { QueryEngine } from '../QueryEngine.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getTools } from '../tools.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { AppState } from '../state/AppState.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { writeToStderr, writeToStdout } from '../utils/process.js'

export type UpSection = { path: string; instructions: string }
export type UpOptions = {
  cwd?: string
  confirm?: (plan: UpSection) => Promise<boolean>
  /** Test/integration seam. Production uses QueryEngine below. */
  execute?: (instructions: string, cwd: string) => Promise<void>
}

export function extractClaudeUpSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/)
  let start = -1
  let level = 0
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+claude up\s*$/i.exec(lines[index]!.trim())
    if (match) {
      start = index + 1
      level = match[1]!.length
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let index = start; index < lines.length; index++) {
    const heading = /^(#{1,6})\s+/.exec(lines[index]!.trim())
    if (heading && heading[1]!.length <= level) {
      end = index
      break
    }
  }
  const instructions = lines.slice(start, end).join('\n').trim()
  return instructions || null
}

export async function findClaudeUpSection(cwd: string): Promise<UpSection | null> {
  let directory = resolve(cwd)
  while (true) {
    const path = join(directory, 'CLAUDE.md')
    try {
      const info = await lstat(path)
      if (info.isFile() && !info.isSymbolicLink()) {
        if (info.size > 1024 * 1024) throw new Error(`${path} is too large to inspect safely.`)
        const instructions = extractClaudeUpSection(await readFile(path, 'utf8'))
        if (instructions) return { path, instructions }
        // The nearest CLAUDE.md is authoritative, even when it has no section.
        return null
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

async function interactiveConfirmation(path: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(
      `Run the claude up plan from ${path} with normal tool permissions? [y/N] `,
    )
    return ['y', 'yes'].includes(answer.trim().toLowerCase())
  } finally {
    prompt.close()
  }
}

async function executeWithQueryEngine(instructions: string, cwd: string): Promise<void> {
  let state: AppState = getDefaultAppState()
  const getAppState = (): AppState => state
  const setAppState = (update: (previous: AppState) => AppState): void => {
    state = update(state)
  }
  const tools = getTools(state.toolPermissionContext)
  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    context,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    const result =
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        context,
        assistantMessage,
        toolUseId,
      ))
    if (result.behavior !== 'ask') return result
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return {
        behavior: 'deny',
        message: `Permission for ${tool.name} requires an interactive approval.`,
        decisionReason: { type: 'other', reason: 'Non-interactive permission denial' },
      }
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = await prompt.question(`Allow ${tool.name} for claude up? [y/N] `)
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        return {
          behavior: 'deny',
          message: `User denied ${tool.name}.`,
          decisionReason: { type: 'other', reason: 'User denied permission' },
        }
      }
      return {
        ...result,
        behavior: 'allow',
        updatedInput: result.updatedInput ?? input,
      }
    } finally {
      prompt.close()
    }
  }
  const engine = new QueryEngine({
    cwd,
    tools,
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool,
    getAppState,
    setAppState,
    readFileCache: createFileStateCacheWithSizeLimit(1000),
  })
  const prompt = `Execute the following user-approved project setup/upgrade instructions. Treat all commands and edits as requiring their normal permissions; do not bypass confirmation, sandboxing, or denial. Instructions from CLAUDE.md:\n\n${instructions}`
  for await (const event of engine.submitMessage(prompt)) {
    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'text') writeToStdout(block.text)
      }
    } else if (event.type === 'result') {
      if (!event.subtype.startsWith('success')) {
        process.exitCode = 1
        writeToStderr(`claude up did not complete successfully: ${event.subtype}\n`)
      }
    }
  }
}

export async function up(options: UpOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const section = await findClaudeUpSection(cwd)
  if (!section) {
    process.exitCode = 1
    writeToStderr('No "# claude up" section found in the nearest CLAUDE.md.\n')
    return
  }
  writeToStdout(`Plan from ${section.path}:\n\n${section.instructions}\n\n`)
  const confirmed = options.confirm
    ? await options.confirm(section)
    : isEnvTruthy(process.env.CLAUDE_CODE_UP_CONFIRM)
      ? true
      : await interactiveConfirmation(section.path)
  if (!confirmed) {
    writeToStdout('claude up cancelled; no instructions were executed.\n')
    return
  }
  await (options.execute ?? executeWithQueryEngine)(section.instructions, cwd)
}
