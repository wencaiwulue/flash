import { z } from 'zod/v4'
import {
  OUTPUT_FILE_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getMaxTimeoutMs } from '../BashTool/prompt.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { exec } from '../../utils/Shell.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { escapeXml } from '../../utils/xml.js'

const inputSchema = z.strictObject({
  command: z.string().describe('Shell command whose output lines become events'),
  description: z
    .string()
    .optional()
    .describe('Short human-readable description of the monitor'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(getMaxTimeoutMs())
    .optional()
    .describe(`Maximum runtime in milliseconds (up to ${getMaxTimeoutMs()})`),
  dangerouslyDisableSandbox: z.boolean().optional(),
})
type InputSchema = typeof inputSchema
const outputSchema = z.object({
  message: z.string(),
  task_id: z.string(),
})
type Output = z.infer<typeof outputSchema>

/** Split arbitrary stdout chunks into complete lines without losing bursts. */
export function createMonitorOutputReporter(report: (line: string) => void) {
  let pending = ''
  let finished = false
  return {
    push(chunk: string): void {
      if (finished) return
      const lines = (pending + chunk).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) report(line.replace(/\r$/, ''))
    },
    finish(): void {
      if (finished) return
      finished = true
      if (pending) report(pending.replace(/\r$/, ''))
      pending = ''
    },
  }
}

function notifyMonitorOutput(
  taskId: string,
  description: string,
  line: string,
  toolUseId: string | undefined,
  agentId: ToolUseContext['agentId'],
): void {
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  enqueuePendingNotification({
    value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(taskId)}</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>${escapeXml(`Monitor "${description}" output`)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>
${escapeXml(line)}`,
    mode: 'task-notification',
    priority: 'next',
    agentId,
  })
}

export const MonitorTool = buildTool({
  name: 'Monitor',
  maxResultSizeChars: 1_000,
  inputSchema,
  outputSchema,
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  renderToolUseMessage() {
    return null
  },
  toAutoClassifierInput: input => input.command,
  getToolUseSummary: input => input?.description || input?.command || null,
  async description() {
    return 'Run a background command and stream each output line as an event'
  },
  async prompt() {
    return 'Start a monitored background shell command. Each new output line is delivered as a task notification; process exit ends the stream. Use this for watch commands and streaming event sources, not for one-shot commands (use Bash with run_in_background instead). The command has the same permission and sandbox checks as Bash.'
  },
  async checkPermissions(input, context) {
    const { bashToolHasPermission } = await import(
      '../BashTool/bashPermissions.js'
    )
    return bashToolHasPermission(
      {
        ...input,
        run_in_background: true,
      } as import('../BashTool/BashTool.js').BashToolInput,
      context,
    )
  },
  async call(input, context) {
    const { shouldUseSandbox } = await import(
      '../BashTool/shouldUseSandbox.js'
    )
    const description = input.description || input.command
    const abortController = context.abortController
    const agentId = context.agentId
    const toolUseId = context.toolUseId
    let taskId: string | undefined
    const earlyLines: string[] = []
    const reportOutput = createMonitorOutputReporter(line => {
      if (taskId) {
        notifyMonitorOutput(taskId, description, line, toolUseId, agentId)
      } else {
        earlyLines.push(line)
      }
    })
    const shellCommand = await exec(input.command, abortController.signal, 'bash', {
      timeout: input.timeout ?? getMaxTimeoutMs(),
      shouldUseSandbox: shouldUseSandbox(input),
      onStdout: chunk => reportOutput.push(chunk),
    })
    void shellCommand.result.then(() => reportOutput.finish())
    taskId = shellCommand.taskOutput.taskId
    for (const line of earlyLines) {
      notifyMonitorOutput(taskId, description, line, toolUseId, agentId)
    }
    earlyLines.length = 0
    await spawnShellTask(
      {
        command: input.command,
        description,
        shellCommand,
        toolUseId,
        agentId,
        kind: 'monitor',
      },
      {
        abortController,
        getAppState: context.getAppState,
        setAppState: context.setAppStateForTasks ?? context.setAppState,
      },
    )
    return {
      data: {
        message: `Monitor started: ${taskId}. New output lines will arrive as task notifications.`,
        task_id: taskId,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
