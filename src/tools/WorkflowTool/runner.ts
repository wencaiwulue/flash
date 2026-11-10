import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'
import type { WorkflowStep } from './schema.js'

export async function runWorkflowStep(
  step: WorkflowStep,
  prompt: string,
  signal: AbortSignal,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  transcriptSubdir?: string,
): Promise<string> {
  const [{ runAgent }, { getTools }, { GENERAL_PURPOSE_AGENT }] = await Promise.all([
    import('../AgentTool/runAgent.js'),
    import('../../tools.js'),
    import('../AgentTool/built-in/generalPurposeAgent.js'),
  ])
  const agentDefinition =
    context.options.agentDefinitions.allAgents.find(
      agent => agent.agentType === step.agentType,
    ) ?? GENERAL_PURPOSE_AGENT
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })

  try {
    const texts: string[] = []
    for await (const message of runAgent({
      agentDefinition,
      promptMessages: [createUserMessage({ content: prompt })],
      toolUseContext: context,
      canUseTool,
      isAsync: false,
      canShowPermissionPrompts: true,
      querySource: 'agent:custom',
      override: { abortController: controller },
      availableTools: getTools(context.getAppState().toolPermissionContext),
      description: step.id,
      transcriptSubdir,
    })) {
      if (message.type !== 'assistant') continue
      const text = message.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      if (text) texts.push(text)
    }
    signal.throwIfAborted()
    return texts.at(-1) ?? ''
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
