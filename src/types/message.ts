/**
 * Message type definitions for the conversation pipeline.
 *
 * These are the internal, transcript/UI-facing message shapes. API request and
 * streaming payloads deliberately reuse the Anthropic SDK types where possible.
 */

import type { APIError } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import type { SDKAssistantMessageError } from '../entrypoints/agentSdkTypes.js'
import type { Progress } from '../Tool.js'
import type { Attachment } from '../utils/attachments.js'
import type {
  BranchAction,
  CommitKind,
  PrAction,
} from '../tools/shared/gitOperationTracking.js'
import type { HookProgress } from './hooks.js'
import type { PermissionMode } from './permissions.js'

// ---------------------------------------------------------------------------
// Shared metadata
// ---------------------------------------------------------------------------

export type SystemMessageLevel =
  | 'info'
  | 'warning'
  | 'error'
  | 'success'
  | 'suggestion'

/** Provenance of a user-turn message. Undefined means ordinary keyboard input. */
export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }

export type PartialCompactDirection = 'from' | 'up_to'

export type StopHookInfo = {
  command: string
  promptText?: string
  durationMs?: number
}

export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  /** ToolSearch-loaded schemas which must survive compaction. */
  preCompactDiscoveredTools?: string[]
  /** Relinking information for the un-summarized suffix/prefix. */
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
}

export type MicrocompactMetadata = {
  trigger: 'auto'
  preTokens: number
  tokensSaved: number
  compactedToolIds: string[]
  clearedAttachmentUUIDs: string[]
}

interface MessageBase {
  uuid: UUID
  timestamp: string
}

// ---------------------------------------------------------------------------
// Core conversation messages
// ---------------------------------------------------------------------------

/** A user-submitted message (text, rich content, or tool results). */
export interface UserMessage extends MessageBase {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  /** The tool's structured Output value; not the API-rendered tool result. */
  toolUseResult?: unknown
  /** MCP protocol metadata passed to SDK consumers, never sent to the model. */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  /** Tool call which produced this result (used before result normalization). */
  sourceToolUseID?: string
  /** Assistant message containing the tool_use paired with this tool result. */
  sourceToolAssistantUUID?: UUID
  /** Permission mode to restore when rewinding to this message. */
  permissionMode?: PermissionMode
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  origin?: MessageOrigin
  /** Preserved plan text used by the clear-context-and-implement flow. */
  planContent?: string
}

/** A complete assistant response, or one block yielded while streaming it. */
export interface AssistantMessage extends MessageBase {
  type: 'assistant'
  message: Omit<BetaMessage, 'content'> & {
    content: BetaContentBlock[]
    /** Newer API response fields not yet present in the installed SDK types. */
    container?: unknown | null
    context_management?: unknown | null
  }
  requestId?: string
  apiError?: 'max_output_tokens'
  error?: SDKAssistantMessageError
  errorDetails?: string
  isApiErrorMessage?: boolean
  isMeta?: boolean
  isVirtual?: true
  advisorModel?: string
  /** Internal research metadata returned by the API. */
  research?: unknown
}

interface SystemMessageBase extends MessageBase {
  type: 'system'
  content?: string
  level?: SystemMessageLevel
  isMeta?: boolean
  toolUseID?: string
}

export interface SystemInformationalMessage extends SystemMessageBase {
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
  preventContinuation?: boolean
}

export interface SystemAPIErrorMessage extends SystemMessageBase {
  subtype: 'api_error'
  level: 'error'
  error: APIError
  cause?: Error
  retryInMs: number
  retryAttempt: number
  maxRetries: number
}

export interface SystemCompactBoundaryMessage extends SystemMessageBase {
  subtype: 'compact_boundary'
  content: string
  level: SystemMessageLevel
  compactMetadata: CompactMetadata
  logicalParentUuid?: UUID | null
}

export interface SystemMicrocompactBoundaryMessage extends SystemMessageBase {
  subtype: 'microcompact_boundary'
  content: string
  level: SystemMessageLevel
  microcompactMetadata: MicrocompactMetadata
}

export interface SystemTurnDurationMessage extends SystemMessageBase {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export interface SystemPermissionRetryMessage extends SystemMessageBase {
  subtype: 'permission_retry'
  content: string
  level: SystemMessageLevel
  commands: string[]
}

export interface SystemLocalCommandMessage extends SystemMessageBase {
  subtype: 'local_command'
  content: string
  level: SystemMessageLevel
}

export interface SystemBridgeStatusMessage extends SystemMessageBase {
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
}

export interface SystemMemorySavedMessage extends SystemMessageBase {
  subtype: 'memory_saved'
  writtenPaths: string[]
  verb?: string
  teamCount?: number
}

export interface SystemStopHookSummaryMessage extends SystemMessageBase {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason?: string
  hasOutput: boolean
  level: SystemMessageLevel
  hookLabel?: string
  totalDurationMs?: number
}

export interface SystemAgentsKilledMessage extends SystemMessageBase {
  subtype: 'agents_killed'
}

export interface SystemApiMetricsMessage extends SystemMessageBase {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export interface SystemAwaySummaryMessage extends SystemMessageBase {
  subtype: 'away_summary'
  content: string
}

export interface SystemScheduledTaskFireMessage extends SystemMessageBase {
  subtype: 'scheduled_task_fire'
  content: string
}

export interface SystemThinkingMessage extends SystemMessageBase {
  subtype: 'thinking'
  content: string
}

export interface SystemFileSnapshotMessage extends SystemMessageBase {
  subtype: 'file_snapshot'
  content: string
  level: SystemMessageLevel
  snapshotFiles: Array<{
    key: string
    path: string
    content: string
  }>
}

/** A system/UI message, discriminated by subtype. Not sent directly to the API. */
export type SystemMessage =
  | SystemInformationalMessage
  | SystemAPIErrorMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemTurnDurationMessage
  | SystemPermissionRetryMessage
  | SystemLocalCommandMessage
  | SystemBridgeStatusMessage
  | SystemMemorySavedMessage
  | SystemStopHookSummaryMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemAwaySummaryMessage
  | SystemScheduledTaskFireMessage
  | SystemThinkingMessage
  | SystemFileSnapshotMessage

/** A structured sidecar rendered by the UI and normalized for the API as needed. */
export interface AttachmentMessage<A = Attachment> extends MessageBase {
  type: 'attachment'
  attachment: A
}

export interface ProgressMessage<P extends Progress = Progress>
  extends MessageBase {
  type: 'progress'
  data: P
  toolUseID: string
  parentToolUseID: string
}

/** Messages emitted by hooks and retained in conversation history. */
export type HookResultMessage = AttachmentMessage | ProgressMessage<HookProgress>

/** Persistent/query-loop messages. Control-only events are separate below. */
export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage

// ---------------------------------------------------------------------------
// Normalized and renderable messages
// ---------------------------------------------------------------------------

/** User message split so that each content block can be rendered independently. */
export type NormalizedUserMessage = Omit<UserMessage, 'message'> & {
  message: Omit<UserMessage['message'], 'content'> & {
    content: [
      TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam,
    ]
  }
}

/** Assistant message with SDK content blocks narrowed for rendering. */
export type NormalizedAssistantMessage<
  T extends BetaContentBlock = BetaContentBlock,
> = Omit<AssistantMessage, 'message'> & {
  message: Omit<AssistantMessage['message'], 'content'> & {
    content: T[]
  }
}

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage

export interface GroupedToolUseMessage extends MessageBase {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage<BetaToolUseBlock>[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage<BetaToolUseBlock>
  messageId: string
}

export type CollapsibleMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | GroupedToolUseMessage

export interface CollapsedReadSearchGroup extends MessageBase {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint: string | undefined
  messages: CollapsibleMessage[]
  displayMessage: CollapsibleMessage
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: Array<{ sha: string; kind: CommitKind }>
  pushes?: Array<{ branch: string }>
  branches?: Array<{ ref: string; action: BranchAction }>
  prs?: Array<{ number: number; url?: string; action: PrAction }>
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: Array<{
    path: string
    content: string
    mtimeMs: number
  }>
}

export type RenderableMessage =
  | Exclude<NormalizedMessage, ProgressMessage>
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

// ---------------------------------------------------------------------------
// Streaming and other control-only events
// ---------------------------------------------------------------------------

export interface RequestStartEvent {
  type: 'stream_request_start'
}

export interface StreamEvent {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  ttftMs?: number
}

/** Remove an orphaned assistant message after a streaming fallback. */
export interface TombstoneMessage {
  type: 'tombstone'
  message: Message
}

/** SDK-only human-readable summary of a completed tool-use batch. */
export interface ToolUseSummaryMessage extends MessageBase {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
}
