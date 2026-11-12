import { mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { diffLines } from 'diff'
import { extname, join } from 'path'
import { randomBytes } from 'crypto'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type { LogOption } from '../../types/logs.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getSessionIdFromLog } from '../../utils/sessionStorage.js'
import { countCharInString } from '../../utils/stringUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

export type SessionMeta = {
  session_id: string
  project_path: string
  start_time: string
  duration_minutes: number
  user_message_count: number
  assistant_message_count: number
  tool_counts: Record<string, number>
  languages: Record<string, number>
  git_commits: number
  git_pushes: number
  input_tokens: number
  output_tokens: number
  first_prompt: string
  summary?: string
  // New stats
  user_interruptions: number
  user_response_times: number[]
  tool_errors: number
  tool_error_categories: Record<string, number>
  uses_task_agent: boolean
  uses_mcp: boolean
  uses_web_search: boolean
  uses_web_fetch: boolean
  // Additional stats
  lines_added: number
  lines_removed: number
  files_modified: number
  message_hours: number[]
  user_message_timestamps: string[] // ISO timestamps for multi-clauding detection
}


const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.sh': 'Shell',
  '.css': 'CSS',
  '.html': 'HTML',
}


export function getLanguageFromPath(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] || null
}

export function extractToolStats(log: LogOption): {
  toolCounts: Record<string, number>
  languages: Record<string, number>
  gitCommits: number
  gitPushes: number
  inputTokens: number
  outputTokens: number
  // New stats
  userInterruptions: number
  userResponseTimes: number[]
  toolErrors: number
  toolErrorCategories: Record<string, number>
  usesTaskAgent: boolean
  usesMcp: boolean
  usesWebSearch: boolean
  usesWebFetch: boolean
  // Additional stats
  linesAdded: number
  linesRemoved: number
  filesModified: Set<string>
  messageHours: number[]
  userMessageTimestamps: string[] // ISO timestamps for multi-clauding detection
} {
  const toolCounts: Record<string, number> = {}
  const languages: Record<string, number> = {}
  let gitCommits = 0
  let gitPushes = 0
  let inputTokens = 0
  let outputTokens = 0

  // New stats
  let userInterruptions = 0
  const userResponseTimes: number[] = []
  let toolErrors = 0
  const toolErrorCategories: Record<string, number> = {}
  let usesTaskAgent = false

  // Additional stats
  let linesAdded = 0
  let linesRemoved = 0
  const filesModified = new Set<string>()
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = [] // For multi-clauding detection
  let usesMcp = false
  let usesWebSearch = false
  let usesWebFetch = false
  let lastAssistantTimestamp: string | null = null

  for (const msg of log.messages) {
    // Get message timestamp for response time calculation
    const msgTimestamp = (msg as { timestamp?: string }).timestamp

    if (msg.type === 'assistant' && msg.message) {
      // Track timestamp for response time calculation
      if (msgTimestamp) {
        lastAssistantTimestamp = msgTimestamp
      }

      const usage = (
        msg.message as {
          usage?: { input_tokens?: number; output_tokens?: number }
        }
      ).usage
      if (usage) {
        inputTokens += usage.input_tokens || 0
        outputTokens += usage.output_tokens || 0
      }

      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && 'name' in block) {
            const toolName = block.name as string
            toolCounts[toolName] = (toolCounts[toolName] || 0) + 1

            // Check for special tool usage
            if (
              toolName === AGENT_TOOL_NAME ||
              toolName === LEGACY_AGENT_TOOL_NAME
            )
              usesTaskAgent = true
            if (toolName.startsWith('mcp__')) usesMcp = true
            if (toolName === 'WebSearch') usesWebSearch = true
            if (toolName === 'WebFetch') usesWebFetch = true

            const input = (block as { input?: Record<string, unknown> }).input

            if (input) {
              const filePath = (input.file_path as string) || ''
              if (filePath) {
                const lang = getLanguageFromPath(filePath)
                if (lang) {
                  languages[lang] = (languages[lang] || 0) + 1
                }
                // Track files modified by Edit/Write tools
                if (toolName === 'Edit' || toolName === 'Write') {
                  filesModified.add(filePath)
                }
              }

              if (toolName === 'Edit') {
                const oldString = (input.old_string as string) || ''
                const newString = (input.new_string as string) || ''
                for (const change of diffLines(oldString, newString)) {
                  if (change.added) linesAdded += change.count || 0
                  if (change.removed) linesRemoved += change.count || 0
                }
              }

              // Track lines from Write tool (all added)
              if (toolName === 'Write') {
                const writeContent = (input.content as string) || ''
                if (writeContent) {
                  linesAdded += countCharInString(writeContent, '\n') + 1
                }
              }

              const command = (input.command as string) || ''
              if (command.includes('git commit')) gitCommits++
              if (command.includes('git push')) gitPushes++
            }
          }
        }
      }
    }

    // Check user messages
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content

      // Check if this is an actual human message (has text) vs just tool_result
      // matching Python reference logic
      let isHumanMessage = false
      if (typeof content === 'string' && content.trim()) {
        isHumanMessage = true
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            isHumanMessage = true
            break
          }
        }
      }

      // Only track message hours and response times for actual human messages
      if (isHumanMessage) {
        // Track message hour for time-of-day analysis and timestamp for multi-clauding
        if (msgTimestamp) {
          try {
            const msgDate = new Date(msgTimestamp)
            const hour = msgDate.getHours() // Local hour 0-23
            messageHours.push(hour)
            // Collect timestamp for multi-clauding detection (matching Python)
            userMessageTimestamps.push(msgTimestamp)
          } catch {
            // Skip invalid timestamps
          }
        }

        // Calculate response time (time from last assistant message to this user message)
        // Only count gaps > 2 seconds (real user think time, not tool results)
        if (lastAssistantTimestamp && msgTimestamp) {
          const assistantTime = new Date(lastAssistantTimestamp).getTime()
          const userTime = new Date(msgTimestamp).getTime()
          const responseTimeSec = (userTime - assistantTime) / 1000
          // Only count reasonable response times (2s-1 hour) matching Python
          if (responseTimeSec > 2 && responseTimeSec < 3600) {
            userResponseTimes.push(responseTimeSec)
          }
        }
      }

      // Process tool results (for error tracking)
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && 'content' in block) {
            const isError = (block as { is_error?: boolean }).is_error

            // Count and categorize tool errors (matching Python reference logic)
            if (isError) {
              toolErrors++
              const resultContent = (block as { content?: string }).content
              let category = 'Other'
              if (typeof resultContent === 'string') {
                const lowerContent = resultContent.toLowerCase()
                if (lowerContent.includes('exit code')) {
                  category = 'Command Failed'
                } else if (
                  lowerContent.includes('rejected') ||
                  lowerContent.includes("doesn't want")
                ) {
                  category = 'User Rejected'
                } else if (
                  lowerContent.includes('string to replace not found') ||
                  lowerContent.includes('no changes')
                ) {
                  category = 'Edit Failed'
                } else if (lowerContent.includes('modified since read')) {
                  category = 'File Changed'
                } else if (
                  lowerContent.includes('exceeds maximum') ||
                  lowerContent.includes('too large')
                ) {
                  category = 'File Too Large'
                } else if (
                  lowerContent.includes('file not found') ||
                  lowerContent.includes('does not exist')
                ) {
                  category = 'File Not Found'
                }
              }
              toolErrorCategories[category] =
                (toolErrorCategories[category] || 0) + 1
            }
          }
        }
      }

      // Check for interruptions (matching Python reference)
      if (typeof content === 'string') {
        if (content.includes('[Request interrupted by user')) {
          userInterruptions++
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'text' &&
            'text' in block &&
            (block.text as string).includes('[Request interrupted by user')
          ) {
            userInterruptions++
            break
          }
        }
      }
    }
  }

  return {
    toolCounts,
    languages,
    gitCommits,
    gitPushes,
    inputTokens,
    outputTokens,
    // New stats
    userInterruptions,
    userResponseTimes,
    toolErrors,
    toolErrorCategories,
    usesTaskAgent,
    usesMcp,
    usesWebSearch,
    usesWebFetch,
    // Additional stats
    linesAdded,
    linesRemoved,
    filesModified,
    messageHours,
    userMessageTimestamps,
  }
}

export function hasValidDates(log: LogOption): boolean {
  return (
    !Number.isNaN(log.created.getTime()) &&
    !Number.isNaN(log.modified.getTime())
  )
}

export function logToSessionMeta(log: LogOption): SessionMeta {
  const stats = extractToolStats(log)
  const sessionId = getSessionIdFromLog(log) || 'unknown'
  const startTime = log.created.toISOString()
  const durationMinutes = Math.round(
    (log.modified.getTime() - log.created.getTime()) / 1000 / 60,
  )

  let userMessageCount = 0
  let assistantMessageCount = 0
  for (const msg of log.messages) {
    if (msg.type === 'assistant') assistantMessageCount++
    // Only count user messages that have actual text content (human messages)
    // not just tool_result messages (matching Python reference)
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content
      let isHumanMessage = false
      if (typeof content === 'string' && content.trim()) {
        isHumanMessage = true
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            isHumanMessage = true
            break
          }
        }
      }
      if (isHumanMessage) {
        userMessageCount++
      }
    }
  }

  return {
    session_id: sessionId,
    project_path: log.projectPath || '',
    start_time: startTime,
    duration_minutes: durationMinutes,
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessageCount,
    tool_counts: stats.toolCounts,
    languages: stats.languages,
    git_commits: stats.gitCommits,
    git_pushes: stats.gitPushes,
    input_tokens: stats.inputTokens,
    output_tokens: stats.outputTokens,
    first_prompt: log.firstPrompt || '',
    summary: log.summary,
    // New stats
    user_interruptions: stats.userInterruptions,
    user_response_times: stats.userResponseTimes,
    tool_errors: stats.toolErrors,
    tool_error_categories: stats.toolErrorCategories,
    uses_task_agent: stats.usesTaskAgent,
    uses_mcp: stats.usesMcp,
    uses_web_search: stats.usesWebSearch,
    uses_web_fetch: stats.usesWebFetch,
    // Additional stats
    lines_added: stats.linesAdded,
    lines_removed: stats.linesRemoved,
    files_modified: stats.filesModified.size,
    message_hours: stats.messageHours,
    user_message_timestamps: stats.userMessageTimestamps,
  }
}

/**
 * Deduplicate conversation branches within the same session.
 *
 * When a session file has multiple leaf messages (from retries or branching),
 * loadAllLogsFromSessionFile produces one LogOption per leaf. Each branch
 * shares the same root message, so its duration overlaps with sibling
 * branches. This keeps only the branch with the most user messages
 * (tie-break by longest duration) per session_id.
 */
export function deduplicateSessionBranches(
  entries: Array<{ log: LogOption; meta: SessionMeta }>,
): Array<{ log: LogOption; meta: SessionMeta }> {
  const bestBySession = new Map<string, { log: LogOption; meta: SessionMeta }>()
  for (const entry of entries) {
    const id = entry.meta.session_id
    const existing = bestBySession.get(id)
    if (
      !existing ||
      entry.meta.user_message_count > existing.meta.user_message_count ||
      (entry.meta.user_message_count === existing.meta.user_message_count &&
        entry.meta.duration_minutes > existing.meta.duration_minutes)
    ) {
      bestBySession.set(id, entry)
    }
  }
  return [...bestBySession.values()]
}


export function getSessionMetaDir(): string {
  return join(getClaudeConfigHomeDir(), 'usage-data', 'session-meta')
}

export function isValidSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== 'object') return false
  const meta = value as Partial<SessionMeta>
  return (
    typeof meta.session_id === 'string' &&
    /^[a-f0-9-]{36}$/i.test(meta.session_id) &&
    typeof meta.project_path === 'string' &&
    typeof meta.start_time === 'string' &&
    !Number.isNaN(Date.parse(meta.start_time)) &&
    typeof meta.duration_minutes === 'number' &&
    Number.isFinite(meta.duration_minutes) &&
    typeof meta.user_message_count === 'number' &&
    typeof meta.assistant_message_count === 'number' &&
    typeof meta.tool_counts === 'object' &&
    meta.tool_counts !== null &&
    Array.isArray(meta.message_hours) &&
    Array.isArray(meta.user_message_timestamps)
  )
}

export async function loadCachedSessionMeta(
  sessionId: string,
): Promise<SessionMeta | null> {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return null
  try {
    const content = await readFile(
      join(getSessionMetaDir(), `${sessionId}.json`),
      'utf8',
    )
    const parsed: unknown = jsonParse(content)
    return isValidSessionMeta(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Atomic 0600 metadata write; temporary files never become visible cache entries. */
export async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  if (!isValidSessionMeta(meta)) throw new Error('Invalid SessionMeta')
  const dir = getSessionMetaDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${meta.session_id}.json`)
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(jsonStringify(meta, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}
