import React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { DeepImmutable } from '../../types/utils.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

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
  workflow,
  onDone,
  onKill,
  onSkipAgent,
  onRetryAgent,
  onBack,
}: Props): React.ReactNode {
  const agents = Object.entries(workflow.agents ?? {})
  const close = () => {
    if (onBack) onBack()
    else onDone('Workflow details', { display: 'system' })
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'x' && onKill) {
      event.preventDefault()
      onKill()
    } else if (event.key === 's' && onSkipAgent) {
      const target = agents.find(([, agent]) => agent.status !== 'completed')
      if (target) {
        event.preventDefault()
        onSkipAgent(target[0])
      }
    } else if (event.key === 'r' && onRetryAgent) {
      const target = agents.find(
        ([, agent]) => agent.status === 'failed' || agent.status === 'skipped',
      )
      if (target) {
        event.preventDefault()
        onRetryAgent(target[0])
      }
    }
  }
  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={`Workflow: ${workflow.workflowName ?? workflow.description}`}
        subtitle={<Text dimColor>{workflow.status} · {workflow.agentCount} steps</Text>}
        onCancel={close}
        inputGuide={() => (
          <Byline>
            {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
            <KeyboardShortcutHint shortcut="Esc" action="close" />
            {onKill && <KeyboardShortcutHint shortcut="x" action="stop" />}
            {onSkipAgent && <KeyboardShortcutHint shortcut="s" action="skip next" />}
            {onRetryAgent && <KeyboardShortcutHint shortcut="r" action="retry failed" />}
          </Byline>
        )}
      >
        <Box flexDirection="column">
          {agents.map(([id, agent]) => (
            <Box key={id} flexDirection="column">
              <Text>
                <Text bold>{id}</Text>: {agent.status}
              </Text>
              {agent.error && <Text color="error">{agent.error}</Text>}
              {agent.output && <Text dimColor>{agent.output.slice(0, 500)}</Text>}
            </Box>
          ))}
          {workflow.error && <Text color="error">{workflow.error}</Text>}
        </Box>
      </Dialog>
    </Box>
  )
}
