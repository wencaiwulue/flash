import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ContextVisualization } from '../../components/ContextVisualization.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { analyzeContextUsage } from '../../utils/analyzeContext.js'
import { renderToAnsiString } from '../../utils/staticRender.js'
import { toApiView } from './apiView.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const {
    messages,
    getAppState,
    options: { mainLoopModel, tools },
  } = context

  const apiView = toApiView(messages)

  // Apply microcompact to get accurate representation of messages sent to API
  const { messages: compactedMessages } = await microcompactMessages(apiView)

  // Get terminal width for responsive sizing
  const terminalWidth = process.stdout.columns || 80

  const appState = getAppState()

  // Analyze context with compacted messages
  // Pass original messages as last parameter for accurate API usage extraction
  const data = await analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    appState.agentDefinitions,
    terminalWidth,
    context, // Pass full context for system prompt calculation
    undefined, // mainThreadAgentDefinition
    apiView, // Original messages for API usage extraction
  )

  // Render to ANSI string to preserve colors and pass to onDone like local commands do
  const output = await renderToAnsiString(<ContextVisualization data={data} />)
  onDone(output)
  return null
}
