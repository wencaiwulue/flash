import React, { useState } from 'react'
import type { Tools } from '../../Tool.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { renderToAnsiString } from '../../utils/staticRender.js'
import {
  collectToolCalls,
  formatSavedToolCalls,
  type SavedToolCall,
} from './inspection.js'

const USAGE = 'Usage: /debug-tool-call [tool-use-id] [--validate]'

function ToolCallBrowser({
  calls,
  tools,
  validate,
  onDone,
}: {
  calls: SavedToolCall[]
  tools: Tools
  validate: boolean
  onDone: () => void
}): React.ReactNode {
  const [selected, setSelected] = useState<number | null>(null)
  if (selected !== null) {
    return (
      <Dialog title="Saved tool call (read-only)" onCancel={() => setSelected(null)}>
        <Text>{formatSavedToolCalls([calls[selected]!], tools, validate)}</Text>
        <Select
          options={[{ value: 'back', label: 'Back to tool calls' }]}
          onChange={() => setSelected(null)}
        />
      </Dialog>
    )
  }
  return (
    <Dialog
      title="Saved tool calls"
      subtitle="Select a call to inspect. Nothing will be replayed or executed."
      onCancel={onDone}
    >
      <Box flexDirection="column">
        <Select
          options={calls.map((call, index) => ({
            value: String(index),
            label: `${call.name} · ${call.id} · ${call.results.length ? 'has result' : 'missing result'}`,
          }))}
          onChange={value => setSelected(Number(value))}
        />
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const validateCount = tokens.filter(token => token === '--validate').length
  const ids = tokens.filter(token => token !== '--validate')
  if (tokens.length > 2 || validateCount > 1 || ids.length > 1) {
    onDone(USAGE)
    return null
  }
  const validate = validateCount === 1
  const calls = collectToolCalls(context.messages)
  const tools = context.options.tools
  if (ids[0]) {
    const matches = calls.filter(candidate => candidate.id === ids[0])
    if (matches.length === 0) {
      onDone(`No saved tool_use found for id: ${ids[0]}`)
      return null
    }
    const output = await renderToAnsiString(
      <Text>{formatSavedToolCalls(matches, tools, validate)}</Text>,
    )
    onDone(output)
    return null
  }
  if (calls.length === 0) {
    onDone('No saved tool calls in the current messages.')
    return null
  }
  return (
    <ToolCallBrowser
      calls={calls}
      tools={tools}
      validate={validate}
      onDone={() => onDone('Tool-call inspection closed; no tools were executed')}
    />
  )
}
