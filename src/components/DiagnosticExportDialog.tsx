import React, { useState } from 'react'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  title: string
  summary: readonly string[]
  path?: string
  defaultPath?: string
  onExport: (path: string) => Promise<void>
  onDone: (message: string) => void
}

/** Preview-first local JSON export. Export implementations must use wx. */
export function DiagnosticExportDialog({
  title,
  summary,
  path,
  defaultPath = 'diagnostics.json',
  onExport,
  onDone,
}: Props): React.ReactNode {
  const [candidate, setCandidate] = useState(path ?? defaultPath)
  const [cursorOffset, setCursorOffset] = useState((path ?? defaultPath).length)
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const { columns } = useTerminalSize()

  const exportTo = async (target: string) => {
    if (writing) return
    setWriting(true)
    setError(null)
    try {
      await onExport(target)
      onDone(`Diagnostic JSON written to: ${target}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Export failed')
      setWriting(false)
    }
  }

  return (
    <Dialog
      title={title}
      subtitle="Preview — no transcript, prompt, tool payload, credentials, or response body is exported"
      onCancel={() => onDone('Export cancelled; no file was written')}
    >
      <Box flexDirection="column">
        {summary.map(line => (
          <Text key={line}>{line}</Text>
        ))}
        {error && <Text color="error">{error}</Text>}
        {path ? (
          <Select
            isDisabled={writing}
            options={[
              { value: 'export', label: `Write new file: ${path}` },
              { value: 'cancel', label: 'Cancel' },
            ]}
            onChange={value => {
              if (value === 'cancel') {
                onDone('Export cancelled; no file was written')
              } else {
                void exportTo(path)
              }
            }}
          />
        ) : (
          <Box flexDirection="column">
            <Text>Enter a new output path to confirm export:</Text>
            <Box flexDirection="row" gap={1}>
              <Text>&gt;</Text>
              <TextInput
                value={candidate}
                onChange={setCandidate}
                onSubmit={() => void exportTo(candidate)}
                focus={!writing}
                showCursor={!writing}
                columns={columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
              />
            </Box>
          </Box>
        )}
        {writing && <Text dimColor>Writing local diagnostic JSON…</Text>}
      </Box>
    </Dialog>
  )
}
