import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resetComputerUseInputLoader } from '../utils/computerUse/inputLoader.js'
import { closeComputerUseHelper } from '../utils/computerUse/nativeHelper.js'
import { resetComputerUseSwiftLoader } from '../utils/computerUse/swiftLoader.js'
import type {
  AppGrant,
  ComputerUseBackend,
  ComputerUseCapabilities,
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  ComputerUseTool,
  CoordinateMode,
  CuCallToolResult,
  CuGrantFlags,
  ScreenshotDims,
} from './computer-use-types.js'

export const API_RESIZE_PARAMS = Object.freeze({
  maxWidth: 1568,
  maxHeight: 1568,
  maxPixels: 1_150_000,
})

export type ImageResizeParams = {
  maxWidth: number
  maxHeight: number
  maxPixels: number
}

export function targetImageSize(
  width: number,
  height: number,
  params: ImageResizeParams,
): [number, number] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError('Image dimensions must be finite positive numbers')
  }
  if (
    !Number.isFinite(params.maxWidth) ||
    !Number.isFinite(params.maxHeight) ||
    !Number.isFinite(params.maxPixels) ||
    params.maxWidth <= 0 ||
    params.maxHeight <= 0 ||
    params.maxPixels <= 0
  ) {
    throw new RangeError('Image resize limits must be finite positive numbers')
  }
  const scale = Math.min(
    1,
    params.maxWidth / width,
    params.maxHeight / height,
    Math.sqrt(params.maxPixels / (width * height)),
  )
  let outputWidth = Math.max(1, Math.round(width * scale))
  let outputHeight = Math.max(1, Math.round(height * scale))
  while (outputWidth * outputHeight > params.maxPixels) {
    if (outputWidth >= outputHeight) outputWidth--
    else outputHeight--
  }
  return [outputWidth, outputHeight]
}

type Args = Record<string, unknown>
const targetApp = { type: 'string', description: 'Granted bundle identifier' }
const coordinate = {
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
}
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const definitions: Array<
  [string, string, Record<string, unknown>, string[]?]
> = [
  ['screenshot', 'Capture only granted applications on the resolved display.', object({ target_app: targetApp })],
  ['zoom', 'Capture a logical region from the last screenshot display.', object({ region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, target_app: targetApp }, ['region'])],
  ['request_access', 'Request exact application and clipboard/system-key grants.', object({ apps: { type: 'array', items: object({ displayName: { type: 'string' }, bundleId: { type: 'string' } }) }, flags: object({ clipboardRead: { type: 'boolean' }, clipboardWrite: { type: 'boolean' }, systemKeyCombos: { type: 'boolean' } }) }, ['apps'])],
  ['list_granted_applications', 'List grants in the current session.', object({})],
  ['list_displays', 'Enumerate public CoreGraphics display geometry.', object({})],
  ['switch_display', 'Pin a display by ID, or auto for automatic resolution.', object({ display_id: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['auto'] }] } }, ['display_id'])],
  ['mouse_move', 'Move within the last screenshot display.', object({ coordinate, target_app: targetApp }, ['coordinate'])],
  ['left_click', 'Left click within the last screenshot display.', object({ coordinate, target_app: targetApp, modifiers: { type: 'array', items: { type: 'string' } } }, ['coordinate'])],
  ['right_click', 'Right click within the last screenshot display.', object({ coordinate, target_app: targetApp }, ['coordinate'])],
  ['middle_click', 'Middle click within the last screenshot display.', object({ coordinate, target_app: targetApp }, ['coordinate'])],
  ['double_click', 'Double click within the last screenshot display.', object({ coordinate, target_app: targetApp }, ['coordinate'])],
  ['triple_click', 'Triple click within the last screenshot display.', object({ coordinate, target_app: targetApp }, ['coordinate'])],
  ['left_mouse_down', 'Press the left mouse button.', object({ target_app: targetApp })],
  ['left_mouse_up', 'Release the left mouse button.', object({ target_app: targetApp })],
  ['cursor_position', 'Read the global logical cursor position.', object({ target_app: targetApp })],
  ['left_click_drag', 'Drag between coordinates in the last screenshot display.', object({ coordinate, start_coordinate: coordinate, target_app: targetApp }, ['coordinate'])],
  ['scroll', 'Scroll at a coordinate in the last screenshot display.', object({ coordinate, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1 }, target_app: targetApp }, ['coordinate', 'direction', 'amount'])],
  ['type', 'Type Unicode text into a granted frontmost application.', object({ text: { type: 'string' }, target_app: targetApp }, ['text'])],
  ['key', 'Press a key or explicitly granted system combination.', object({ text: { type: 'string' }, repeat: { type: 'integer', minimum: 1 }, target_app: targetApp }, ['text'])],
  ['hold_key', 'Hold and finally release one or more keys.', object({ text: { type: 'string' }, duration: { type: 'number', exclusiveMinimum: 0, maximum: 10 }, target_app: targetApp }, ['text', 'duration'])],
  ['read_clipboard', 'Read the clipboard with clipboardRead permission.', object({})],
  ['write_clipboard', 'Write the clipboard with clipboardWrite permission.', object({ text: { type: 'string' } }, ['text'])],
  ['open_application', 'Open a granted application through NSWorkspace.', object({ bundle_id: { type: 'string' } }, ['bundle_id'])],
  ['list_installed_applications', 'Enumerate installed applications through public bundles.', object({})],
  ['list_running_applications', 'Enumerate running applications through NSWorkspace.', object({})],
  ['wait', 'Wait for a bounded number of seconds.', object({ duration: { type: 'number', minimum: 0, maximum: 30 } }, ['duration'])],
  ['computer_batch', 'Execute native actions serially with per-action authorization.', object({ actions: { type: 'array', items: object({ name: { type: 'string' }, args: { type: 'object' } }, ['name', 'args']) } }, ['actions'])],
]

export function buildComputerUseTools(
  _capabilities: ComputerUseCapabilities,
  coordinateMode: CoordinateMode,
  _installedAppNames?: string[],
): ComputerUseTool[] {
  return definitions.map(([name, description, inputSchema]) => ({
    name,
    description: `${description} Coordinates: ${coordinateMode === 'pixels' ? 'global macOS logical points including display origin' : 'normalized [0,1] relative to the last screenshot display'}.`,
    inputSchema,
  }))
}

export function createComputerUseMcpServer(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
): Server {
  const server = new Server(
    { name: adapter.serverName, version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: adapter.isDisabled()
      ? []
      : buildComputerUseTools(adapter.executor.capabilities, coordinateMode),
  }))
  return server
}

function abortError(): Error {
  const error = new Error('Computer Use action aborted')
  error.name = 'AbortError'
  return error
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function asArgs(value: unknown): Args {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw Object.assign(new Error('Tool arguments must be an object'), {
      errorKind: 'invalid_arguments',
    })
  }
  return value as Args
}

function stringArg(args: Args, key: string, optional = false): string {
  const value = args[key]
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`${key} must be a non-empty string`), {
      errorKind: 'invalid_arguments',
    })
  }
  return value
}

function numberArg(args: Args, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Object.assign(new Error(`${key} must be a finite number`), {
      errorKind: 'invalid_arguments',
    })
  }
  return value
}

function pair(value: unknown): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some(n => typeof n !== 'number' || !Number.isFinite(n))
  ) {
    throw Object.assign(new Error('coordinate must contain two finite numbers'), {
      errorKind: 'invalid_arguments',
    })
  }
  return [value[0] as number, value[1] as number]
}

function grantMatches(grant: AppGrant, requested: string): boolean {
  return (
    grant.bundleId === requested ||
    grant.displayName.toLowerCase() === requested.toLowerCase()
  )
}

function mergeGrants(
  current: readonly AppGrant[],
  added: readonly AppGrant[],
): AppGrant[] {
  const merged = new Map(current.map(grant => [grant.bundleId, grant]))
  for (const grant of added) merged.set(grant.bundleId, grant)
  return [...merged.values()]
}

async function requestGrants(
  context: ComputerUseSessionContext,
  requestedName: string,
  flags: CuGrantFlags,
  signal: AbortSignal,
): Promise<void> {
  const current = context.getAllowedApps()
  const response = await context.onPermissionRequest(
    {
      apps: [
        {
          requestedName,
          alreadyGranted: current.some(grant =>
            grantMatches(grant, requestedName),
          ),
        },
      ],
      requestedFlags: flags,
      reason: 'Allow this exact Computer Use target and capability',
    },
    signal,
  )
  checkAbort(signal)
  if (response.denied.length > 0) {
    throw Object.assign(new Error('Computer Use permission denied'), {
      errorKind: 'permission_denied',
    })
  }
  const matching = response.granted.filter(grant =>
    grantMatches(grant, requestedName),
  )
  if (requestedName !== 'this application' && matching.length === 0) {
    throw Object.assign(
      new Error(`Permission response did not grant ${requestedName}`),
      { errorKind: 'permission_denied' },
    )
  }
  if (requestedName === 'this application' && response.granted.length === 0) {
    throw Object.assign(new Error('Computer Use permission denied'), {
      errorKind: 'permission_denied',
    })
  }
  for (const key of Object.keys(flags) as Array<keyof CuGrantFlags>) {
    if (flags[key] && !response.flags[key]) {
      throw Object.assign(new Error(`Computer Use flag not granted: ${key}`), {
        errorKind: 'permission_denied',
      })
    }
  }
  const mergedFlags = {
    clipboardRead: flags.clipboardRead || response.flags.clipboardRead,
    clipboardWrite: flags.clipboardWrite || response.flags.clipboardWrite,
    systemKeyCombos:
      flags.systemKeyCombos || response.flags.systemKeyCombos,
  }
  context.onAllowedAppsChanged(
    mergeGrants(current, response.granted),
    mergedFlags,
  )
}

async function ensureGrants(
  context: ComputerUseSessionContext,
  args: Args,
  needed: Partial<CuGrantFlags>,
  signal: AbortSignal,
): Promise<readonly AppGrant[]> {
  const currentFlags = context.getGrantFlags()
  const requestedFlags: CuGrantFlags = {
    clipboardRead:
      currentFlags.clipboardRead || needed.clipboardRead === true,
    clipboardWrite:
      currentFlags.clipboardWrite || needed.clipboardWrite === true,
    systemKeyCombos:
      currentFlags.systemKeyCombos || needed.systemKeyCombos === true,
  }
  const missingFlag = (Object.keys(needed) as Array<keyof CuGrantFlags>).some(
    key => needed[key] && !currentFlags[key],
  )
  const requested =
    typeof args.target_app === 'string'
      ? args.target_app
      : typeof args.bundle_id === 'string'
        ? args.bundle_id
        : ''
  let grants = context.getAllowedApps()
  const missingTarget =
    requested.length > 0 &&
    !grants.some(grant => grantMatches(grant, requested))
  if (missingFlag || missingTarget || grants.length === 0) {
    await requestGrants(
      context,
      requested || 'this application',
      requestedFlags,
      signal,
    )
    grants = context.getAllowedApps()
  }
  if (grants.length === 0) {
    throw Object.assign(new Error('No application is granted'), {
      errorKind: 'permission_denied',
    })
  }
  if (
    requested &&
    !grants.some(grant => grantMatches(grant, requested))
  ) {
    throw Object.assign(new Error(`Target is not granted: ${requested}`), {
      errorKind: 'permission_denied',
    })
  }
  return grants
}

function isSystemCombo(text: string): boolean {
  const parts = text.toLowerCase().split('+')
  return (
    parts.length > 1 &&
    parts.some(part =>
      ['command', 'cmd', 'ctrl', 'control', 'alt', 'option', 'meta'].includes(
        part,
      ),
    )
  )
}

function resolvePoint(
  value: unknown,
  mode: CoordinateMode,
  dims: ScreenshotDims | undefined,
): { x: number; y: number } {
  if (!dims) {
    throw Object.assign(new Error('Take a screenshot before using coordinates'), {
      errorKind: 'stale_screenshot',
    })
  }
  const [inputX, inputY] = pair(value)
  const x = mode === 'normalized' ? dims.originX + inputX * dims.displayWidth : inputX
  const y = mode === 'normalized' ? dims.originY + inputY * dims.displayHeight : inputY
  if (mode === 'normalized' && (inputX < 0 || inputX > 1 || inputY < 0 || inputY > 1)) {
    throw Object.assign(new Error('Normalized coordinates must be within [0,1]'), {
      errorKind: 'invalid_coordinates',
    })
  }
  if (
    x < dims.originX ||
    y < dims.originY ||
    x > dims.originX + dims.displayWidth ||
    y > dims.originY + dims.displayHeight
  ) {
    throw Object.assign(new Error('Coordinates are outside the captured display'), {
      errorKind: 'invalid_coordinates',
    })
  }
  return { x, y }
}

async function verifyFrontmost(
  adapter: ComputerUseHostAdapter,
  grants: readonly AppGrant[],
  args: Args,
): Promise<void> {
  const frontmost = await adapter.executor.getFrontmostApp()
  if (!frontmost || !grants.some(grant => grant.bundleId === frontmost.bundleId)) {
    throw Object.assign(
      new Error('Computer Use target is not frontmost; input was not sent'),
      { errorKind: 'focus_failed' },
    )
  }
  const requested = typeof args.target_app === 'string' ? args.target_app : ''
  if (
    requested &&
    frontmost.bundleId !== requested &&
    frontmost.displayName.toLowerCase() !== requested.toLowerCase()
  ) {
    throw Object.assign(new Error(`Frontmost app is not ${requested}`), {
      errorKind: 'focus_failed',
    })
  }
}

function success(
  structuredContent: Record<string, unknown>,
  content: CuCallToolResult['content'] = JSON.stringify(structuredContent),
): CuCallToolResult {
  return { content, structuredContent }
}

function failure(error: unknown): CuCallToolResult {
  const value = error as { message?: string; errorKind?: string }
  const kind = value.errorKind ?? 'native_action_failed'
  const message = value.message ?? String(error)
  return {
    content: `Computer Use ${kind}: ${message}`,
    isError: true,
    structuredContent: { error: kind, remediation: message },
    telemetry: { error_kind: kind },
  }
}

function createNativeDispatcher(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  context: ComputerUseSessionContext,
): (
  name: string,
  rawArgs: unknown,
  signal?: AbortSignal,
) => Promise<CuCallToolResult> {
  return async (name, rawArgs, rawSignal) => {
    const signal = rawSignal ?? new AbortController().signal
    try {
      checkAbort(signal)
      if (adapter.isDisabled()) {
        throw Object.assign(new Error('Native Computer Use is disabled'), {
          errorKind: 'backend_unavailable',
        })
      }
      const args = asArgs(rawArgs ?? {})
      const lock = await context.checkCuLock()
      if (lock.holder && !lock.isSelf) {
        throw Object.assign(
          new Error(context.formatLockHeldMessage(lock.holder)),
          { errorKind: 'lock_held' },
        )
      }
      if (!lock.holder) await context.acquireCuLock()
      const permissions = await adapter.ensureOsPermissions()
      if (!permissions.granted) {
        throw Object.assign(
          new Error('macOS Accessibility or Screen Recording permission is missing'),
          {
            errorKind: 'tcc_denied',
            accessibility: permissions.accessibility,
            screenRecording: permissions.screenRecording,
          },
        )
      }
      checkAbort(signal)

      if (name === 'request_access') {
        if (!Array.isArray(args.apps)) {
          throw Object.assign(new Error('apps must be an array'), {
            errorKind: 'invalid_arguments',
          })
        }
        const installed = await adapter.executor.listInstalledApps()
        const requestedFlags = {
          ...context.getGrantFlags(),
          ...(typeof args.flags === 'object' && args.flags !== null
            ? (args.flags as Partial<CuGrantFlags>)
            : {}),
        }
        const requests = args.apps.map(entry => {
          const item = asArgs(entry)
          const requestedName =
            typeof item.bundleId === 'string'
              ? item.bundleId
              : stringArg(item, 'displayName')
          const resolved = installed.find(
            app =>
              app.bundleId === requestedName ||
              app.displayName.toLowerCase() === requestedName.toLowerCase(),
          )
          return {
            requestedName,
            resolved: resolved ?? null,
            alreadyGranted: context
              .getAllowedApps()
              .some(grant => grantMatches(grant, requestedName)),
          }
        })
        const response = await context.onPermissionRequest(
          { apps: requests, requestedFlags },
          signal,
        )
        checkAbort(signal)
        const unresolved = requests.filter(request => !request.resolved)
        if (response.denied.length > 0 || unresolved.length > 0) {
          throw Object.assign(new Error('One or more applications were denied or not installed'), {
            errorKind: 'permission_denied',
          })
        }
        const granted = requests.map(request =>
          response.granted.find(grant =>
            grantMatches(grant, request.resolved!.bundleId),
          ),
        )
        if (granted.some(grant => !grant)) {
          throw Object.assign(new Error('Permission response is missing requested applications'), {
            errorKind: 'permission_denied',
          })
        }
        const flags = {
          clipboardRead:
            context.getGrantFlags().clipboardRead || response.flags.clipboardRead,
          clipboardWrite:
            context.getGrantFlags().clipboardWrite || response.flags.clipboardWrite,
          systemKeyCombos:
            context.getGrantFlags().systemKeyCombos ||
            response.flags.systemKeyCombos,
        }
        context.onAllowedAppsChanged(
          mergeGrants(context.getAllowedApps(), granted as AppGrant[]),
          flags,
        )
        return success({ granted: granted as AppGrant[], flags })
      }

      if (name === 'list_granted_applications') {
        return success({ apps: context.getAllowedApps() })
      }
      if (name === 'list_displays') {
        return success({ displays: await adapter.executor.listDisplays() })
      }
      if (name === 'switch_display') {
        const value = args.display_id
        if (value === 'auto') {
          context.onDisplayPinned(undefined)
          context.onDisplayResolvedForApps(undefined)
          return success({ displayId: null, automatic: true })
        }
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          throw Object.assign(new Error('display_id must be an integer or auto'), {
            errorKind: 'invalid_arguments',
          })
        }
        const display = await adapter.executor.getDisplaySize(value)
        context.onDisplayPinned(display.displayId)
        return success({ displayId: display.displayId, automatic: false })
      }
      if (name === 'list_installed_applications') {
        await ensureGrants(context, args, {}, signal)
        return success({ apps: await adapter.executor.listInstalledApps() })
      }
      if (name === 'list_running_applications') {
        await ensureGrants(context, args, {}, signal)
        return success({ apps: await adapter.executor.listRunningApps() })
      }

      const viaClipboard =
        name === 'type' &&
        stringArg(args, 'text').includes('\n') &&
        adapter.getSubGates().clipboardPasteMultiline
      const needed: Partial<CuGrantFlags> = {}
      if (name === 'read_clipboard') needed.clipboardRead = true
      if (name === 'write_clipboard' || viaClipboard) needed.clipboardWrite = true
      if ((name === 'key' || name === 'hold_key') && isSystemCombo(stringArg(args, 'text'))) {
        needed.systemKeyCombos = true
      }
      const grants = await ensureGrants(context, args, needed, signal)
      const allowedBundleIds = grants.map(grant => grant.bundleId)
      const selectedDisplay = context.getSelectedDisplayId()

      if (name === 'screenshot') {
        const key = [...allowedBundleIds].sort().join(',')
        const automatic =
          adapter.getSubGates().autoTargetDisplay &&
          !context.getDisplayPinnedByModel()
        const result = await adapter.executor.resolvePrepareCapture({
          allowedBundleIds,
          preferredDisplayId: selectedDisplay,
          autoResolve: automatic,
          doHide: adapter.getSubGates().hideBeforeAction,
        })
        checkAbort(signal)
        if (result.displayId !== selectedDisplay) {
          context.onResolvedDisplayUpdated(result.displayId)
        }
        if (automatic) context.onDisplayResolvedForApps(key)
        if (result.hidden) context.onAppsHidden(result.hidden)
        const dims: ScreenshotDims = {
          width: result.width,
          height: result.height,
          displayWidth: result.displayWidth,
          displayHeight: result.displayHeight,
          displayId: result.displayId,
          originX: result.originX,
          originY: result.originY,
        }
        context.onScreenshotCaptured(dims)
        return success(dims, [
          { type: 'image', data: result.base64, mimeType: 'image/jpeg' },
        ])
      }
      if (name === 'zoom') {
        if (!Array.isArray(args.region) || args.region.length !== 4) {
          throw Object.assign(new Error('region must contain four numbers'), {
            errorKind: 'invalid_arguments',
          })
        }
        const values = args.region.map(value => {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw Object.assign(new Error('region values must be finite'), {
              errorKind: 'invalid_arguments',
            })
          }
          return value
        })
        const dims = context.getLastScreenshotDims()
        if (!dims) {
          throw Object.assign(new Error('Take a screenshot before zoom'), {
            errorKind: 'stale_screenshot',
          })
        }
        const start = resolvePoint([values[0], values[1]], coordinateMode, dims)
        const width = coordinateMode === 'normalized' ? values[2]! * dims.displayWidth : values[2]!
        const height = coordinateMode === 'normalized' ? values[3]! * dims.displayHeight : values[3]!
        if (width <= 0 || height <= 0 || start.x + width > dims.originX + dims.displayWidth || start.y + height > dims.originY + dims.displayHeight) {
          throw Object.assign(new Error('Zoom region is outside the captured display'), {
            errorKind: 'invalid_coordinates',
          })
        }
        const result = await adapter.executor.zoom(
          { x: start.x, y: start.y, w: width, h: height },
          allowedBundleIds,
          selectedDisplay ?? dims.displayId,
        )
        return success(
          { width: result.width, height: result.height, displayId: dims.displayId },
          [{ type: 'image', data: result.base64, mimeType: 'image/jpeg' }],
        )
      }
      if (name === 'read_clipboard') {
        return success({ text: await adapter.executor.readClipboard() })
      }
      if (name === 'write_clipboard') {
        const text = typeof args.text === 'string' ? args.text : stringArg(args, 'text')
        await adapter.executor.writeClipboard(text)
        return success({ written: true })
      }
      if (name === 'open_application') {
        await adapter.executor.openApp(stringArg(args, 'bundle_id'))
        return success({ opened: args.bundle_id })
      }
      if (name === 'cursor_position') {
        return success(await adapter.executor.getCursorPosition())
      }
      if (name === 'wait') {
        const duration = numberArg(args, 'duration')
        if (duration < 0 || duration > 30) {
          throw Object.assign(new Error('duration must be between 0 and 30 seconds'), {
            errorKind: 'invalid_arguments',
          })
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, duration * 1000)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(abortError())
          }, { once: true })
        })
        return success({ waited: duration })
      }
      if (name === 'computer_batch') {
        if (!Array.isArray(args.actions)) {
          throw Object.assign(new Error('actions must be an array'), {
            errorKind: 'invalid_arguments',
          })
        }
        const results: CuCallToolResult[] = []
        for (const entry of args.actions) {
          checkAbort(signal)
          const action = asArgs(entry)
          const result = await createNativeDispatcher(adapter, coordinateMode, context)(
            stringArg(action, 'name'),
            action.args,
            signal,
          )
          results.push(result)
          if (result.isError) break
        }
        return { content: JSON.stringify(results), structuredContent: { results } }
      }

      const inputNames = new Set([
        'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click',
        'triple_click', 'left_mouse_down', 'left_mouse_up', 'left_click_drag',
        'scroll', 'type', 'key', 'hold_key',
      ])
      if (!inputNames.has(name)) {
        throw Object.assign(new Error(`Unknown native Computer Use tool: ${name}`), {
          errorKind: 'unknown_tool',
        })
      }
      const requestedGrant = grants.find(grant =>
        typeof args.target_app === 'string'
          ? grantMatches(grant, args.target_app)
          : false,
      )
      const orderedGrants = requestedGrant
        ? [requestedGrant, ...grants.filter(grant => grant !== requestedGrant)]
        : grants
      const pointFor = (value: unknown): { x: number; y: number } => {
        const point = resolvePoint(value, coordinateMode, context.getLastScreenshotDims())
        if (selectedDisplay !== undefined && context.getLastScreenshotDims()?.displayId !== selectedDisplay) {
          throw Object.assign(new Error('Screenshot display is stale; capture again'), {
            errorKind: 'stale_screenshot',
          })
        }
        return point
      }
      const grantedPointFor = async (value: unknown): Promise<{ x: number; y: number }> => {
        const point = pointFor(value)
        const under = await adapter.executor.appUnderPoint(point.x, point.y)
        if (under && !grants.some(grant => grant.bundleId === under.bundleId)) {
          throw Object.assign(new Error(`Application under point is not granted: ${under.bundleId}`), {
            errorKind: 'permission_denied',
          })
        }
        return point
      }
      const coordinatePoint = args.coordinate === undefined
        ? undefined
        : await grantedPointFor(args.coordinate)
      const dragStartPoint = args.start_coordinate === undefined
        ? undefined
        : await grantedPointFor(args.start_coordinate)
      const hidden = await adapter.executor.prepareForAction(
        orderedGrants.map(grant => grant.bundleId),
        selectedDisplay,
      )
      context.onAppsHidden(hidden)
      checkAbort(signal)
      await verifyFrontmost(adapter, orderedGrants, args)

      if (name === 'type') {
        await adapter.executor.type(stringArg(args, 'text', true), { viaClipboard })
      } else if (name === 'key') {
        const repeat = args.repeat === undefined ? 1 : numberArg(args, 'repeat')
        if (!Number.isInteger(repeat) || repeat < 1) {
          throw Object.assign(new Error('repeat must be a positive integer'), {
            errorKind: 'invalid_arguments',
          })
        }
        await adapter.executor.key(stringArg(args, 'text'), repeat)
      } else if (name === 'hold_key') {
        const duration = numberArg(args, 'duration')
        if (duration <= 0 || duration > 10) {
          throw Object.assign(new Error('hold_key duration must be in (0,10]'), {
            errorKind: 'invalid_arguments',
          })
        }
        await adapter.executor.holdKey(stringArg(args, 'text').split('+'), duration * 1000)
      } else if (name === 'left_mouse_down') {
        await adapter.executor.mouseDown()
      } else if (name === 'left_mouse_up') {
        await adapter.executor.mouseUp()
      } else if (name === 'mouse_move') {
        const point = coordinatePoint!
        await adapter.executor.moveMouse(point.x, point.y)
      } else if (name === 'left_click_drag') {
        const to = coordinatePoint!
        const from = dragStartPoint
        await adapter.executor.drag(from, to)
      } else if (name === 'scroll') {
        const point = coordinatePoint!
        const direction = stringArg(args, 'direction')
        const amount = numberArg(args, 'amount')
        const delta: Record<string, [number, number]> = {
          up: [0, amount], down: [0, -amount], left: [-amount, 0], right: [amount, 0],
        }
        const [dx, dy] = delta[direction] ?? (() => {
          throw Object.assign(new Error(`Unknown scroll direction: ${direction}`), {
            errorKind: 'invalid_arguments',
          })
        })()
        await adapter.executor.scroll(point.x, point.y, dx, dy)
      } else {
        const point = coordinatePoint!
        const button = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left'
        const count = name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1
        const modifiers = args.modifiers === undefined
          ? undefined
          : Array.isArray(args.modifiers) && args.modifiers.every(value => typeof value === 'string')
            ? args.modifiers
            : (() => { throw Object.assign(new Error('modifiers must be strings'), { errorKind: 'invalid_arguments' }) })()
        await adapter.executor.click(point.x, point.y, button, count, modifiers)
      }
      checkAbort(signal)
      return success({ action: name, completed: true })
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') throw error
      return failure(error)
    }
  }
}

export function bindSessionContext(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  context: ComputerUseSessionContext,
): (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<CuCallToolResult> {
  return createNativeDispatcher(adapter, coordinateMode, context)
}

export function createNativeComputerUseBackend(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
): ComputerUseBackend {
  return {
    kind: 'native-adapter',
    async listTools() {
      return buildComputerUseTools(adapter.executor.capabilities, coordinateMode)
    },
    dispatch(name, args, context, signal) {
      return createNativeDispatcher(adapter, coordinateMode, context)(name, args, signal)
    },
    async close() {
      resetComputerUseInputLoader()
      resetComputerUseSwiftLoader()
      await closeComputerUseHelper()
    },
  }
}
