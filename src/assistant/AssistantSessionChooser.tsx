import React from 'react'
import { Text } from '../ink.js'
import { Select } from '../components/CustomSelect/select.js'
import { Dialog } from '../components/design-system/Dialog.js'
import type { AssistantSession } from './sessionDiscovery.js'

type Props = {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export function AssistantSessionChooser({
  sessions,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  return (
    <Dialog title="Connect to an assistant session" onCancel={onCancel}>
      {sessions.length === 0 ? (
        <Text>No assistant sessions found.</Text>
      ) : (
        <Select
          options={sessions.map(session => ({
            label: `${session.title ?? session.id} — ${session.machineName ?? session.cwd ?? 'unknown host'}`,
            value: session.id,
          }))}
          onChange={onSelect}
        />
      )}
    </Dialog>
  )
}
