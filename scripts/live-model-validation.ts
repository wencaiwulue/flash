import { enableConfigs } from '../src/utils/config.js'
import { getDefaultAppState } from '../src/state/AppStateStore.js'
import { getMainLoopModel } from '../src/utils/model/model.js'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.js'
import { runCleanupFunctions } from '../src/utils/cleanupRegistry.js'
import { startWorkflowTask } from '../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { parseWorkflowDefinition } from '../src/tools/WorkflowTool/schema.js'
import { hasPermissionsToUseTool } from '../src/utils/permissions/permissions.js'
import { activateProactive } from '../src/proactive/index.js'
import { SleepTool } from '../src/tools/SleepTool/SleepTool.js'
import { createUserMessage, createAssistantMessage } from '../src/utils/messages.js'
import { initContextCollapse, applyCollapsesIfNeeded, getStats } from '../src/services/contextCollapse/index.js'
import { getSystemPrompt } from '../src/constants/prompts.js'
import { getUserContext, getSystemContext } from '../src/context.js'
import { asSystemPrompt } from '../src/utils/systemPromptType.js'
import { reactiveCompactOnPromptTooLong } from '../src/services/compact/reactiveCompact.js'

function context(model: string) {
  let appState = getDefaultAppState()
  return {
    options: {
      mainLoopModel: model,
      tools: [],
      agentDefinitions: { activeAgents: [], allAgents: [] },
      mcpClients: [],
      commands: [],
      debug: false,
      verbose: false,
      isNonInteractiveSession: true,
    },
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => appState,
    setAppState: (update: (previous: typeof appState) => typeof appState) => {
      appState = update(appState)
    },
    abortController: new AbortController(),
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('MODEL_LIVE_SKIPPED')
    return
  }
  enableConfigs()
  const model = getMainLoopModel()
  const toolContext = context(model)
  const workflow = parseWorkflowDefinition({
    name: 'live-flow',
    description: 'live model validation',
    steps: [{ id: 'respond', prompt: 'Return only WORKFLOW_LIVE_OK' }],
  })
  const { done } = startWorkflowTask({
    workflow,
    input: '',
    context: toolContext as never,
    canUseTool: hasPermissionsToUseTool,
  })
  const workflowResult = await done
  if (workflowResult.status !== 'completed') {
    throw new Error(`Workflow failed: ${workflowResult.error ?? workflowResult.status}`)
  }
  console.log('WORKFLOW_LIVE_OK')

  activateProactive('command')
  if (!SleepTool.isEnabled()) throw new Error('Sleep did not enable with proactive mode')
  const slept = await SleepTool.call(
    { duration: 10 },
    toolContext as never,
  )
  if (slept.data.interrupted) throw new Error('Sleep was interrupted')
  console.log('PROACTIVE_LIVE_OK')

  initContextCollapse({ contextWindow: () => 100 })
  const messages = Array.from({ length: 6 }, (_, index) =>
    createUserMessage({ content: `context-${index}-${'x'.repeat(500)}` }),
  )
  const collapsed = await applyCollapsesIfNeeded(messages, toolContext as never, 'sdk')
  if (getStats().collapsedSpans !== 1 || collapsed.messages.length !== 5) {
    throw new Error('Context collapse did not commit a real summary')
  }
  console.log('CONTEXT_COLLAPSE_LIVE_OK')

  const reactiveMessages = [
    createUserMessage({ content: 'First question' }),
    createAssistantMessage({ content: 'First answer' }),
    createUserMessage({ content: 'Follow up question' }),
  ]
  const reactive = await reactiveCompactOnPromptTooLong(reactiveMessages, {
    systemPrompt: asSystemPrompt(await getSystemPrompt([], model)),
    userContext: await getUserContext(),
    systemContext: await getSystemContext(),
    toolUseContext: toolContext as never,
    forkContextMessages: reactiveMessages,
  }, { customInstructions: undefined, trigger: 'auto' })
  if (!reactive.ok) throw new Error(`Reactive compaction failed: ${reactive.reason}`)
  console.log('REACTIVE_COMPACTION_LIVE_OK')
}

try {
  await main()
} finally {
  await runCleanupFunctions()
}
