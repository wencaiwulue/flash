import { Ajv } from 'ajv'
import type { Tool } from '../../Tool.js'
import type { Message } from '../../types/message.js'

export type SavedToolResult = {
  messageId: string
  timestamp: string
  content: unknown
  isError: boolean
}

export type SavedToolCall = {
  id: string
  name: string
  input: unknown
  messageId: string
  timestamp: string
  results: SavedToolResult[]
}

/** Read-only pairing. Duplicate ids and duplicate results are intentionally preserved. */
export function collectToolCalls(messages: readonly Message[]): SavedToolCall[] {
  const calls: SavedToolCall[] = []
  const results = new Map<string, SavedToolResult[]>()
  for (const message of messages) {
    const messageId = 'uuid' in message ? message.uuid : 'unknown'
    const timestamp = 'timestamp' in message ? message.timestamp : ''
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          calls.push({
            id: block.id,
            name: block.name,
            input: block.input,
            messageId,
            timestamp,
            results: [],
          })
        }
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue
        const saved: SavedToolResult = {
          messageId,
          timestamp,
          content: block.content,
          isError: block.is_error === true,
        }
        const existing = results.get(block.tool_use_id) ?? []
        existing.push(saved)
        results.set(block.tool_use_id, existing)
      }
    }
  }
  for (const call of calls) call.results = results.get(call.id) ?? []
  return calls
}

export type SchemaInspection =
  | { status: 'valid' }
  | { status: 'invalid'; message: string }
  | { status: 'unavailable'; message: string }

/** Schema-only validation; never call validateInput/checkPermissions/call. */
export function inspectSavedInputSchema(
  call: SavedToolCall,
  tool: Tool | undefined,
): SchemaInspection {
  if (!tool) {
    return { status: 'unavailable', message: 'Tool schema is not loaded in this session' }
  }
  try {
    if (tool.inputJSONSchema) {
      const ajv = new Ajv({ allErrors: true, strict: false })
      const validate = ajv.compile(tool.inputJSONSchema)
      return validate(call.input)
        ? { status: 'valid' }
        : {
            status: 'invalid',
            message: (validate.errors ?? [])
              .map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
              .join('; ').slice(0, 2000),
          }
    }
    const parsed = tool.inputSchema.safeParse(call.input)
    return parsed.success
      ? { status: 'valid' }
      : { status: 'invalid', message: parsed.error.message.slice(0, 2000) }
  } catch (error) {
    return {
      status: 'unavailable',
      message: `Schema validation unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
    }
  }
}

function formatValue(value: unknown, maxLength = 4000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}\n… [truncated ${text.length - maxLength} characters]`
    : text
}

export function formatSavedToolCalls(
  calls: readonly SavedToolCall[],
  tools: readonly Tool[],
  validate: boolean,
): string {
  return calls.map(call => {
    const tool = tools.find(candidate => candidate.name === call.name || candidate.aliases?.includes(call.name))
    const lines = [
      `Tool use: ${call.id}`,
      `Tool: ${call.name}${tool?.mcpInfo ? ` (MCP ${tool.mcpInfo.serverName}/${tool.mcpInfo.toolName})` : ''}`,
      `Message: ${call.messageId} at ${call.timestamp || 'unknown time'}`,
      `Input:\n${formatValue(call.input)}`,
    ]
    if (call.results.length === 0) lines.push('Result: missing')
    call.results.forEach((result, index) => {
      const elapsed = call.timestamp && result.timestamp
        ? Date.parse(result.timestamp) - Date.parse(call.timestamp)
        : Number.NaN
      lines.push(
        `Result ${index + 1}/${call.results.length}: ${result.isError ? 'error' : 'success'}${Number.isFinite(elapsed) ? `; elapsed=${Math.max(0, elapsed)}ms` : ''}`,
        formatValue(result.content),
      )
    })
    if (validate) {
      const schema = inspectSavedInputSchema(call, tool)
      lines.push(`Schema: ${schema.status}${'message' in schema ? ` — ${schema.message}` : ''}`)
    }
    lines.push('Read-only inspection: no replay, tool execution, or permission check performed.')
    return lines.join('\n')
  }).join('\n\n---\n\n')
}
