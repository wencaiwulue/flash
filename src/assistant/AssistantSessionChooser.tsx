import React, { useEffect } from 'react'
import { Text } from '../ink.js'
import type { AssistantSession } from './sessionDiscovery.js'

type Props = {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export function AssistantSessionChooser({
  sessions: _sessions,
  onSelect: _onSelect,
  onCancel,
}: Props): React.ReactNode {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return <Text color="warning">Assistant sessions are unavailable in this build.</Text>
}
