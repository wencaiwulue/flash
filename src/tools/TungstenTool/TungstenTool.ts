import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { PermissionResult } from '../../types/permissions.js'
import { BashTool } from '../BashTool/BashTool.js'
import {
  checkTmuxAvailable,
  ensureSocketInitialized,
  getClaudeSocketName,
  isSocketInitialized,
  markTmuxToolUsed,
} from '../../utils/tmuxSocket.js'
import {
  captureTungstenSession,
  execTmuxCommand,
  listTungstenSessions,
} from './utils.js'

const nameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({
    action: z.literal('create'),
    name: nameSchema.refine(value => value !== 'base', 'The base session is reserved.'),
    cwd: z.string().min(1).max(4096).optional(),
    command: z.string().min(1).max(100_000).optional(),
  }),
  z.strictObject({
    action: z.literal('send'),
    name: nameSchema,
    text: z.string().max(100_000),
    enter: z.boolean().default(true),
  }),
  z.strictObject({
    action: z.literal('capture'),
    name: nameSchema,
    lines: z.number().int().min(1).max(10_000).default(200),
  }),
  z.strictObject({ action: z.literal('kill'), name: nameSchema }),
])
const outputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('list'),
    sessions: z.array(
      z.strictObject({
        name: z.string(),
        windows: z.number(),
        attached: z.boolean(),
      }),
    ),
  }),
  z.strictObject({ action: z.literal('create'), name: z.string(), target: z.string() }),
  z.strictObject({ action: z.literal('send'), name: z.string(), enter: z.boolean() }),
  z.strictObject({ action: z.literal('capture'), name: z.string(), content: z.string() }),
  z.strictObject({ action: z.literal('kill'), name: z.string() }),
])
type InputSchema = typeof inputSchema
type Input = z.infer<typeof inputSchema>
type Output = z.infer<typeof outputSchema>

const managedSessions = new Set<string>()
let preparation: Promise<void> | null = null

export function clearSessionsWithTungstenUsage(): boolean {
  const changed = managedSessions.size > 0
  managedSessions.clear()
  return changed
}

export function resetInitializationState(): boolean {
  const changed = preparation !== null
  preparation = null
  return changed
}

export function getManagedTungstenSessions(): ReadonlySet<string> {
  return managedSessions
}

async function prepareTungsten(): Promise<void> {
  if (preparation) return preparation
  preparation = (async () => {
    if (!(await checkTmuxAvailable())) {
      throw new Error('tmux is not installed (or is unavailable in WSL).')
    }
    markTmuxToolUsed()
    await ensureSocketInitialized()
    if (!isSocketInitialized()) {
      throw new Error('Failed to initialize Claude\'s isolated tmux socket.')
    }
  })()
  try {
    await preparation
  } catch (error) {
    preparation = null
    throw error
  }
}

async function run(input: Input): Promise<Output> {
  await prepareTungsten()
  switch (input.action) {
    case 'list':
      return { action: 'list', sessions: await listTungstenSessions() }
    case 'create': {
      const args = [
        'new-session',
        '-d',
        '-s',
        input.name,
        '-P',
        '-F',
        '#{session_name}:0.0',
        ...(input.cwd ? ['-c', input.cwd] : []),
        ...(input.command ? [input.command] : []),
      ]
      const result = await execTmuxCommand(args)
      if (result.code !== 0) {
        throw new Error(`tmux new-session failed for ${input.name}: ${result.stderr || `exit ${result.code}`}`)
      }
      managedSessions.add(input.name)
      return {
        action: 'create',
        name: input.name,
        target: result.stdout.trim() || `${input.name}:0.0`,
      }
    }
    case 'send': {
      const literal = await execTmuxCommand([
        'send-keys',
        '-t',
        input.name,
        '-l',
        input.text,
      ])
      if (literal.code !== 0) {
        throw new Error(`tmux send-keys failed for ${input.name}: ${literal.stderr || `exit ${literal.code}`}`)
      }
      if (input.enter) {
        const enter = await execTmuxCommand(['send-keys', '-t', input.name, 'Enter'])
        if (enter.code !== 0) {
          throw new Error(`tmux Enter failed for ${input.name}: ${enter.stderr || `exit ${enter.code}`}`)
        }
      }
      return { action: 'send', name: input.name, enter: input.enter }
    }
    case 'capture':
      return {
        action: 'capture',
        name: input.name,
        content: await captureTungstenSession(input.name, input.lines),
      }
    case 'kill': {
      if (!managedSessions.has(input.name)) {
        throw new Error(`Refusing to kill unmanaged tmux session ${input.name}.`)
      }
      const result = await execTmuxCommand(['kill-session', '-t', input.name])
      if (result.code !== 0) {
        throw new Error(`tmux kill-session failed for ${input.name}: ${result.stderr || `exit ${result.code}`}`)
      }
      managedSessions.delete(input.name)
      return { action: 'kill', name: input.name }
    }
  }
}

function outputText(output: Output): string {
  switch (output.action) {
    case 'list':
      return output.sessions.length
        ? output.sessions
            .map(session => `${session.name}\t${session.windows} windows${session.attached ? '\tattached' : ''}`)
            .join('\n')
        : 'No tmux sessions.'
    case 'create':
      return `Created tmux session ${output.name} (${output.target}).`
    case 'send':
      return `Sent literal text to ${output.name}${output.enter ? ' with Enter' : ''}.`
    case 'capture':
      return output.content || 'Pane is empty.'
    case 'kill':
      return `Killed tmux session ${output.name}.`
  }
}

export const TungstenTool = buildTool({
  name: 'Tungsten',
  maxResultSizeChars: 500_000,
  inputSchema,
  outputSchema,
  isEnabled: () => true,
  isReadOnly: input => input.action === 'list' || input.action === 'capture',
  isConcurrencySafe: input => input.action === 'list' || input.action === 'capture',
  isDestructive: input => input.action === 'kill',
  async description() {
    return 'Manage isolated tmux sessions on Claude\'s own socket.'
  },
  async prompt() {
    return 'Use list, create, send, capture, or kill to manage isolated tmux sessions. send transmits text literally. kill only works for sessions created by this tool. Commands in create require normal Bash permission.'
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    if (input.action !== 'create' || !input.command) {
      return { behavior: 'allow', updatedInput: input }
    }
    const result = await BashTool.checkPermissions(
      { command: input.command, description: `Run in tmux session ${input.name}` },
      context,
    )
    if (result.behavior === 'deny' || result.behavior === 'passthrough') return result
    return {
      ...result,
      updatedInput: {
        ...input,
        command: result.updatedInput?.command ?? input.command,
      },
    } as PermissionResult
  },
  toAutoClassifierInput(input) {
    return input.action === 'create' && input.command
      ? { action: input.action, name: input.name, command: input.command }
      : { action: input.action, ...(input.action !== 'list' ? { name: input.name } : {}) }
  },
  renderToolUseMessage(input) {
    if (!input.action) return null
    return input.action === 'list'
      ? 'List isolated tmux sessions'
      : `${input.action} isolated tmux session${'name' in input && input.name ? ` ${input.name}` : ''}`
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: outputText(output) }
  },
  async call(input, context) {
    const data = await run(input)
    if (input.action !== 'list' && input.action !== 'kill') {
      const target = data.action === 'create' ? data.target : `${input.name}:0.0`
      context.setAppState(previous => ({
        ...previous,
        tungstenActiveSession: {
          sessionName: input.name,
          socketName: getClaudeSocketName(),
          target,
        },
        tungstenPanelAutoHidden: false,
        ...(input.action === 'send'
          ? {
              tungstenLastCommand: {
                command: input.text || 'Enter',
                timestamp: Date.now(),
              },
            }
          : {}),
      }))
    }
    if (input.action === 'kill') {
      context.setAppState(previous =>
        previous.tungstenActiveSession?.sessionName === input.name
          ? { ...previous, tungstenActiveSession: undefined }
          : previous,
      )
    }
    return { data }
  },
} satisfies ToolDef<InputSchema, Output>)
