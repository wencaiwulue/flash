import { describe, expect, mock, test } from 'bun:test'
import type { Message } from '../src/types/message.ts'

const logEvent = mock(() => {})
const saveGlobalConfig = mock((update: (current: object) => object) =>
  update({}),
)
let feedbackAllowed = true

const analyticsActual = await import('../src/services/analytics/index.ts?actual')
const policyActual = await import('../src/services/policyLimits/index.ts?actual')
const configActual = await import('../src/utils/config.ts?actual')
const telemetryActual = await import('../src/utils/telemetry/events.ts?actual')
const transcriptShareActual = await import('../src/components/FeedbackSurvey/submitTranscriptShare.ts?actual')

mock.module('../src/services/analytics/index.ts', () => ({ ...analyticsActual, logEvent }))
mock.module('../src/services/policyLimits/index.ts', () => ({
  ...policyActual,
  isPolicyAllowed: () => feedbackAllowed,
}))
mock.module('../src/utils/config.ts', () => ({
  ...configActual,
  getGlobalConfig: () => ({ transcriptShareDismissed: false }),
  saveGlobalConfig,
}))
mock.module('../src/utils/telemetry/events.ts', () => ({
  ...telemetryActual,
  logOTelEvent: mock(async () => {}),
}))
mock.module('../src/components/FeedbackSurvey/submitTranscriptShare.ts', () => ({
  ...transcriptShareActual,
  submitTranscriptShare: mock(async () => ({ success: true })),
}))

const {
  handleTranscriptConsent,
  recordFeedbackSurveyEvent,
  shouldOfferTranscriptShare,
} = await import('../src/components/FeedbackSurvey/feedbackSurveyShared.ts')
const goodClaude = (await import('../src/commands/good-claude/index.ts')).default

const context = {
  appearanceId: 'appearance-1',
  surveyType: 'session' as const,
  lastAssistantMessageId: 'message-1',
}

describe('/good-claude consent controller', () => {
  test('registers a real command and records a good event', async () => {
    expect(goodClaude.name).toBe('good-claude')
    expect(goodClaude.type).toBe('local-jsx')
    expect((await goodClaude.load()).call).toBeFunction()
    recordFeedbackSurveyEvent('responded', context, 'good')
    expect(logEvent).toHaveBeenCalledWith(
      'tengu_feedback_survey_event',
      expect.objectContaining({ event_type: 'responded', response: 'good' }),
    )
  })

  test('respects policy and probability without treating the command as consent', () => {
    feedbackAllowed = false
    expect(shouldOfferTranscriptShare('good', { bad: 1, good: 1 }, () => 0)).toBe(
      false,
    )
    feedbackAllowed = true
    expect(shouldOfferTranscriptShare('good', { bad: 0, good: 0 }, () => 1)).toBe(
      false,
    )
    expect(shouldOfferTranscriptShare('good', { bad: 1, good: 1 }, () => 0)).toBe(
      true,
    )
  })

  test('declining transcript share never calls the upload/raw-transcript path', async () => {
    const submit = mock(async () => ({ success: true }))
    const result = await handleTranscriptConsent({
      context: { ...context, appearanceId: 'declined' },
      response: 'good',
      selected: 'no',
      messages: [] as Message[],
      submit,
    })
    expect(result).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })

  test('accepting uses the existing redacting share implementation', async () => {
    const submit = mock(async () => ({ success: true, transcriptId: 'id' }))
    const messages = [] as Message[]
    const result = await handleTranscriptConsent({
      context: { ...context, appearanceId: 'accepted' },
      response: 'good',
      selected: 'yes',
      messages,
      submit,
    })
    expect(result).toBe(true)
    expect(submit).toHaveBeenCalledWith(messages, 'good_feedback_survey', 'accepted')
  })

  test('deduplicates an in-flight repeated submission', async () => {
    let finish: ((value: { success: boolean }) => void) | undefined
    const submit = mock(
      () =>
        new Promise<{ success: boolean }>(resolve => {
          finish = resolve
        }),
    )
    const input = {
      context: { ...context, appearanceId: 'duplicate' },
      response: 'good' as const,
      selected: 'yes' as const,
      messages: [] as Message[],
      submit,
    }
    const first = handleTranscriptConsent(input)
    const second = handleTranscriptConsent(input)
    expect(submit).toHaveBeenCalledTimes(1)
    finish?.({ success: true })
    expect(await Promise.all([first, second])).toEqual([true, true])
  })
})
