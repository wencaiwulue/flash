export const WEBHOOK_EVENTS = [
  'check_run',
  'check_suite',
  'push',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export type WebhookMetadata = {
  event: WebhookEvent
  deliveryId: string
}

const MAX_TEXT_LENGTH = 1_000_000
const MAX_DELIVERY_ID_LENGTH = 256

function escapeJsonForWrapper(value: string): string {
  let result = ''
  for (const char of value) {
    switch (char) {
      case '<':
        result += '\\u003c'
        break
      case '>':
        result += '\\u003e'
        break
      case '&':
        result += '\\u0026'
        break
      default: {
        const code = char.charCodeAt(0)
        result +=
          code === 0x2028 || code === 0x2029
            ? `\\u${code.toString(16)}`
            : char
      }
    }
  }
  return result
}

/**
 * Wrap already-routed webhook text as explicitly untrusted event data. This is
 * a display/serialization boundary, not a prompt-injection cleaner. Metadata
 * comes from the trusted transport, never from the webhook body.
 */
export function sanitizeInboundWebhookContent(
  content: string,
  metadata: WebhookMetadata,
): string {
  if (
    typeof content !== 'string' ||
    content.trim().length === 0 ||
    content.length > MAX_TEXT_LENGTH ||
    !WEBHOOK_EVENTS.includes(metadata.event) ||
    typeof metadata.deliveryId !== 'string' ||
    metadata.deliveryId.trim().length === 0 ||
    metadata.deliveryId.length > MAX_DELIVERY_ID_LENGTH
  ) {
    throw new Error('invalid_webhook_input')
  }

  const json = escapeJsonForWrapper(
    JSON.stringify({
      schema_version: 1,
      event: metadata.event,
      delivery_id: metadata.deliveryId,
      untrusted: true,
      text: content,
    }),
  )
  return `<github-webhook-activity>${json}</github-webhook-activity>`
}
