import React, { useEffect, useState } from 'react'
import type { MonitorMcpTaskState } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { DeepImmutable } from '../../types/utils.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../design-system/Dialog.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { getTaskOutput } from '../../utils/task/diskOutput.js'
import { truncateToWidth } from '../../utils/format.js'

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>
  onKill?: () => Promise<boolean>
  onBack?: () => void
}

const OUTPUT_TAIL_BYTES = 8192
const OUTPUT_LINES = 10

export function MonitorMcpDetailDialog({
  task,
  onKill,
  onBack,
}: Props): React.ReactNode {
  const [output, setOutput] = useState('')
  const [requestPending, setRequestPending] = useState(false)
  const [requestFailed, setRequestFailed] = useState(false)

  useEffect(() => {
    let active = true
    void getTaskOutput(task.id, OUTPUT_TAIL_BYTES).then(value => {
      if (active) setOutput(value)
    })
    return () => {
      active = false
    }
  }, [task.id, task.status, task.lastRemoteUpdateAt])

  const running = task.status === 'running' || task.status === 'pending'
  const canRequestCancellation =
    running &&
    !!onKill &&
    !requestPending &&
    (!task.cancelRequested || !!task.error || requestFailed)

  const requestCancellation = async () => {
    if (!canRequestCancellation || !onKill) return
    setRequestPending(true)
    setRequestFailed(false)
    try {
      const confirmed = await onKill()
      setRequestFailed(!confirmed)
    } catch {
      setRequestFailed(true)
    } finally {
      setRequestPending(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'left' && onBack) {
      event.preventDefault()
      onBack()
    } else if (event.key === 'x' && canRequestCancellation) {
      event.preventDefault()
      void requestCancellation()
    }
  }

  const outputLines = output.split('\n').slice(-OUTPUT_LINES)
  const cancelled = task.remoteStatus === 'cancelled' || task.status === 'killed'
  const waitingForConfirmation =
    running && task.cancelRequested && !requestFailed && !task.error

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      <Dialog
        title="MCP task monitor"
        onCancel={onBack ?? (() => {})}
        color="background"
        inputGuide={() => (
          <Byline>
            {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
            <KeyboardShortcutHint shortcut="Esc" action="back" />
            {canRequestCancellation && (
              <KeyboardShortcutHint
                shortcut="x"
                action={
                  task.cancelRequested
                    ? 'retry cancellation'
                    : 'request cancellation'
                }
              />
            )}
          </Byline>
        )}
      >
        <Box flexDirection="column">
          <Text>
            <Text bold>Local task:</Text> {task.id}
          </Text>
          <Text wrap="wrap">
            <Text bold>Server / tool:</Text> {task.serverName} / {task.toolName}
          </Text>
          <Text wrap="wrap">
            <Text bold>Remote task:</Text>{' '}
            {truncateToWidth(task.remoteTaskId, 100)}
          </Text>
          <Text>
            <Text bold>Local status:</Text> {task.status}
          </Text>
          <Text>
            <Text bold>Remote status:</Text>{' '}
            {cancelled ? 'Remote task cancelled' : task.remoteStatus}
          </Text>
          {task.lastRemoteUpdateAt !== undefined && (
            <Text>
              <Text bold>Last remote update:</Text>{' '}
              {new Date(task.lastRemoteUpdateAt).toISOString()}
            </Text>
          )}
          {waitingForConfirmation && (
            <Text color="warning">
              Cancellation requested; waiting for server confirmation.
            </Text>
          )}
          {requestPending && (
            <Text color="warning">Waiting for the MCP server to respond…</Text>
          )}
          {(requestFailed || (running && task.cancelRequested && task.error)) && (
            <Text color="error">
              Cancellation was not confirmed; the remote task may still be
              running. Press x to retry.
            </Text>
          )}
          {cancelled && <Text color="success">Remote task cancelled</Text>}
          {task.error && <Text color="error">Error: {task.error}</Text>}
        </Box>

        <Box flexDirection="column">
          <Text bold>Recent output:</Text>
          {output ? (
            <Box
              borderStyle="round"
              paddingX={1}
              flexDirection="column"
              height={12}
            >
              {outputLines.map((line, index) => (
                <Text key={index} wrap="truncate-end">
                  {line}
                </Text>
              ))}
            </Box>
          ) : (
            <Text dimColor>No output available</Text>
          )}
          {output && <Text dimColor italic>Showing the latest 10 lines</Text>}
        </Box>
      </Dialog>
    </Box>
  )
}
