import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages, MicrocompactSession } from '../services/compact/microCompact.js'
import { ContextCollapseSession } from '../services/contextCollapse/index.js'

// -- deps

// I/O dependencies for query(). Passing a `deps` override into QueryParams
// lets tests inject fakes directly instead of spyOn-per-module — the most
// common mocks (callModel, autocompact) are each spied in 6-8 test files
// today with module-import-and-spy boilerplate.
//
// Using `typeof fn` keeps signatures in sync with the real implementations
// automatically. This file imports the real functions for both typing and
// the production factory — tests that import this file for typing are
// already importing query.ts (which imports everything), so there's no
// new module-graph cost.
//
// Scope is intentionally narrow (4 deps) to prove the pattern. Followup
// PRs can add runTools, handleStopHooks, logEvent, queue ops, etc.
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming

  // -- compaction
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  // Session-scoped compaction wrappers (use these when available)
  microcompactFromSession?: (
    messages: Parameters<typeof microcompactMessages>[0],
    context: Parameters<typeof microcompactMessages>[1],
    querySource: Parameters<typeof microcompactMessages>[2],
  ) => ReturnType<typeof microcompactMessages>
  applyCollapsesFromSession?: (
    messages: Parameters<
      ContextCollapseSession['applyCollapsesIfNeeded']
    >[0],
    context: Parameters<ContextCollapseSession['applyCollapsesIfNeeded']>[1],
    querySource: Parameters<ContextCollapseSession['applyCollapsesIfNeeded']>[2],
  ) => ReturnType<ContextCollapseSession['applyCollapsesIfNeeded']>
  isContextCollapseWithheldFromSession?: (
    message: Parameters<
      ContextCollapseSession['isWithheldPromptTooLong']
    >[0],
    isPromptTooLongMessage: Parameters<
      ContextCollapseSession['isWithheldPromptTooLong']
    >[1],
    querySource: Parameters<
      ContextCollapseSession['isWithheldPromptTooLong']
    >[2],
  ) => ReturnType<ContextCollapseSession['isWithheldPromptTooLong']>
  recoverFromOverflowFromSession?: (
    messages: Parameters<
      ContextCollapseSession['recoverFromOverflow']
    >[0],
    querySource: Parameters<
      ContextCollapseSession['recoverFromOverflow']
    >[1],
  ) => ReturnType<ContextCollapseSession['recoverFromOverflow']>

  // -- platform
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
