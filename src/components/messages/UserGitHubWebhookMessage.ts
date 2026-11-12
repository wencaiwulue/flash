import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import {
  WEBHOOK_EVENTS,
  type WebhookEvent,
} from '../../bridge/webhookSanitizer.js'
import { Box, Text } from '../../ink.js'
import type { MessageOrigin } from '../../types/message.js'

export type ParsedGitHubWebhookMessage = {
  event: WebhookEvent
  deliveryId: string
  text: string
}

const WRAPPER_PATTERN = /^<github-webhook-activity>([\s\S]*)<\/github-webhook-activity>$/

export function parseGitHubWebhookMessage(
  value: string,
): ParsedGitHubWebhookMessage | undefined {
  const match = WRAPPER_PATTERN.exec(value)
  if (!match) return undefined
  try {
    const parsed: unknown = JSON.parse(match[1]!)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    const record = parsed as Record<string, unknown>
    const fields = Object.keys(record)
    if (
      fields.length !== 5 ||
      fields.some(key =>
        ![
          'schema_version',
          'event',
          'delivery_id',
          'untrusted',
          'text',
        ].includes(key),
      ) ||
      record.schema_version !== 1 ||
      typeof record.event !== 'string' ||
      !WEBHOOK_EVENTS.includes(record.event as WebhookEvent) ||
      typeof record.delivery_id !== 'string' ||
      record.delivery_id.trim().length === 0 ||
      record.delivery_id.length > 256 ||
      record.untrusted !== true ||
      typeof record.text !== 'string' ||
      record.text.length > 1_000_000
    ) {
      return undefined
    }
    return {
      event: record.event as WebhookEvent,
      deliveryId: record.delivery_id,
      text: record.text,
    }
  } catch {
    return undefined
  }
}

export function UserGitHubWebhookMessage({
  addMargin,
  param,
  origin,
}: {
  addMargin: boolean
  param: TextBlockParam
  origin?: MessageOrigin
}): React.ReactNode {
  const parsed = parseGitHubWebhookMessage(param.text)
  if (
    !parsed ||
    origin?.kind !== 'github-webhook' ||
    origin.event !== parsed.event ||
    origin.deliveryId !== parsed.deliveryId
  ) {
    return React.createElement(
      Box,
      { marginTop: addMargin ? 1 : 0 },
      React.createElement(Text, null, param.text),
    )
  }

  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: addMargin ? 1 : 0 },
    React.createElement(Text, { bold: true }, `GitHub ${parsed.event}`),
    React.createElement(
      Text,
      { dimColor: true },
      `Delivery ${parsed.deliveryId} · third-party event data (untrusted)`,
    ),
    React.createElement(Text, null, parsed.text),
  )
}
