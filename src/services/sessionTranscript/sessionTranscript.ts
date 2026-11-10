import type { Message } from '../../types/message.js'

export async function writeSessionTranscriptSegment(
  _messages: Message[],
): Promise<void> {
  // Session transcripts are disabled in this build; do not write partial data.
}

export function flushOnDateChange(
  _messages: Message[],
  _currentDate: string,
): void {
  // Session transcripts are disabled in this build.
}
