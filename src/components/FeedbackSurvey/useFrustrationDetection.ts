export function useFrustrationDetection(
  _messages: unknown,
  _isLoading: boolean,
  _hasActivePrompt: boolean,
  _hasOtherSurvey: boolean,
): { state: 'closed'; handleTranscriptSelect: () => boolean } {
  return { state: 'closed', handleTranscriptSelect: () => false }
}
