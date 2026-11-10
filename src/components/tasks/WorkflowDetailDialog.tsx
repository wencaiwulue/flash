import React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { DeepImmutable } from '../../types/utils.js'
import { Text } from '../../ink.js'
import { Dialog } from '../design-system/Dialog.js'

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onBack?: () => void
}

export function WorkflowDetailDialog({
  workflow: _workflow,
  onDone,
  onKill: _onKill,
  onSkipAgent: _onSkipAgent,
  onRetryAgent: _onRetryAgent,
  onBack,
}: Props): React.ReactNode {
  const close = () => {
    if (onBack) onBack()
    else onDone('Workflow details unavailable', { display: 'system' })
  }
  return (
    <Dialog title="Workflow unavailable" onCancel={close}>
      <Text>Local workflows are unavailable in this build.</Text>
    </Dialog>
  )
}
