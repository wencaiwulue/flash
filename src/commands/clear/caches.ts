/**
 * Session cache clearing utilities.
 * This module is imported at startup by main.tsx, so keep imports minimal.
 */
import { feature } from 'bun:bundle'
import {
  clearInvokedSkills,
  setLastEmittedDate,
} from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import { getSessionStartDate } from '../../constants/common.js'
import {
  getGitStatus,
  getSystemContext,
  getUserContext,
  setSystemPromptInjection,
} from '../../context.js'
import { clearFileSuggestionCaches } from '../../hooks/fileSuggestions.js'
import { clearAllPendingCallbacks } from '../../hooks/useSwarmPermissionPoller.js'
import { clearAllDumpState } from '../../services/api/dumpPrompts.js'
import { resetPromptCacheBreakDetection } from '../../services/api/promptCacheBreakDetection.js'
import { clearAllSessions } from '../../services/api/sessionIngress.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { resetAllLSPDiagnosticState } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { clearTrackedMagicDocs } from '../../services/MagicDocs/magicDocs.js'
import { clearDynamicSkills } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import { clearCommandPrefixCaches } from '../../utils/bash/commands.js'
import { resetGetMemoryFilesCache } from '../../utils/claudemd.js'
import { clearRepositoryCaches } from '../../utils/detectRepository.js'
import { clearResolveGitDirCache } from '../../utils/git/gitFilesystem.js'
import { clearStoredImagePaths } from '../../utils/imageStore.js'
import { clearSessionEnvVars } from '../../utils/sessionEnvVars.js'

/**
 * Clear all session-related caches.
 * Call this when resuming a session to ensure fresh file/skill discovery.
 * This is a subset of what clearConversation does - it only clears caches
 * without affecting messages, session ID, or triggering hooks.
 *
 * @param preservedAgentIds - Agent IDs whose per-agent state should survive
 *   the clear (e.g., background tasks preserved across /clear). When non-empty,
 *   agentId-keyed state (invoked skills) is selectively cleared and requestId-keyed
 *   state (pending permission callbacks, dump state, cache-break tracking) is left
 *   intact since it cannot be safely scoped to the main session.
 */
export type SessionCacheClearResult = {
  completed: string[]
  failed: Array<{ name: string; error: string }>
}

export async function clearSessionCaches(
  preservedAgentIds: ReadonlySet<string> = new Set(),
): Promise<SessionCacheClearResult> {
  const completed = [
    'context',
    'file suggestions',
    'commands and skills',
    'prompt-cache detection',
    'post-compaction state',
    'memory',
    'repository detection',
    'session ingress',
    'LSP diagnostics',
    'session environment',
  ]
  const pending: Array<{ name: string; promise: Promise<void> }> = []
  const hasPreserved = preservedAgentIds.size > 0
  // Clear context caches
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  getGitStatus.cache.clear?.()
  getSessionStartDate.cache.clear?.()
  // Clear file suggestion caches (for @ mentions)
  clearFileSuggestionCaches()

  // Clear commands/skills cache
  clearCommandsCache()

  // Clear prompt cache break detection state
  if (!hasPreserved) resetPromptCacheBreakDetection()

  // Clear system prompt injection (cache breaker)
  setSystemPromptInjection(null)

  // Clear last emitted date so it's re-detected on next turn
  setLastEmittedDate(null)

  // Run post-compaction cleanup (clears system prompt sections, microcompact tracking,
  // classifier approvals, speculative checks, and — for main-thread compacts — memory
  // files cache with load_reason 'compact').
  runPostCompactCleanup()
  // Reset sent skill names so the skill listing is re-sent after /clear.
  // runPostCompactCleanup intentionally does NOT reset this (post-compact
  // re-injection costs ~4K tokens), but /clear wipes messages entirely so
  // the model needs the full listing again.
  resetSentSkillNames()
  // Override the memory cache reset with 'session_start': clearSessionCaches is called
  // from /clear and --resume/--continue, which are NOT compaction events. Without this,
  // the InstructionsLoaded hook would fire with load_reason 'compact' instead of
  // 'session_start' on the next getMemoryFiles() call.
  resetGetMemoryFilesCache('session_start')

  // Clear stored image paths cache
  clearStoredImagePaths()

  // Clear all session ingress caches (lastUuidMap, sequentialAppendBySession)
  clearAllSessions()
  // Clear swarm permission pending callbacks
  if (!hasPreserved) clearAllPendingCallbacks()

  // Clear tungsten session usage tracking
  if (process.env.USER_TYPE === 'ant') {
    pending.push({
      name: 'Tungsten sessions',
      promise: import('../../tools/TungstenTool/TungstenTool.js').then(
        ({ clearSessionsWithTungstenUsage, resetInitializationState }) => {
          clearSessionsWithTungstenUsage()
          resetInitializationState()
        },
      ),
    })
  }
  // Clear attribution caches (file content cache, pending bash states)
  // Dynamic import to preserve dead code elimination for COMMIT_ATTRIBUTION feature flag
  if (feature('COMMIT_ATTRIBUTION')) {
    pending.push({
      name: 'commit attribution',
      promise: import('../../utils/attributionHooks.js').then(
        ({ clearAttributionCaches }) => clearAttributionCaches(),
      ),
    })
  }
  // Clear repository detection caches
  clearRepositoryCaches()
  // Clear bash command prefix caches (Haiku-extracted prefixes)
  clearCommandPrefixCaches()
  // Clear dump prompts state
  if (!hasPreserved) clearAllDumpState()
  // Clear invoked skills cache (each entry holds full skill file content)
  clearInvokedSkills(preservedAgentIds)
  // Clear git dir resolution cache
  clearResolveGitDirCache()
  // Clear dynamic skills (loaded from skill directories)
  clearDynamicSkills()
  // Clear LSP diagnostic tracking state
  resetAllLSPDiagnosticState()
  // Clear tracked magic docs
  clearTrackedMagicDocs()
  // Clear session environment variables
  clearSessionEnvVars()
  // Clear WebFetch URL cache (up to 50MB of cached page content)
  pending.push({
    name: 'WebFetch',
    promise: import('../../tools/WebFetchTool/utils.js').then(
      ({ clearWebFetchCache }) => clearWebFetchCache(),
    ),
  })
  // Clear ToolSearch description cache (full tool prompts, ~500KB for 50 MCP tools)
  pending.push({
    name: 'ToolSearch descriptions',
    promise: import('../../tools/ToolSearchTool/ToolSearchTool.js').then(
      ({ clearToolSearchDescriptionCache }) => clearToolSearchDescriptionCache(),
    ),
  })
  // Clear agent definitions cache (accumulates per-cwd via EnterWorktreeTool)
  pending.push({
    name: 'agent definitions',
    promise: import('../../tools/AgentTool/loadAgentsDir.js').then(
      ({ clearAgentDefinitionsCache }) => clearAgentDefinitionsCache(),
    ),
  })
  // Clear SkillTool prompt cache (accumulates per project root)
  pending.push({
    name: 'SkillTool prompts',
    promise: import('../../tools/SkillTool/prompt.js').then(
      ({ clearPromptCache }) => clearPromptCache(),
    ),
  })

  const settled = await Promise.allSettled(pending.map(entry => entry.promise))
  const failed: SessionCacheClearResult['failed'] = []
  settled.forEach((result, index) => {
    const name = pending[index]!.name
    if (result.status === 'fulfilled') {
      completed.push(name)
    } else {
      failed.push({
        name,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      })
    }
  })
  return { completed, failed }
}
