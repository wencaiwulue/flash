import React from 'react'
import { Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { getManagedTungstenSessions } from '../../tools/TungstenTool/TungstenTool.js'

export function TungstenPill({ selected }: { selected: boolean }): React.ReactNode {
  const active = useAppState(state => state.tungstenActiveSession)
  const count = Math.max(getManagedTungstenSessions().size, active ? 1 : 0)
  return (
    <Text bold={selected} inverse={selected} dimColor={!selected}>
      tmux {active ? `${active.sessionName} ` : ''}({count})
    </Text>
  )
}
