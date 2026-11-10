import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

/**
 * Webhook sanitization requires the internal webhook implementation. Failing
 * closed is important: returning the input would bypass the trust boundary.
 */
export function sanitizeInboundWebhookContent(
  _content: string | ContentBlockParam[],
): string {
  throw new Error('GitHub webhook sanitization is unavailable in this build')
}
