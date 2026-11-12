import type {
  Base64ImageSource,
  ContentBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type { MessageOrigin } from '../types/message.js'
import { detectImageFormatFromBase64 } from '../utils/imageResizer.js'
import { validateUuid } from '../utils/uuid.js'
import type {
  InboundAttachment,
  resolveAndPrepend,
} from './inboundAttachments.js'
import {
  sanitizeInboundWebhookContent,
  WEBHOOK_EVENTS,
  type WebhookEvent,
} from './webhookSanitizer.js'

export const MAX_INBOUND_TEXT_LENGTH = 1_000_000
export const MAX_INBOUND_BASE64_LENGTH = 20_000_000
export const MAX_INBOUND_ATTACHMENTS = 20
export const MAX_WEBHOOK_DELIVERY_ID_LENGTH = 256

const IMAGE_MEDIA_TYPES = new Set<Base64ImageSource['media_type']>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

const ENVELOPE_FIELDS = new Set([
  'type',
  'message',
  'parent_tool_use_id',
  'uuid',
  'session_id',
  'isSynthetic',
  'priority',
  'timestamp',
  'file_attachments',
  'isReplay',
  'source',
])

export type InboundSource =
  | { kind: 'remote_message' }
  | { kind: 'github_webhook'; event: WebhookEvent; delivery_id: string }

/**
 * Metadata attested by a trusted transport adapter, not by message content.
 * Current Sessions transports do not populate this yet. A future adapter must
 * only inject github_webhook after the server/producer trust boundary has
 * authenticated it; passing the parsed wire object's source here is not enough.
 */
export type InboundTransportMetadata = {
  source?: InboundSource
}

export type ParsedInbound =
  | {
      kind: 'remote_message'
      content: string | ContentBlockParam[]
      uuid?: UUID
      attachments: InboundAttachment[]
    }
  | {
      kind: 'github_webhook'
      content: string
      event: WebhookEvent
      deliveryId: string
      uuid?: UUID
    }

export type PreparedInbound = {
  value: string | ContentBlockParam[]
  uuid?: UUID
  origin?: MessageOrigin
}

export type InboundEnvelopeErrorCode =
  | 'invalid_envelope'
  | 'invalid_content'
  | 'content_too_large'
  | 'invalid_uuid'
  | 'invalid_source'
  | 'untrusted_webhook_source'
  | 'webhook_content_not_text'

/** A safe diagnostic: the message never includes inbound content or secrets. */
export class InboundEnvelopeError extends Error {
  constructor(readonly code: InboundEnvelopeErrorCode) {
    super(code)
    this.name = 'InboundEnvelopeError'
  }
}

function reject(code: InboundEnvelopeErrorCode): never {
  throw new InboundEnvelopeError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: InboundEnvelopeErrorCode,
): void {
  const fields = new Set(allowed)
  if (Object.keys(value).some(key => !fields.has(key))) reject(code)
}

function parseSource(value: unknown): InboundSource | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return reject('invalid_source')
  }
  if (value.kind === 'remote_message') {
    requireExactFields(value, ['kind'], 'invalid_source')
    return { kind: 'remote_message' }
  }
  if (value.kind !== 'github_webhook') return reject('invalid_source')
  requireExactFields(
    value,
    ['kind', 'event', 'delivery_id'],
    'invalid_source',
  )
  if (
    typeof value.event !== 'string' ||
    !WEBHOOK_EVENTS.includes(value.event as WebhookEvent) ||
    typeof value.delivery_id !== 'string' ||
    value.delivery_id.trim().length === 0 ||
    value.delivery_id.length > MAX_WEBHOOK_DELIVERY_ID_LENGTH
  ) {
    return reject('invalid_source')
  }
  return {
    kind: 'github_webhook',
    event: value.event as WebhookEvent,
    delivery_id: value.delivery_id,
  }
}

function sameSource(a: InboundSource, b: InboundSource): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'remote_message' || b.kind === 'remote_message') return true
  return a.event === b.event && a.delivery_id === b.delivery_id
}

function parseAttachments(value: unknown): InboundAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_INBOUND_ATTACHMENTS) {
    return reject('invalid_envelope')
  }
  return value.map(item => {
    if (!isRecord(item)) return reject('invalid_envelope')
    requireExactFields(
      item,
      ['file_uuid', 'file_name'],
      'invalid_envelope',
    )
    if (
      typeof item.file_uuid !== 'string' ||
      item.file_uuid.length === 0 ||
      item.file_uuid.length > 256 ||
      typeof item.file_name !== 'string' ||
      item.file_name.length === 0 ||
      item.file_name.length > 1024
    ) {
      return reject('invalid_envelope')
    }
    return { file_uuid: item.file_uuid, file_name: item.file_name }
  })
}

function parseImage(block: Record<string, unknown>): ContentBlockParam {
  requireExactFields(block, ['type', 'source'], 'invalid_content')
  if (!isRecord(block.source) || block.source.type !== 'base64') {
    return reject('invalid_content')
  }
  const source = block.source
  requireExactFields(
    source,
    ['type', 'media_type', 'mediaType', 'data'],
    'invalid_content',
  )
  if (
    typeof source.data !== 'string' ||
    source.data.length === 0 ||
    source.data.length > MAX_INBOUND_BASE64_LENGTH
  ) {
    return reject(
      source.data && typeof source.data === 'string'
        ? 'content_too_large'
        : 'invalid_content',
    )
  }
  if (
    source.media_type !== undefined &&
    source.mediaType !== undefined &&
    source.media_type !== source.mediaType
  ) {
    return reject('invalid_content')
  }
  const candidate = source.media_type ?? source.mediaType
  if (candidate !== undefined && typeof candidate !== 'string') {
    return reject('invalid_content')
  }
  const mediaType = candidate || detectImageFormatFromBase64(source.data)
  if (!IMAGE_MEDIA_TYPES.has(mediaType as Base64ImageSource['media_type'])) {
    return reject('invalid_content')
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType as Base64ImageSource['media_type'],
      data: source.data,
    },
  }
}

function parseContent(value: unknown): string | ContentBlockParam[] {
  if (typeof value === 'string') {
    if (value.length > MAX_INBOUND_TEXT_LENGTH) reject('content_too_large')
    if (value.trim().length === 0) reject('invalid_content')
    return value
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    return reject('invalid_content')
  }

  let textLength = 0
  let hasImage = false
  const blocks = value.map(item => {
    if (!isRecord(item)) return reject('invalid_content')
    if (item.type === 'text') {
      requireExactFields(item, ['type', 'text'], 'invalid_content')
      if (typeof item.text !== 'string') return reject('invalid_content')
      textLength += item.text.length
      if (textLength > MAX_INBOUND_TEXT_LENGTH) reject('content_too_large')
      return { type: 'text', text: item.text } as ContentBlockParam
    }
    if (item.type === 'image') {
      hasImage = true
      return parseImage(item)
    }
    return reject('invalid_content')
  })
  if (
    !hasImage &&
    blocks.every(block => block.type === 'text' && !block.text.trim())
  ) {
    reject('invalid_content')
  }
  return blocks
}

/**
 * Strictly validate a remote user event. A wire github_webhook source is not
 * trusted on its own: it must match explicit transport-attested metadata.
 * Legacy events without source remain ordinary remote messages.
 */
export function parseInboundUserEnvelope(
  value: unknown,
  transportMetadata: InboundTransportMetadata = {},
): ParsedInbound {
  if (!isRecord(value) || value.type !== 'user') reject('invalid_envelope')
  requireExactFields(value, [...ENVELOPE_FIELDS], 'invalid_envelope')
  if (value.parent_tool_use_id !== null || 'tool_use_result' in value) {
    reject('invalid_envelope')
  }
  if (!isRecord(value.message) || value.message.role !== 'user') {
    reject('invalid_envelope')
  }
  requireExactFields(value.message, ['role', 'content'], 'invalid_envelope')
  if (
    value.isSynthetic !== undefined &&
    value.isSynthetic !== false
  ) {
    reject('invalid_envelope')
  }
  if (
    value.priority !== undefined &&
    value.priority !== 'now' &&
    value.priority !== 'next' &&
    value.priority !== 'later'
  ) {
    reject('invalid_envelope')
  }
  if (value.isReplay !== undefined && value.isReplay !== true) {
    reject('invalid_envelope')
  }
  if (
    value.session_id !== undefined &&
    (typeof value.session_id !== 'string' ||
      value.session_id.length === 0 ||
      value.session_id.length > 256)
  ) {
    reject('invalid_envelope')
  }
  if (
    value.timestamp !== undefined &&
    (typeof value.timestamp !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value.timestamp) ||
      Number.isNaN(Date.parse(value.timestamp)))
  ) {
    reject('invalid_envelope')
  }

  let uuid: UUID | undefined
  if (value.uuid !== undefined) {
    uuid = validateUuid(value.uuid) ?? reject('invalid_uuid')
  }

  const wireSource = parseSource(value.source)
  const trustedSource = parseSource(transportMetadata.source)
  if (
    wireSource &&
    trustedSource &&
    !sameSource(wireSource, trustedSource)
  ) {
    reject('invalid_source')
  }
  const source =
    trustedSource ?? wireSource ?? ({ kind: 'remote_message' } as const)
  if (source.kind === 'github_webhook' && !trustedSource) {
    reject('untrusted_webhook_source')
  }

  const content = parseContent(value.message.content)
  const attachments = parseAttachments(value.file_attachments)
  if (source.kind === 'github_webhook') {
    if (typeof content !== 'string' || attachments.length > 0) {
      reject('webhook_content_not_text')
    }
    return {
      kind: 'github_webhook',
      content,
      event: source.event,
      deliveryId: source.delivery_id,
      ...(uuid ? { uuid } : {}),
    }
  }
  return {
    kind: 'remote_message',
    content,
    attachments,
    ...(uuid ? { uuid } : {}),
  }
}

/** Shared REPL/print preparation boundary. Invalid input never returns a partial prompt. */
export async function prepareInboundMessage(
  value: unknown,
  deps: {
    resolveAttachments: typeof resolveAndPrepend
    transportMetadata?: InboundTransportMetadata
    sanitizeWebhook?: typeof sanitizeInboundWebhookContent
  },
): Promise<PreparedInbound> {
  const parsed = parseInboundUserEnvelope(value, deps.transportMetadata)
  if (parsed.kind === 'remote_message') {
    return {
      value: await deps.resolveAttachments(value, parsed.content),
      ...(parsed.uuid ? { uuid: parsed.uuid } : {}),
    }
  }

  const sanitize = deps.sanitizeWebhook ?? sanitizeInboundWebhookContent
  return {
    value: sanitize(parsed.content, {
      event: parsed.event,
      deliveryId: parsed.deliveryId,
    }),
    ...(parsed.uuid ? { uuid: parsed.uuid } : {}),
    origin: {
      kind: 'github-webhook',
      event: parsed.event,
      deliveryId: parsed.deliveryId,
    },
  }
}
