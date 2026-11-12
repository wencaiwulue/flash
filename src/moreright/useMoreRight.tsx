import { randomUUID } from 'crypto'
import React, { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import type { SetToolJSXFn } from '../Tool.js'
import type { Message, SystemInformationalMessage } from '../types/message.js'
import { isEnvTruthy } from '../utils/envUtils.js'

const MAX_NOTES = 20
const MAX_NOTE_LENGTH = 4000

type Note = { id: string; text: string; timestamp: string }
type Turn = {
  userId?: string
  assistantId?: string
  timestamp: string
  status: 'completed' | 'aborted'
}

function confirmation(content: string): SystemInformationalMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content,
    level: 'info',
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: true,
  }
}

function MoreRightSidebar({
  notes,
  turn,
  onClear,
}: {
  notes: Note[]
  turn: Turn | null
  onClear: () => void
}): React.ReactNode {
  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'x' && notes.length > 0) onClear()
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>MoreRight local notes ({notes.length})</Text>
      <Text dimColor>Process-local only; notes are not sent to the model.</Text>
      {notes.length === 0 ? <Text dimColor>No notes.</Text> : null}
      {notes.map(note => (
        <Text key={note.id}>
          {new Date(note.timestamp).toLocaleTimeString()} {note.text}
        </Text>
      ))}
      {notes.length > 0 ? <Text dimColor>Ctrl+X clears notes</Text> : null}
      {turn && (
        <Text>
          Last turn {turn.status}: user {turn.userId ?? 'none'}, assistant{' '}
          {turn.assistantId ?? 'none'} ({new Date(turn.timestamp).toLocaleTimeString()})
        </Text>
      )}
    </Box>
  )
}

export function useMoreRight(args: {
  enabled: boolean
  setMessages: (action: Message[] | ((prev: Message[]) => Message[])) => void
  inputValue: string
  setInputValue: (s: string) => void
  setToolJSX: SetToolJSXFn
}): {
  onBeforeQuery: (input: string, all: Message[], n: number) => Promise<boolean>
  onTurnComplete: (all: Message[], aborted: boolean) => Promise<void>
  render: () => React.ReactNode
} {
  const [notes, setNotes] = useState<Note[]>([])
  const [turn, setTurn] = useState<Turn | null>(null)
  const enabled = args.enabled && isEnvTruthy(process.env.CLAUDE_MORERIGHT)

  return {
    onBeforeQuery: async input => {
      if (!enabled) return true
      if (!input.startsWith('@right ')) return true
      const text = input.slice('@right '.length).trim()
      args.setInputValue('')
      if (!text) {
        args.setMessages(previous => [
          ...previous,
          confirmation('MoreRight: empty notes are not saved.'),
        ])
        return false
      }
      const note: Note = {
        id: randomUUID(),
        text: text.slice(0, MAX_NOTE_LENGTH),
        timestamp: new Date().toISOString(),
      }
      setNotes(previous => [...previous, note].slice(-MAX_NOTES))
      // Deliberately exclude the note text from the conversation: this local
      // acknowledgement is UI metadata, not a second model or hidden prompt.
      args.setMessages(previous => [
        ...previous,
        confirmation(`MoreRight: note saved locally (${note.id.slice(0, 8)}).`),
      ])
      return false
    },
    onTurnComplete: async (all, aborted) => {
      if (!enabled) return
      const user = all.findLast(message => message.type === 'user')
      const assistant = all.findLast(message => message.type === 'assistant')
      setTurn({
        userId: user?.uuid,
        assistantId: assistant?.uuid,
        timestamp: assistant?.timestamp ?? user?.timestamp ?? new Date().toISOString(),
        status: aborted ? 'aborted' : 'completed',
      })
    },
    render: () =>
      enabled ? (
        <MoreRightSidebar
          notes={notes}
          turn={turn}
          onClear={() => setNotes([])}
        />
      ) : null,
  }
}
