import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  createSnipMarkerMessage,
  isSnipRuntimeEnabled,
  resolveSnipTargets,
} from '../../services/compact/snipCompact.js'
import { SNIP_TOOL_NAME, SNIP_TOOL_PROMPT } from './prompt.js'

const inputSchema = z.strictObject({
  message_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe('Short [id:...] values of older messages to snip'),
})
type InputSchema = typeof inputSchema
const outputSchema = z.object({
  message: z.string(),
  messageIds: z.array(z.string()),
})
type Output = z.infer<typeof outputSchema>

export const SnipTool = buildTool({
  name: SNIP_TOOL_NAME,
  inputSchema,
  outputSchema,
  maxResultSizeChars: 2_000,
  isEnabled: isSnipRuntimeEnabled,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  async description() {
    return 'Snip selected older messages from the active context'
  },
  async prompt() {
    return SNIP_TOOL_PROMPT
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async validateInput({ message_ids }, { messages }) {
    const { targets, invalidIds } = resolveSnipTargets(messages, message_ids)
    if (targets.size === 0 || invalidIds.length > 0) {
      return {
        result: false as const,
        message: `Unavailable or protected message ID(s): ${invalidIds.join(', ') || message_ids.join(', ')}`,
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  async call({ message_ids }) {
    return {
      data: {
        message: `Snip queued for ${message_ids.length} message ID(s).`,
        messageIds: message_ids,
      },
      newMessages: [createSnipMarkerMessage(message_ids)],
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
