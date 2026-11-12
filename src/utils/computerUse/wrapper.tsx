/**
 * The `.call()` override — thin adapter between `ToolUseContext` and
 * `bindSessionContext`. Spread into the MCP tool object in `client.ts`
 * (same pattern as Chrome's rendering overrides, plus `.call()`).
 *
 * The wrapper-closure logic (build overrides fresh, lock gate, permission
 * merge, screenshot stash) lives in `@ant/computer-use-mcp`'s
 * `bindSessionContext`. This file binds it once per process,
 * caches the dispatcher, and updates a per-call ref for the pieces of
 * `ToolUseContext` that vary per-call (`abortController`, `setToolJSX`,
 * `sendOSNotification`). AppState accessors are read through the ref too —
 * they're likely stable but we don't depend on that.
 *
 * External callers reach this via the lazy require thunk in `client.ts`, gated
 * on `feature('CHICAGO_MCP')`. Runtime enablement is controlled by the
 * GrowthBook gate `tengu_malort_pedway` (see gates.ts).
 */

import {
  createNativeComputerUseBackend,
  createZavoraComputerUseBackend,
  type ComputerUseBackend,
  type ComputerUseSessionContext,
  type CuCallToolResult,
  type CuPermissionRequest,
  type CuPermissionResponse,
  DEFAULT_GRANT_FLAGS,
  type ScreenshotDims,
} from '@ant/computer-use-mcp'
import * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import { ComputerUseApproval } from '../../components/permissions/ComputerUseApproval/ComputerUseApproval.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import {
  checkComputerUseLock,
  tryAcquireComputerUseLock,
} from './computerUseLock.js'
import { getChicagoCoordinateMode, getComputerUseBackendKind } from './gates.js'
import { getComputerUseMCPRenderingOverrides } from './toolRendering.js'

type CallOverride = Pick<Tool, 'call'>['call']

type Binding = {
  ctx: ComputerUseSessionContext
  backend: ComputerUseBackend
  dispatch: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<CuCallToolResult>
}

/**
 * Cached binding — built on first `.call()`, reused for process lifetime.
 * The dispatcher's closure-held screenshot blob persists across calls.
 *
 * `currentToolUseContext` is updated on every call. Every getter/callback in
 * `ctx` reads through it, so the per-call pieces (`abortController`,
 * `setToolJSX`, `sendOSNotification`) are always current.
 *
 * Module-level `let` is a deliberate exception to the no-module-scope-state
 * rule (src/CLAUDE.md): the dispatcher closure must persist across calls so
 * its internal screenshot blob survives, but `ToolUseContext` is per-call.
 * Tests will need to either inject the cache or run serially.
 */
let binding: Binding | undefined
let currentToolUseContext: ToolUseContext | undefined

function tuc(): ToolUseContext {
  // Safe: `binding` is only populated when `currentToolUseContext` is set.
  // Called only from within `ctx` callbacks, which only fire during dispatch.
  return currentToolUseContext!
}

function formatLockHeld(holder: string): string {
  return `Computer use is in use by another Claude session (${holder.slice(0, 8)}…). Wait for that session to finish or run /exit there.`
}

export function buildSessionContext(): ComputerUseSessionContext {
  return {
    // ── Read state fresh via the per-call ref ─────────────────────────────
    getAllowedApps: () =>
      tuc().getAppState().computerUseMcpState?.allowedApps ?? [],
    getGrantFlags: () =>
      tuc().getAppState().computerUseMcpState?.grantFlags ??
      DEFAULT_GRANT_FLAGS,
    // cc-2 has no Settings page for user-denied apps yet.
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () =>
      tuc().getAppState().computerUseMcpState?.selectedDisplayId,
    getDisplayPinnedByModel: () =>
      tuc().getAppState().computerUseMcpState?.displayPinnedByModel ?? false,
    getDisplayResolvedForApps: () =>
      tuc().getAppState().computerUseMcpState?.displayResolvedForApps,
    getLastScreenshotDims: (): ScreenshotDims | undefined => {
      const d = tuc().getAppState().computerUseMcpState?.lastScreenshotDims
      return d
        ? {
            ...d,
            displayId: d.displayId ?? 0,
            originX: d.originX ?? 0,
            originY: d.originY ?? 0,
          }
        : undefined
    },

    // ── Write-backs ────────────────────────────────────────────────────────
    // `setToolJSX` is guaranteed present — the gate in `main.tsx` excludes
    // non-interactive sessions. The package's `_dialogSignal` (tool-finished
    // dismissal) is irrelevant here: `setToolJSX` blocks the tool call, so
    // the dialog can't outlive it. Ctrl+C is what matters, and
    // `runPermissionDialog` wires that from the per-call ref's abortController.
    onPermissionRequest: (req, _dialogSignal) => runPermissionDialog(req),

    // Package does the merge (dedupe + truthy-only flags). We just persist.
    onAllowedAppsChanged: (apps, flags) =>
      tuc().setAppState(prev => {
        const cu = prev.computerUseMcpState
        const prevApps = cu?.allowedApps
        const prevFlags = cu?.grantFlags
        const sameApps =
          prevApps?.length === apps.length &&
          apps.every((a, i) => prevApps[i]?.bundleId === a.bundleId)
        const sameFlags =
          prevFlags?.clipboardRead === flags.clipboardRead &&
          prevFlags?.clipboardWrite === flags.clipboardWrite &&
          prevFlags?.systemKeyCombos === flags.systemKeyCombos
        return sameApps && sameFlags
          ? prev
          : {
              ...prev,
              computerUseMcpState: {
                ...cu,
                allowedApps: [...apps],
                grantFlags: flags,
              },
            }
      }),

    onAppsHidden: ids => {
      if (ids.length === 0) return
      tuc().setAppState(prev => {
        const cu = prev.computerUseMcpState
        const existing = cu?.hiddenDuringTurn
        if (existing && ids.every(id => existing.has(id))) return prev
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            hiddenDuringTurn: new Set([...(existing ?? []), ...ids]),
          },
        }
      })
    },

    // Resolver writeback only fires under a pin when Swift fell back to main
    // (pinned display unplugged) — the pin is semantically dead, so clear it
    // and the app-set key so the chase chain runs next time. When autoResolve
    // was true, onDisplayResolvedForApps re-sets the key in the same tick.
    onResolvedDisplayUpdated: id =>
      tuc().setAppState(prev => {
        const cu = prev.computerUseMcpState
        if (
          cu?.selectedDisplayId === id &&
          !cu.displayPinnedByModel &&
          cu.displayResolvedForApps === undefined
        ) {
          return prev
        }
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            selectedDisplayId: id,
            displayPinnedByModel: false,
            displayResolvedForApps: undefined,
          },
        }
      }),

    // switch_display(name) pins; switch_display("auto") unpins and clears the
    // app-set key so the next screenshot auto-resolves fresh.
    onDisplayPinned: id =>
      tuc().setAppState(prev => {
        const cu = prev.computerUseMcpState
        const pinned = id !== undefined
        const nextResolvedFor = pinned ? cu?.displayResolvedForApps : undefined
        if (
          cu?.selectedDisplayId === id &&
          cu?.displayPinnedByModel === pinned &&
          cu?.displayResolvedForApps === nextResolvedFor
        ) {
          return prev
        }
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            selectedDisplayId: id,
            displayPinnedByModel: pinned,
            displayResolvedForApps: nextResolvedFor,
          },
        }
      }),

    onDisplayResolvedForApps: key =>
      tuc().setAppState(prev => {
        const cu = prev.computerUseMcpState
        if (cu?.displayResolvedForApps === key) return prev
        return {
          ...prev,
          computerUseMcpState: { ...cu, displayResolvedForApps: key },
        }
      }),

    onScreenshotCaptured: dims =>
      tuc().setAppState(prev => {
        const cu = prev.computerUseMcpState
        const p = cu?.lastScreenshotDims
        return p?.width === dims.width &&
          p?.height === dims.height &&
          p?.displayWidth === dims.displayWidth &&
          p?.displayHeight === dims.displayHeight &&
          p?.displayId === dims.displayId &&
          p?.originX === dims.originX &&
          p?.originY === dims.originY
          ? prev
          : {
              ...prev,
              computerUseMcpState: { ...cu, lastScreenshotDims: dims },
            }
      }),

    // ── Lock — async, direct file-lock calls ───────────────────────────────
    // No `lockHolderForGate` dance: the package's gate is async now. It
    // awaits `checkCuLock`, and on `holder: undefined` + non-deferring tool
    // awaits `acquireCuLock`. `defersLockAcquire` is the PACKAGE's set —
    // the local copy is gone.
    checkCuLock: async () => {
      const c = await checkComputerUseLock()
      switch (c.kind) {
        case 'free':
          return { holder: undefined, isSelf: false }
        case 'held_by_self':
          return { holder: getSessionId(), isSelf: true }
        case 'blocked':
          return { holder: c.by, isSelf: false }
      }
    },

    // Called only when checkCuLock returned `holder: undefined`. The O_EXCL
    // acquire is atomic — if another process grabbed it in the gap (rare),
    // throw so the tool fails instead of proceeding without the lock.
    // `fresh: false` (re-entrant) shouldn't happen given check said free,
    // but is possible under parallel tool-use interleaving — don't spam the
    // notification in that case.
    acquireCuLock: async () => {
      const r = await tryAcquireComputerUseLock()
      if (r.kind === 'blocked') {
        throw new Error(formatLockHeld(r.by))
      }
      if (r.fresh) {
        if (getComputerUseBackendKind() === 'native-adapter') {
          // Native-only bare Escape. Zavora owns its status-card stop/pause
          // control and must never share this CGEventTap state machine.
          const { registerEscHotkey } = await import('./escHotkey.js')
          const escRegistered = await registerEscHotkey(() => {
            logForDebugging('[cu-esc] user escape, aborting turn')
            tuc().abortController.abort()
          })
          tuc().sendOSNotification?.({
            message: escRegistered
              ? 'Claude is using your computer · press Esc to stop'
              : 'Claude is using your computer · press Ctrl+C to stop',
            notificationType: 'computer_use_enter',
          })
        } else {
          tuc().sendOSNotification?.({
            message:
              'Claude is using your computer · use the Zavora status card or Ctrl+C to stop',
            notificationType: 'computer_use_enter',
          })
        }
      }
    },

    formatLockHeldMessage: formatLockHeld,
  }
}

async function getOrBind(): Promise<Binding> {
  if (binding) return binding
  const ctx = buildSessionContext()
  let backend: ComputerUseBackend
  if (getComputerUseBackendKind() === 'native-adapter') {
    const { getComputerUseHostAdapter } = await import('./hostAdapter.js')
    backend = createNativeComputerUseBackend(
      getComputerUseHostAdapter(),
      getChicagoCoordinateMode(),
    )
  } else {
    backend = createZavoraComputerUseBackend()
  }
  binding = {
    ctx,
    backend,
    dispatch: (name, args, signal) =>
      backend.dispatch(
        name,
        args,
        ctx,
        signal ?? new AbortController().signal,
      ),
  }
  return binding
}

/** Close the selected backend without touching the other implementation. */
export async function closeComputerUseBackend(): Promise<void> {
  const current = binding
  binding = undefined
  currentToolUseContext = undefined
  await current?.backend.close()
}

/**
 * Returns the full override object for a single `mcp__computer-use__{toolName}`
 * tool: rendering overrides from `toolRendering.tsx` plus a `.call()` that
 * dispatches through the cached binder.
 */
type ComputerUseMCPToolOverrides = ReturnType<
  typeof getComputerUseMCPRenderingOverrides
> & {
  call: CallOverride
}

export function getComputerUseMCPToolOverrides(
  toolName: string,
): ComputerUseMCPToolOverrides {
  const call: CallOverride = async (args, context: ToolUseContext) => {
    currentToolUseContext = context
    const { dispatch } = await getOrBind()

    const { telemetry, ...result } = await dispatch(
      toolName,
      args,
      context.abortController.signal,
    )

    if (telemetry?.error_kind) {
      logForDebugging(
        `[Computer Use MCP] ${toolName} error_kind=${telemetry.error_kind}`,
      )
    }

    const data = Array.isArray(result.content)
      ? result.content.map(item => {
          if (item.type === 'image') {
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: item.mimeType ?? 'image/jpeg',
                data: item.data,
              },
            }
          }
          if (item.type === 'text') {
            return { type: 'text' as const, text: item.text }
          }
          if (item.type === 'resource_link') {
            return {
              type: 'text' as const,
              text: JSON.stringify({ uri: item.uri, name: item.name }),
            }
          }
          return { type: 'text' as const, text: JSON.stringify(item) }
        })
      : result.content
    return {
      data,
      ...(result.isError ? { isError: true } : {}),
      ...(result.structuredContent
        ? { mcpMeta: { structuredContent: result.structuredContent } }
        : {}),
    }
  }

  return {
    ...getComputerUseMCPRenderingOverrides(toolName),
    call,
  }
}

/**
 * Render the approval dialog mid-call via `setToolJSX` + `Promise`, wait for
 * the user. Mirrors `spawnMultiAgent.ts:419-436` (the `It2SetupPrompt` pattern).
 *
 * The merge-into-AppState that used to live here (dedupe + truthy-only flags)
 * is now in the package's `bindSessionContext` → `onAllowedAppsChanged`.
 */
async function runPermissionDialog(
  req: CuPermissionRequest,
): Promise<CuPermissionResponse> {
  const context = tuc()
  const setToolJSX = context.setToolJSX
  if (!setToolJSX) {
    // Shouldn't happen — main.tsx gate excludes non-interactive. Fail safe.
    return { granted: [], denied: [], flags: DEFAULT_GRANT_FLAGS }
  }

  try {
    return await new Promise<CuPermissionResponse>((resolve, reject) => {
      const signal = context.abortController.signal
      // If already aborted, addEventListener won't fire — reject now so the
      // promise doesn't hang waiting for a user who Ctrl+C'd.
      if (signal.aborted) {
        reject(new Error('Computer Use permission dialog aborted'))
        return
      }
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error('Computer Use permission dialog aborted'))
      }
      signal.addEventListener('abort', onAbort)

      setToolJSX({
        jsx: React.createElement(ComputerUseApproval, {
          request: req,
          onDone: (resp: CuPermissionResponse) => {
            signal.removeEventListener('abort', onAbort)
            resolve(resp)
          },
        }),
        shouldHidePromptInput: true,
      })
    })
  } finally {
    setToolJSX(null)
  }
}
