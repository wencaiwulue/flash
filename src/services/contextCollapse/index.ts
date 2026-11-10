import { randomUUID } from 'crypto'
import type { QuerySource } from '../../constants/querySource.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getEffectiveContextWindowSize } from '../compact/autoCompact.js'
import { projectView, selectCollapseSpan } from './operations.js'
import {
  collapseStore,
  getCollapseStats,
  notifyCollapseListeners,
  resetCollapseStore,
  subscribeToCollapses,
  type StagedCollapse,
} from './store.js'

export type { ContextCollapseStats } from './store.js'
import type { ContextCollapseStats } from './store.js'

export type ContextCollapseDependencies = {
  tokenCount(messages: Message[]): number
  contextWindow(model: string): number
  summarize(messages: Message[], context: ToolUseContext): Promise<string>
  recordCommit(commit: {
    collapseId: string
    summaryUuid: string
    summaryContent: string
    summary: string
    firstArchivedUuid: string
    lastArchivedUuid: string
  }): Promise<void>
  recordSnapshot(snapshot: {
    staged: Array<{
      startUuid: string
      endUuid: string
      summary: string
      risk: number
      stagedAt: number
    }>
    armed: boolean
    lastSpawnTokens: number
  }): Promise<void>
}

async function defaultSummarize(
  messages: Message[],
  context: ToolUseContext,
): Promise<string> {
  const [
    { runForkedAgent, getLastCacheSafeParams },
    { extractTextContent },
    { getSystemPrompt },
    { getUserContext, getSystemContext },
    { asSystemPrompt },
  ] = await Promise.all([
    import('../../utils/forkedAgent.js'),
    import('../../utils/messages.js'),
    import('../../constants/prompts.js'),
    import('../../context.js'),
    import('../../utils/systemPromptType.js'),
  ])
  const saved = getLastCacheSafeParams()
  const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
    saved
      ? Promise.resolve(saved.systemPrompt)
      : getSystemPrompt(
          context.options.tools,
          context.options.mainLoopModel,
          [],
          context.options.mcpClients,
        ),
    saved ? Promise.resolve(saved.userContext) : getUserContext(),
    saved ? Promise.resolve(saved.systemContext) : getSystemContext(),
  ])
  const result = await runForkedAgent({
    promptMessages: [
      ...messages,
      createUserMessage({
        content:
          'Summarize this conversation span for continuation. Preserve decisions, file paths, code changes, tool outcomes, and unresolved work in concise plain text. Do not use tools or add new actions.',
      }),
    ],
    cacheSafeParams: {
      systemPrompt: asSystemPrompt(rawSystemPrompt),
      userContext,
      systemContext,
      toolUseContext: context,
      forkContextMessages: messages,
    },
    canUseTool: async () => ({
      behavior: 'deny',
      message: 'Context summarization cannot use tools',
      decisionReason: { type: 'other', reason: 'context_collapse' },
    }),
    querySource: 'marble_origami',
    forkLabel: 'context_collapse',
    maxTurns: 1,
    skipCacheWrite: true,
  })
  return extractTextContent(
    result.messages.flatMap(message =>
      message.type === 'assistant' ? message.message.content : [],
    ),
    '\n\n',
  ).trim()
}

const defaults: ContextCollapseDependencies = {
  tokenCount: tokenCountWithEstimation,
  contextWindow: getEffectiveContextWindowSize,
  summarize: defaultSummarize,
  async recordCommit(commit) {
    const { recordContextCollapseCommit } = await import(
      '../../utils/sessionStorage.js'
    )
    await recordContextCollapseCommit(commit)
  },
  async recordSnapshot(snapshot) {
    const { recordContextCollapseSnapshot } = await import(
      '../../utils/sessionStorage.js'
    )
    await recordContextCollapseSnapshot(snapshot)
  },
}

let dependencies = defaults
let generation = 0
let activeSpawn: Promise<void> | undefined

export function isContextCollapseEnabled(): boolean {
  return process.env.CLAUDE_CONTEXT_COLLAPSE === undefined
    ? true
    : isEnvTruthy(process.env.CLAUDE_CONTEXT_COLLAPSE)
}

export function initContextCollapse(
  overrides: Partial<ContextCollapseDependencies> = {},
): void {
  dependencies = { ...defaults, ...overrides }
}

export function resetContextCollapse(): void {
  generation++
  activeSpawn = undefined
  resetCollapseStore()
}

export function getStats(): ContextCollapseStats {
  return getCollapseStats()
}

export function subscribe(listener: () => void): () => void {
  return subscribeToCollapses(listener)
}

function snapshot() {
  return {
    staged: collapseStore.staged.map(stage => ({
      startUuid: stage.startUuid,
      endUuid: stage.endUuid,
      summary: stage.summary,
      risk: stage.risk,
      stagedAt: stage.stagedAt,
    })),
    armed: collapseStore.armed,
    lastSpawnTokens: collapseStore.lastSpawnTokens,
  }
}

async function persistSnapshot(): Promise<void> {
  try {
    await dependencies.recordSnapshot(snapshot())
  } catch (error) {
    collapseStore.health.totalErrors++
    collapseStore.health.lastError = error instanceof Error ? error.message : String(error)
    notifyCollapseListeners()
  }
}

async function commitStaged(stage: StagedCollapse): Promise<void> {
  const collapseId = String(collapseStore.nextId++).padStart(16, '0')
  const summaryUuid = randomUUID()
  const summaryContent = `<collapsed id="${collapseId}">${stage.summary
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')}</collapsed>`
  const summaryMessage = createUserMessage({
    content: summaryContent,
    uuid: summaryUuid,
    isMeta: true,
  })
  collapseStore.committed.push({
    collapseId,
    summaryUuid,
    summaryContent,
    summary: stage.summary,
    firstArchivedUuid: stage.startUuid,
    lastArchivedUuid: stage.endUuid,
    summaryMessage,
    archived: stage.messages,
  })
  collapseStore.staged = collapseStore.staged.filter(item => item !== stage)
  notifyCollapseListeners()
  try {
    await dependencies.recordCommit({
      collapseId,
      summaryUuid,
      summaryContent,
      summary: stage.summary,
      firstArchivedUuid: stage.startUuid,
      lastArchivedUuid: stage.endUuid,
    })
  } catch (error) {
    collapseStore.health.totalErrors++
    collapseStore.health.lastError = error instanceof Error ? error.message : String(error)
    notifyCollapseListeners()
  }
  await persistSnapshot()
}

function startSpawn(
  span: Message[],
  context: ToolUseContext,
  tokens: number,
  risk: number,
): Promise<void> {
  const currentGeneration = ++generation
  collapseStore.armed = true
  collapseStore.health.totalSpawns++
  notifyCollapseListeners()
  const promise = (async () => {
    try {
      const summary = (
        await dependencies.summarize(span, context)
      ).trim()
      if (currentGeneration !== generation) return
      if (!summary) {
        collapseStore.health.totalEmptySpawns++
        collapseStore.health.emptySpawnWarningEmitted = true
        collapseStore.health.lastError = 'Summarizer returned an empty summary'
        return
      }
      const startUuid = 'uuid' in span[0]! ? span[0]!.uuid : undefined
      const endUuid = 'uuid' in span.at(-1)! ? span.at(-1)!.uuid : undefined
      if (!startUuid || !endUuid) {
        throw new Error('Collapse span boundaries require message UUIDs')
      }
      await commitStaged({
        startUuid,
        endUuid,
        summary,
        risk,
        stagedAt: Date.now(),
        messages: span,
      })
    } catch (error) {
      if (currentGeneration === generation) {
        collapseStore.health.totalErrors++
        collapseStore.health.lastError = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (currentGeneration === generation) {
        collapseStore.armed = false
        collapseStore.lastSpawnTokens = tokens
        await persistSnapshot()
        notifyCollapseListeners()
      }
    }
  })()
  activeSpawn = promise
  void promise.finally(() => {
    if (activeSpawn === promise) activeSpawn = undefined
  })
  return promise
}

export async function applyCollapsesIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  querySource: QuerySource,
): Promise<{ messages: Message[] }> {
  if (!isContextCollapseEnabled() || querySource === 'marble_origami') {
    return { messages }
  }
  const projected = projectView(messages)
  if (querySource === 'compact' || querySource === 'session_memory') {
    return { messages: projected }
  }
  const tokens = dependencies.tokenCount(projected)
  const window = dependencies.contextWindow(
    toolUseContext.options.mainLoopModel,
  )
  const ratio = tokens / window
  if (
    ratio < 0.9 ||
    (collapseStore.lastSpawnTokens > 0 &&
      tokens < collapseStore.lastSpawnTokens + 5_000)
  ) {
    return { messages: projected }
  }
  if (activeSpawn) {
    if (ratio >= 0.95) await activeSpawn
    return { messages: projectView(projected) }
  }
  const span = selectCollapseSpan(projected)
  if (!span) return { messages: projected }
  const spawn = startSpawn(span, toolUseContext, tokens, Math.min(1, ratio))
  if (ratio >= 0.95) await spawn
  return { messages: projectView(projected) }
}

export function isWithheldPromptTooLong(
  message: AssistantMessage | SystemAPIErrorMessage | StreamEvent,
  isPromptTooLongMessage: (message: AssistantMessage) => boolean,
  querySource: QuerySource,
): boolean {
  return (
    isContextCollapseEnabled() &&
    querySource !== 'marble_origami' &&
    message.type === 'assistant' &&
    message.isApiErrorMessage === true &&
    isPromptTooLongMessage(message)
  )
}

export function recoverFromOverflow(
  messages: Message[],
  querySource: QuerySource,
): { messages: Message[]; committed: number } {
  if (!isContextCollapseEnabled() || querySource === 'marble_origami') {
    return { messages, committed: 0 }
  }
  const staged = [...collapseStore.staged]
  // commitStaged is async only for persistence. The in-memory commit is
  // synchronous, so overflow recovery can project immediately.
  for (const stage of staged) void commitStaged(stage)
  return { messages: projectView(messages), committed: staged.length }
}
