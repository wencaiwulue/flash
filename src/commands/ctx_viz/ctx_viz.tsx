import React from 'react'
import { ContextVisualization } from '../../components/ContextVisualization.js'
import { DiagnosticExportDialog } from '../../components/DiagnosticExportDialog.js'
import { Box, Text } from '../../ink.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import type { Message } from '../../types/message.js'
import {
  analyzeContextUsage,
  type ContextData,
} from '../../utils/analyzeContext.js'
import { writeNewDiagnosticJson } from '../../utils/diagnosticExport.js'
import { renderToAnsiString } from '../../utils/staticRender.js'
import { toApiView } from '../context/apiView.js'
import {
  buildContextVizExport,
  buildMessageTokenRows,
  type MessageTokenRow,
} from './messageTokens.js'

const USAGE = 'Usage: /ctx_viz [--json <path>]'

type AnalysisDependencies = {
  toApiView: (messages: Message[]) => Message[]
  microcompactMessages: typeof microcompactMessages
  analyzeContextUsage: typeof analyzeContextUsage
}

const analysisDependencies: AnalysisDependencies = {
  toApiView,
  microcompactMessages,
  analyzeContextUsage,
}

export async function analyzeContextViz(
  context: LocalJSXCommandContext,
  deps: AnalysisDependencies = analysisDependencies,
): Promise<{ data: ContextData; rows: MessageTokenRow[] }> {
  const {
    messages,
    getAppState,
    options: { mainLoopModel, tools },
  } = context
  const apiView = deps.toApiView(messages)
  // This is a derived view only; cache edits are never pinned or persisted.
  const { messages: compactedMessages } = await deps.microcompactMessages(apiView)
  const appState = getAppState()
  const data = await deps.analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    appState.agentDefinitions,
    process.stdout.columns || 80,
    context,
    undefined,
    apiView,
  )
  const messageTotal =
    data.categories.find(category => category.name === 'Messages')?.tokens ?? 0
  return {
    data,
    rows: buildMessageTokenRows(compactedMessages, messageTotal),
  }
}

function MessageTokenTable({ rows }: { rows: MessageTokenRow[] }): React.ReactNode {
  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1}>
      <Text bold>Per-message tokens</Text>
      {rows.length === 0 ? (
        <Text dimColor>No messages in the current API context.</Text>
      ) : (
        rows.map(row => (
          <Text key={row.id} dimColor>
            {row.id.slice(0, 8)} · {row.role}/{row.category} · {row.tokens} tokens
          </Text>
        ))
      )}
      <Text dimColor>
        Token counting uses the same provider/fallback path as /context and may make token-count requests.
      </Text>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = args.trim()
  let jsonPath: string | undefined
  if (trimmed) {
    if (!trimmed.startsWith('--json') || !/^--json\s+\S/.test(trimmed)) {
      onDone(USAGE)
      return null
    }
    jsonPath = trimmed.slice('--json'.length).trim()
    if (!jsonPath) {
      onDone(USAGE)
      return null
    }
  }

  const { data, rows } = await analyzeContextViz(context)
  if (!jsonPath) {
    const output = await renderToAnsiString(
      <>
        <ContextVisualization data={data} />
        <MessageTokenTable rows={rows} />
      </>,
    )
    onDone(output)
    return null
  }

  return (
    <>
      <ContextVisualization data={data} />
      <MessageTokenTable rows={rows} />
      <DiagnosticExportDialog
        title="Export context token metadata"
        path={jsonPath}
        summary={[
          `Messages: ${rows.length}; per-message sum: ${rows.reduce((sum, row) => sum + row.tokens, 0)} tokens`,
          `Total context: ${data.totalTokens}/${data.maxTokens} tokens`,
          'JSON fields are limited to ids, roles, categories, model, and token counts',
        ]}
        onExport={path =>
          writeNewDiagnosticJson(path, buildContextVizExport(data, rows))
        }
        onDone={onDone}
      />
    </>
  )
}
