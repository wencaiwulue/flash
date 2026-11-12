import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createComputerUseServer,
  type ServerOptions,
} from '@zavora-ai/computer-use-mcp/server'
import { callMutates } from '@zavora-ai/computer-use-mcp/tool-catalog'
import type {
  AppGrant,
  ComputerUseBackend,
  ComputerUseSessionContext,
  ComputerUseTool,
  CuCallToolResult,
  CuGrantFlags,
} from './computer-use-types.js'

export * from './computer-use-types.js'
export {
  API_RESIZE_PARAMS,
  bindSessionContext,
  buildComputerUseTools,
  createComputerUseMcpServer,
  createNativeComputerUseBackend,
  targetImageSize,
} from './computer-use-native.js'
export type { ImageResizeParams } from './computer-use-native.js'

export type ZavoraServerOptions = Omit<
  ServerOptions,
  'profile' | 'authorizeToolCall'
>

async function connectClient(
  options: ServerOptions = { profile: 'desktop' },
): Promise<Client> {
  const server = createComputerUseServer(options)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'open-zavora-desktop', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

let clientPromise: Promise<Client> | undefined

/** Zavora-only catalog client. It is never used by the native adapter. */
export function getOpenComputerUseClient(): Promise<Client> {
  clientPromise ??= connectClient().catch(error => {
    clientPromise = undefined
    throw error
  })
  return clientPromise
}

export async function closeOpenComputerUseClient(): Promise<void> {
  const pending = clientPromise
  clientPromise = undefined
  if (pending) await (await pending).close()
}

export async function listOpenComputerUseTools(): Promise<ComputerUseTool[]> {
  const client = await getOpenComputerUseClient()
  const result = await client.listTools()
  return result.tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }))
}

function abortError(): Error {
  const error = new Error('Zavora Computer Use call aborted')
  error.name = 'AbortError'
  return error
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function hostError(kind: string, message: string): Error {
  return Object.assign(new Error(`[${kind}] ${message}`), { errorKind: kind })
}

function targetFor(name: string, args: Record<string, unknown>): string {
  if (typeof args.target_app === 'string') return args.target_app
  if (typeof args.bundle_id === 'string') return args.bundle_id
  if (name === 'set_target' && typeof args.app === 'string') return args.app
  return ''
}

function matches(grant: AppGrant, target: string): boolean {
  return (
    grant.bundleId === target ||
    grant.displayName.toLowerCase() === target.toLowerCase()
  )
}

function hasSystemCombo(args: Record<string, unknown>): boolean {
  if (typeof args.text !== 'string') return false
  const parts = args.text.toLowerCase().split('+')
  return (
    parts.length > 1 &&
    parts.some(part =>
      ['command', 'cmd', 'ctrl', 'control', 'alt', 'option', 'meta'].includes(
        part,
      ),
    )
  )
}

function requiredFlags(
  name: string,
  args: Record<string, unknown>,
): Partial<CuGrantFlags> {
  if (name === 'read_clipboard') return { clipboardRead: true }
  if (name === 'write_clipboard') return { clipboardWrite: true }
  if (name === 'doctor') {
    // Zavora doctor performs a clipboard read/write round trip in addition to
    // OS preflight, so it must never run as an ungated metadata call.
    return { clipboardRead: true, clipboardWrite: true }
  }
  if ((name === 'key' || name === 'hold_key') && hasSystemCombo(args)) {
    return { systemKeyCombos: true }
  }
  if (name === 'run_steps' && Array.isArray(args.steps)) {
    return args.steps.reduce<Partial<CuGrantFlags>>((flags, step) => {
      if (typeof step !== 'object' || step === null) return flags
      const value = step as Record<string, unknown>
      const stepArgs =
        typeof value.args === 'object' && value.args !== null
          ? (value.args as Record<string, unknown>)
          : value
      return {
        ...flags,
        ...requiredFlags(String(value.tool ?? value.name ?? ''), stepArgs),
      }
    }, {})
  }
  return {}
}

const NO_GRANT_TOOLS = new Set([
  'policy_status',
  'get_tool_guide',
  'get_app_capabilities',
  'get_tool_metadata',
  'control_status',
  'list_displays',
  'get_display_size',
  'cursor_position',
  'wait',
])

const TARGET_OPTIONAL_TOOLS = new Set([
  ...NO_GRANT_TOOLS,
  'doctor',
  'read_clipboard',
  'write_clipboard',
  'discover_applications',
  'get_frontmost_app',
  'get_target',
  'control_status',
])

async function authorizeZavoraCall(options: {
  name: string
  args: Record<string, unknown>
  context: ComputerUseSessionContext
  signal: AbortSignal
  sessionTarget: string
}): Promise<void> {
  const { name, args, context, signal, sessionTarget } = options
  checkAbort(signal)
  if (name === 'screenshot' && args.full_screen === true) {
    throw hostError('permission_denied', 'Full-screen Zavora capture would exceed application grants; capture a granted target_app instead')
  }
  if (name === 'run_steps' && Array.isArray(args.steps)) {
    if (args.capture === 'screen') {
      throw hostError('permission_denied', 'run_steps screen capture is not allowed; use window capture with a granted target')
    }
    if (args.capture === 'window' && !targetFor(name, args) && !sessionTarget) {
      throw hostError('permission_denied', 'run_steps window capture requires a granted target_app')
    }
    if (targetFor(name, args) || args.target_window_id !== undefined) {
      await authorizeZavoraCall({
        name: 'screenshot',
        args: {
          target_app: args.target_app,
          target_window_id: args.target_window_id,
        },
        context,
        signal,
        sessionTarget,
      })
    }
    for (const entry of args.steps) {
      if (typeof entry !== 'object' || entry === null) {
        throw hostError('invalid_arguments', 'run_steps entries must be objects')
      }
      const step = entry as Record<string, unknown>
      const tool = step.tool ?? step.name
      if (typeof tool !== 'string') throw hostError('invalid_arguments', 'run_steps entry has no tool')
      const stepArgs =
        typeof step.args === 'object' && step.args !== null
          ? { ...(step.args as Record<string, unknown>) }
          : {}
      if (stepArgs.target_app === undefined && args.target_app !== undefined) {
        stepArgs.target_app = args.target_app
      }
      if (
        stepArgs.target_window_id === undefined &&
        args.target_window_id !== undefined
      ) {
        stepArgs.target_window_id = args.target_window_id
      }
      await authorizeZavoraCall({
        name: tool,
        args: stepArgs,
        context,
        signal,
        sessionTarget,
      })
    }
    return
  }
  if (name === 'doctor' || callMutates(name, args)) {
    const lock = await context.checkCuLock()
    if (lock.holder && !lock.isSelf) {
      throw hostError('lock_held', context.formatLockHeldMessage(lock.holder))
    }
    if (!lock.holder) await context.acquireCuLock()
  }

  const needed = requiredFlags(name, args)
  const currentFlags = context.getGrantFlags()
  const missingFlag = (Object.keys(needed) as Array<keyof CuGrantFlags>).some(
    key => needed[key] && !currentFlags[key],
  )
  const explicitTarget = targetFor(name, args)
  const effectiveTarget =
    explicitTarget ||
    (args.target_window_id !== undefined || args.window_id !== undefined
      ? sessionTarget
      : '')
  if (
    (args.target_window_id !== undefined || args.window_id !== undefined) &&
    !effectiveTarget
  ) {
    throw hostError('permission_denied', 'A granted target_app is required with a window ID')
  }
  const needsGrant = !NO_GRANT_TOOLS.has(name)
  if (needsGrant && !TARGET_OPTIONAL_TOOLS.has(name) && !effectiveTarget) {
    throw hostError('permission_denied', `A granted target_app is required for ${name}`)
  }
  let grants = context.getAllowedApps()
  const missingTarget =
    effectiveTarget.length > 0 &&
    !grants.some(grant => matches(grant, effectiveTarget))
  if (needsGrant && (grants.length === 0 || missingTarget || missingFlag)) {
    const requestedName = effectiveTarget || 'this application'
    const requestedFlags: CuGrantFlags = {
      clipboardRead:
        currentFlags.clipboardRead || needed.clipboardRead === true,
      clipboardWrite:
        currentFlags.clipboardWrite || needed.clipboardWrite === true,
      systemKeyCombos:
        currentFlags.systemKeyCombos || needed.systemKeyCombos === true,
    }
    const response = await context.onPermissionRequest(
      {
        apps: [
          {
            requestedName,
            alreadyGranted: grants.some(grant =>
              matches(grant, requestedName),
            ),
          },
        ],
        requestedFlags,
        reason: `Allow Zavora ${name} only for this target and capability`,
      },
      signal,
    )
    checkAbort(signal)
    if (
      response.denied.length > 0 ||
      (requestedName === 'this application'
        ? response.granted.length === 0
        : !response.granted.some(grant => matches(grant, requestedName)))
    ) {
      throw hostError('permission_denied', `Computer Use permission denied: ${name}`)
    }
    for (const key of Object.keys(needed) as Array<keyof CuGrantFlags>) {
      if (needed[key] && !response.flags[key]) {
        throw hostError('permission_denied', `Computer Use flag not granted: ${key}`)
      }
    }
    const merged = new Map(grants.map(grant => [grant.bundleId, grant]))
    for (const grant of response.granted) merged.set(grant.bundleId, grant)
    const flags = {
      clipboardRead:
        currentFlags.clipboardRead || response.flags.clipboardRead,
      clipboardWrite:
        currentFlags.clipboardWrite || response.flags.clipboardWrite,
      systemKeyCombos:
        currentFlags.systemKeyCombos || response.flags.systemKeyCombos,
    }
    context.onAllowedAppsChanged([...merged.values()], flags)
    grants = context.getAllowedApps()
  }
  if (
    effectiveTarget &&
    !grants.some(grant => matches(grant, effectiveTarget))
  ) {
    throw hostError('permission_denied', `Target application is not granted: ${effectiveTarget}`)
  }
  if (needsGrant && grants.length === 0) {
    throw hostError('permission_denied', 'Computer Use requires an application grant')
  }
}

export function createZavoraComputerUseBackend(options?: {
  serverOptions?: ZavoraServerOptions
}): ComputerUseBackend {
  let current:
    | { context: ComputerUseSessionContext; signal: AbortSignal }
    | undefined
  let sessionTarget = ''
  const clientPromise = connectClient({
    ...options?.serverOptions,
    profile: 'desktop',
    structuredContent: true,
    advertiseApprovalToken: false,
    authorizeToolCall: async ({ definition, args }) => {
      if (!current) throw new Error('Zavora call has no host session context')
      await authorizeZavoraCall({
        name: definition.name,
        args: { ...args },
        context: current.context,
        signal: current.signal,
        sessionTarget,
      })
    },
    elicitApproval: async details => {
      if (!current) return false
      const target = details.targetApp ?? targetFor(details.tool, details.args)
      const context = current.context
      const response = await context.onPermissionRequest(
        {
          apps: [
            {
              requestedName: target || 'this application',
              alreadyGranted: context
                .getAllowedApps()
                .some(grant => matches(grant, target)),
            },
          ],
          requestedFlags: context.getGrantFlags(),
          reason: details.reasons.join('; '),
        },
        current.signal,
      )
      if (
        response.denied.length > 0 ||
        response.granted.length === 0 ||
        (target.length > 0 &&
          !response.granted.some(grant => matches(grant, target)))
      ) {
        return false
      }
      const merged = new Map(
        context.getAllowedApps().map(grant => [grant.bundleId, grant]),
      )
      for (const grant of response.granted) merged.set(grant.bundleId, grant)
      context.onAllowedAppsChanged([...merged.values()], {
        clipboardRead:
          context.getGrantFlags().clipboardRead || response.flags.clipboardRead,
        clipboardWrite:
          context.getGrantFlags().clipboardWrite ||
          response.flags.clipboardWrite,
        systemKeyCombos:
          context.getGrantFlags().systemKeyCombos ||
          response.flags.systemKeyCombos,
      })
      return true
    },
  })

  return {
    kind: 'zavora',
    async listTools() {
      const client = await clientPromise
      const result = await client.listTools()
      return result.tools.map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }))
    },
    async dispatch(name, args, context, signal) {
      if (current) throw hostError('lock_held', 'Zavora calls must be serialized')
      current = { context, signal }
      try {
        checkAbort(signal)
        const client = await clientPromise
        const result = await client.callTool(
          {
            name,
            arguments: (args ?? {}) as Record<string, unknown>,
          },
          undefined,
          { signal },
        )
        if (name === 'set_target') {
          const values = (args ?? {}) as Record<string, unknown>
          sessionTarget =
            values.clear === true
              ? ''
              : typeof values.app === 'string'
                ? values.app
                : sessionTarget
        }
        const content = result.content as CuCallToolResult['content']
        let structuredContent = result.structuredContent as
          | Record<string, unknown>
          | undefined
        if (!structuredContent && Array.isArray(content)) {
          const text = content.find(block => block.type === 'text')?.text
          if (text) {
            try {
              const parsed: unknown = JSON.parse(text)
              if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                structuredContent = parsed as Record<string, unknown>
              }
            } catch {
              // Plain text is a valid Zavora result; there is no metadata to add.
            }
          }
        }
        return {
          content,
          ...(result.isError ? { isError: true } : {}),
          ...(structuredContent ? { structuredContent } : {}),
        }
      } catch (error) {
        if (signal.aborted || (error as { name?: string }).name === 'AbortError') {
          throw abortError()
        }
        const message = error instanceof Error ? error.message : String(error)
        const kind =
          (error as { errorKind?: string }).errorKind ??
          message.match(/\[([a-z_]+)\]/)?.[1] ??
          'backend_dispatch'
        return {
          content: `Computer Use ${kind}: ${message}`,
          isError: true,
          structuredContent: {
            error: kind,
            remediation: message,
          },
          telemetry: { error_kind: kind },
        }
      } finally {
        current = undefined
      }
    },
    async close() {
      const client = await clientPromise
      await client.close()
    },
  }
}

export function bindZavoraSessionContext(
  context: ComputerUseSessionContext,
): (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<CuCallToolResult> {
  const backend = createZavoraComputerUseBackend()
  return (name, args, signal) =>
    backend.dispatch(
      name,
      args,
      context,
      signal ?? new AbortController().signal,
    )
}
