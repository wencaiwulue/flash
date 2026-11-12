import React, { useEffect, useRef } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import type { TeleportRemoteResponse } from 'src/utils/conversationRecovery.js'
import {
  type TeleportResumeSession,
  type TeleportSource,
  useTeleportResume,
} from '../hooks/useTeleportResume.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { ResumeTask } from './ResumeTask.js'
import { Spinner } from './Spinner.js'

interface TeleportResumeWrapperProps {
  onComplete: (result: TeleportRemoteResponse) => void
  onCancel: () => void
  onError?: (error: string, formattedMessage?: string) => void
  isEmbedded?: boolean
  source: TeleportSource
  /** Skip the picker and resume this already-selected session. */
  initialSession?: TeleportResumeSession
}

/**
 * Wrapper component that manages the full teleport resume flow,
 * including session selection, loading state, and error handling
 */
export function TeleportResumeWrapper({
  onComplete,
  onCancel,
  onError,
  isEmbedded = false,
  source,
  initialSession,
}: TeleportResumeWrapperProps): React.ReactNode {
  const { resumeSession, isResuming, error, selectedSession, getError } =
    useTeleportResume(source)
  const initialResumeStarted = useRef(false)

  // Log when teleport flow starts (for funnel tracking)
  useEffect(() => {
    logEvent('tengu_teleport_started', {
      source:
        source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }, [source])

  const handleSelect = async (session: TeleportResumeSession) => {
    const result = await resumeSession(session)
    if (result) {
      onComplete(result)
    } else {
      const resumeError = getError()
      // If there's an error handler provided, use it
      if (resumeError && onError) {
        onError(resumeError.message, resumeError.formattedMessage)
      }
      // Otherwise the error will be displayed in the UI
    }
  }

  useEffect(() => {
    if (initialSession && !initialResumeStarted.current) {
      initialResumeStarted.current = true
      void handleSelect(initialSession)
    }
  }, [initialSession])

  const handleCancel = () => {
    logEvent('tengu_teleport_cancelled', {})
    onCancel()
  }

  // Allow Esc to dismiss the error state
  useKeybinding('app:interrupt', handleCancel, {
    context: 'Global',
    isActive: !!error && !onError,
  })

  // Show loading spinner when resuming
  if (isResuming && selectedSession) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="row">
          <Spinner />
          <Text bold>Resuming session…</Text>
        </Box>
        <Text dimColor>Loading &quot;{selectedSession.title}&quot;…</Text>
      </Box>
    )
  }

  // Show error if there was a problem resuming
  if (error && !onError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="error">
          Failed to resume session
        </Text>
        <Text dimColor>{error.message}</Text>
        <Box marginTop={1}>
          <Text dimColor>
            Press <Text bold>Esc</Text> to cancel
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <ResumeTask
      onSelect={handleSelect}
      onCancel={handleCancel}
      isEmbedded={isEmbedded}
    />
  )
}
