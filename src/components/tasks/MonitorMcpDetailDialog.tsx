import React from 'react'
import type { MonitorMcpTaskState } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { DeepImmutable } from '../../types/utils.js'
import { Text } from '../../ink.js'
import { Dialog } from '../design-system/Dialog.js'

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>
  onKill?: () => void
  onBack?: () => void
}

export function MonitorMcpDetailDialog({
  task: _task,
  onKill: _onKill,
  onBack,
}: Props): React.ReactNode {
  return (
    <Dialog title="Monitor unavailable" onCancel={onBack ?? (() => {})}>
      <Text>MCP monitor tasks are unavailable in this build.</Text>
    </Dialog>
  )
}
