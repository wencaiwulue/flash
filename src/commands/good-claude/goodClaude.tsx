import { randomUUID } from 'crypto'
import React, { useEffect, useRef, useState } from 'react'
import { Text } from '../../ink.js'
import {
  handleTranscriptConsent,
  recordFeedbackSurveyEvent,
  recordTranscriptPromptShown,
  shouldOfferTranscriptShare,
} from '../../components/FeedbackSurvey/feedbackSurveyShared.js'
import { TranscriptSharePrompt } from '../../components/FeedbackSurvey/TranscriptSharePrompt.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getLastAssistantMessage } from '../../utils/messages.js'

export function GoodClaudeFeedback({
  context,
  onDone,
}: {
  context: Parameters<LocalJSXCommandCall>[1]
  onDone: Parameters<LocalJSXCommandCall>[0]
}): React.ReactNode {
  const [state, setState] = useState<'preparing' | 'prompt' | 'submitting'>(
    'preparing',
  )
  const [inputValue, setInputValue] = useState('')
  const appearanceId = useRef(randomUUID())
  const initialized = useRef(false)
  const submitting = useRef(false)
  const eventContext = {
    appearanceId: appearanceId.current,
    surveyType: 'session' as const,
    lastAssistantMessageId:
      getLastAssistantMessage(context.messages)?.message.id ?? 'unknown',
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    recordFeedbackSurveyEvent('appeared', eventContext)
    recordFeedbackSurveyEvent('responded', eventContext, 'good')

    // A manual rating always offers the consent choice unless policy or a
    // previous "don't ask again" choice disables it. This is not upload consent.
    if (shouldOfferTranscriptShare('good', { bad: 1, good: 1 }, () => 0)) {
      recordTranscriptPromptShown(eventContext, 'good')
      setState('prompt')
    } else {
      onDone('Thanks for the good feedback. No transcript was shared.')
    }
  }, [])

  const handleSelect = async (
    selected: 'yes' | 'no' | 'dont_ask_again',
  ): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    if (selected === 'yes') setState('submitting')
    try {
      const shared = await handleTranscriptConsent({
        context: eventContext,
        response: 'good',
        selected,
        messages: context.messages,
      })
      onDone(
        shared
          ? 'Thanks for the good feedback and for sharing your transcript.'
          : 'Thanks for the good feedback. No transcript was shared.',
      )
    } catch {
      onDone(
        'Thanks for the good feedback. The transcript was not shared because submission failed.',
      )
    }
  }

  if (state === 'submitting') return <Text>Sharing transcript…</Text>
  if (state !== 'prompt') return null
  return (
    <TranscriptSharePrompt
      onSelect={selected => void handleSelect(selected)}
      inputValue={inputValue}
      setInputValue={setInputValue}
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  if (args.trim()) {
    onDone('Usage: /good-claude (this command does not accept arguments)')
    return null
  }
  return <GoodClaudeFeedback context={context} onDone={onDone} />
}
