import axios from 'axios'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'

const inputSchema = z.strictObject({
  message: z.string().min(1),
  title: z.string().optional(),
  url: z.string().url().optional(),
})
type InputSchema = typeof inputSchema
const outputSchema = z.object({ message: z.string(), deliveredVia: z.string() })
type Output = z.infer<typeof outputSchema>

export const PushNotificationTool = buildTool({
  name: 'PushNotification',
  inputSchema,
  outputSchema,
  maxResultSizeChars: 2_000,
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  async description() {
    return 'Send a notification through the OS or a configured webhook'
  },
  async prompt() {
    return 'Send a user notification through the available local OS adapter or CLAUDE_NOTIFICATION_WEBHOOK_URL. Use only for useful status updates, not routine narration. Delivery failures are reported and must not be described as sent.'
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context) {
    const webhook = process.env.CLAUDE_NOTIFICATION_WEBHOOK_URL
    if (webhook) {
      const response = await axios.post(
        webhook,
        {
          text: input.message,
          ...(input.title ? { title: input.title } : {}),
          ...(input.url ? { url: input.url } : {}),
        },
        {
          timeout: 10_000,
          signal: context.abortController.signal,
          validateStatus: () => true,
        },
      )
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Notification webhook failed (${response.status})`)
      }
      return { data: { message: 'Notification delivered by webhook.', deliveredVia: 'webhook' } }
    }
    if (context.sendOSNotification) {
      context.sendOSNotification({
        message: input.title ? `${input.title}: ${input.message}` : input.message,
        notificationType: 'info',
      })
      return { data: { message: 'Notification sent to the OS.', deliveredVia: 'os' } }
    }
    throw new Error('No notification adapter is configured')
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
