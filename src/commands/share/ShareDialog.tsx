import React, { useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import {
  renderConversationToHtml,
  resolveShareOutputPath,
  writeSharedHtml,
} from './shareHtml.js'

export function ShareDialog({
  messages,
  initialFilename,
  defaultFilename,
  preview,
  onDone,
}: {
  messages: Message[]
  initialFilename: string
  defaultFilename: string
  preview: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [filename, setFilename] = useState(initialFilename || defaultFilename)
  const [cursorOffset, setCursorOffset] = useState(filename.length)
  const [choosingFilename, setChoosingFilename] = useState(false)
  const [includeToolOutput, setIncludeToolOutput] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const { columns } = useTerminalSize()

  const save = async (includeTools: boolean, output: string) => {
    setSaving(true)
    setError('')
    try {
      const destination = resolveShareOutputPath(output)
      const html = renderConversationToHtml(messages, {
        includeToolOutput: includeTools,
      })
      await writeSharedHtml(destination, html)
      onDone(`Conversation saved to local HTML file: ${destination}`)
    } catch (caught) {
      const code = (caught as { code?: string }).code
      const message =
        code === 'EEXIST'
          ? 'That file already exists. Choose a new filename; existing files are never overwritten.'
          : caught instanceof Error
            ? caught.message
            : 'Unable to write the HTML file.'
      setError(message)
      setSaving(false)
      if (!initialFilename) setChoosingFilename(true)
    }
  }

  const chooseTools = (value: string) => {
    if (value === 'cancel') {
      onDone('Share cancelled. No file was written.')
      return
    }
    const includeTools = value === 'include'
    setIncludeToolOutput(includeTools)
    if (initialFilename) {
      void save(includeTools, initialFilename)
    } else {
      setChoosingFilename(true)
    }
  }

  if (saving) {
    return <Text>Saving local HTML file…</Text>
  }

  return (
    <Dialog
      title="Share conversation as a local HTML file"
      subtitle={`${messages.length} messages · No upload or public link`}
      color="permission"
      onCancel={() => onDone('Share cancelled. No file was written.')}
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint
            shortcut="Enter"
            action={choosingFilename ? 'save' : 'select'}
          />
          <KeyboardShortcutHint shortcut="Esc" action="cancel" />
        </Byline>
      )}
    >
      <Box flexDirection="column" gap={1}>
        <Text color="warning">
          Privacy: this conversation may contain secrets or other sensitive
          data. Review the preview; automatic redaction is not guaranteed.
        </Text>
        <Box flexDirection="column">
          <Text bold>Preview (tool output hidden):</Text>
          <Text>{preview || 'The conversation is empty.'}</Text>
        </Box>
        {error && <Text color="error">{error}</Text>}
        {!choosingFilename ? (
          <Select
            options={[
              {
                label: 'Save without tool output',
                value: 'exclude',
                description: 'Include user and assistant text only',
              },
              {
                label: 'Include tool calls and output',
                value: 'include',
                description: 'Review carefully for credentials and file contents',
              },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={chooseTools}
            onCancel={() => onDone('Share cancelled. No file was written.')}
          />
        ) : (
          <Box flexDirection="column">
            <Text>Output path (relative, .html, must not exist):</Text>
            <Box flexDirection="row" gap={1}>
              <Text>&gt;</Text>
              <TextInput
                value={filename}
                onChange={setFilename}
                onSubmit={() => void save(includeToolOutput, filename)}
                focus
                showCursor
                columns={columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
              />
            </Box>
          </Box>
        )}
      </Box>
    </Dialog>
  )
}
