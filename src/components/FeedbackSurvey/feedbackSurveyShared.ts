import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import {
  submitTranscriptShare,
  type TranscriptShareTrigger,
} from './submitTranscriptShare.js'
import type { TranscriptShareResponse } from './TranscriptSharePrompt.js'
import type { FeedbackSurveyResponse, FeedbackSurveyType } from './utils.js'

export type FeedbackSurveyEventContext = {
  appearanceId: string
  surveyType: FeedbackSurveyType
  lastAssistantMessageId: string
}

function transcriptTrigger(
  response: FeedbackSurveyResponse | null,
): TranscriptShareTrigger {
  return response === 'good' ? 'good_feedback_survey' : 'bad_feedback_survey'
}

export function recordFeedbackSurveyEvent(
  eventType: 'appeared' | 'responded',
  context: FeedbackSurveyEventContext,
  response?: FeedbackSurveyResponse,
): void {
  logEvent('tengu_feedback_survey_event', {
    event_type: eventType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    appearance_id:
      context.appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    last_assistant_message_id:
      context.lastAssistantMessageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    survey_type:
      context.surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(response === undefined
      ? {}
      : {
          response:
            response as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
  })
  void logOTelEvent('feedback_survey', {
    event_type: eventType,
    appearance_id: context.appearanceId,
    response,
    survey_type: context.surveyType,
  })
}

export function recordTranscriptPromptShown(
  context: FeedbackSurveyEventContext,
  response: FeedbackSurveyResponse,
): void {
  const trigger = transcriptTrigger(response)
  logEvent('tengu_feedback_survey_event', {
    event_type:
      'transcript_prompt_appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    appearance_id:
      context.appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    last_assistant_message_id:
      context.lastAssistantMessageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    survey_type:
      context.surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    trigger: trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  void logOTelEvent('feedback_survey', {
    event_type: 'transcript_prompt_appeared',
    appearance_id: context.appearanceId,
    survey_type: context.surveyType,
    trigger,
  })
}

export function shouldOfferTranscriptShare(
  selected: FeedbackSurveyResponse,
  probabilities: { bad: number; good: number },
  random: () => number = Math.random,
): boolean {
  if (selected !== 'bad' && selected !== 'good') return false
  if (getGlobalConfig().transcriptShareDismissed) return false
  if (!isPolicyAllowed('allow_product_feedback')) return false
  return random() <= probabilities[selected]
}

const transcriptSubmissions = new Map<string, Promise<boolean>>()

export async function handleTranscriptConsent({
  context,
  response,
  selected,
  messages,
  submit = submitTranscriptShare,
}: {
  context: FeedbackSurveyEventContext
  response: FeedbackSurveyResponse | null
  selected: TranscriptShareResponse
  messages: Message[]
  submit?: typeof submitTranscriptShare
}): Promise<boolean> {
  const trigger = transcriptTrigger(response)
  logEvent('tengu_feedback_survey_event', {
    event_type:
      `transcript_share_${selected}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    appearance_id:
      context.appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    last_assistant_message_id:
      context.lastAssistantMessageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    survey_type:
      context.surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    trigger: trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  if (selected === 'dont_ask_again') {
    saveGlobalConfig(current => ({
      ...current,
      transcriptShareDismissed: true,
    }))
  }

  if (selected !== 'yes') return false

  const existing = transcriptSubmissions.get(context.appearanceId)
  if (existing) return existing

  const submission = (async () => {
    const result = await submit(messages, trigger, context.appearanceId)
    logEvent('tengu_feedback_survey_event', {
      event_type: (result.success
        ? 'transcript_share_submitted'
        : 'transcript_share_failed') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id:
        context.appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      trigger: trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return result.success
  })()
  transcriptSubmissions.set(context.appearanceId, submission)
  try {
    return await submission
  } finally {
    transcriptSubmissions.delete(context.appearanceId)
  }
}
