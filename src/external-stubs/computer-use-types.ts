export type CoordinateMode = 'pixels' | 'normalized'

export type CuSubGates = {
  pixelValidation: boolean
  clipboardPasteMultiline: boolean
  mouseAnimation: boolean
  hideBeforeAction: boolean
  autoTargetDisplay: boolean
  clipboardGuard: boolean
}

export type CuGrantFlags = {
  clipboardRead: boolean
  clipboardWrite: boolean
  systemKeyCombos: boolean
}

export const DEFAULT_GRANT_FLAGS: Readonly<CuGrantFlags> = Object.freeze({
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
})

export type AppGrant = {
  bundleId: string
  displayName: string
  grantedAt: number
}

export type InstalledApp = {
  bundleId: string
  displayName: string
  path: string
  iconDataUrl?: string
}

export type RunningApp = {
  bundleId: string
  displayName: string
}

export type FrontmostApp = {
  bundleId: string
  displayName: string
}

export type DisplayGeometry = {
  displayId: number
  width: number
  height: number
  scaleFactor: number
  originX: number
  originY: number
}

export type ScreenshotDims = {
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  displayId: number
  originX: number
  originY: number
}

export type ScreenshotResult = ScreenshotDims & {
  base64: string
}

export type ResolvePrepareCaptureResult = ScreenshotResult & {
  hidden?: string[]
  activated?: string
}

export type ComputerUseCapabilities = {
  screenshotFiltering: 'native' | 'none'
  platform: 'darwin' | 'linux' | 'win32'
  hostBundleId?: string
  teachMode?: boolean
}

export type ComputerExecutor = {
  capabilities: ComputerUseCapabilities & { hostBundleId: string }
  prepareForAction(
    allowlistBundleIds: string[],
    displayId?: number,
  ): Promise<string[]>
  previewHideSet(
    allowlistBundleIds: string[],
    displayId?: number,
  ): Promise<Array<{ bundleId: string; displayName: string }>>
  getDisplaySize(displayId?: number): Promise<DisplayGeometry>
  listDisplays(): Promise<DisplayGeometry[]>
  findWindowDisplays(
    bundleIds: string[],
  ): Promise<Array<{ bundleId: string; displayIds: number[] }>>
  resolvePrepareCapture(opts: {
    allowedBundleIds: string[]
    preferredDisplayId?: number
    autoResolve: boolean
    doHide?: boolean
  }): Promise<ResolvePrepareCaptureResult>
  screenshot(opts: {
    allowedBundleIds: string[]
    displayId?: number
  }): Promise<ScreenshotResult>
  zoom(
    regionLogical: { x: number; y: number; w: number; h: number },
    allowedBundleIds: string[],
    displayId?: number,
  ): Promise<{ base64: string; width: number; height: number }>
  key(keySequence: string, repeat?: number): Promise<void>
  holdKey(keyNames: string[], durationMs: number): Promise<void>
  type(text: string, opts: { viaClipboard: boolean }): Promise<void>
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  moveMouse(x: number, y: number): Promise<void>
  click(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle',
    count: 1 | 2 | 3,
    modifiers?: string[],
  ): Promise<void>
  mouseDown(): Promise<void>
  mouseUp(): Promise<void>
  getCursorPosition(): Promise<{ x: number; y: number }>
  drag(
    from: { x: number; y: number } | undefined,
    to: { x: number; y: number },
  ): Promise<void>
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>
  getFrontmostApp(): Promise<FrontmostApp | null>
  appUnderPoint(
    x: number,
    y: number,
  ): Promise<{ bundleId: string; displayName: string } | null>
  listInstalledApps(): Promise<InstalledApp[]>
  getAppIcon(path: string): Promise<string | undefined>
  listRunningApps(): Promise<RunningApp[]>
  openApp(bundleId: string): Promise<void>
}

export type Logger = {
  silly(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export type OsPermissionState =
  | { granted: true }
  | { granted: false; accessibility: boolean; screenRecording: boolean }

export type ComputerUseHostAdapter = {
  serverName: string
  logger: Logger
  executor: ComputerExecutor
  ensureOsPermissions(): Promise<OsPermissionState>
  isDisabled(): boolean
  getSubGates(): CuSubGates
  getAutoUnhideEnabled(): boolean
  cropRawPatch(...args: unknown[]): Buffer | null
}

export type CuPermissionRequest = {
  apps: Array<{
    requestedName: string
    resolved?: InstalledApp | null
    alreadyGranted: boolean
  }>
  requestedFlags: CuGrantFlags
  reason?: string
  willHide?: Array<{ bundleId: string; displayName: string }>
  tccState?: {
    accessibility: boolean
    screenRecording: boolean
  }
}

export type CuPermissionResponse = {
  granted: AppGrant[]
  denied: Array<{
    bundleId: string
    reason: 'user_denied' | 'not_installed'
  }>
  flags: CuGrantFlags
}

export type ComputerUseSessionContext = {
  getAllowedApps(): readonly AppGrant[]
  getGrantFlags(): CuGrantFlags
  getUserDeniedBundleIds(): readonly string[]
  getSelectedDisplayId(): number | undefined
  getDisplayPinnedByModel(): boolean
  getDisplayResolvedForApps(): string | undefined
  getLastScreenshotDims(): ScreenshotDims | undefined
  onPermissionRequest(
    request: CuPermissionRequest,
    dialogSignal: AbortSignal,
  ): Promise<CuPermissionResponse>
  onAllowedAppsChanged(
    apps: readonly AppGrant[],
    flags: CuGrantFlags,
  ): void
  onAppsHidden(bundleIds: readonly string[]): void
  onResolvedDisplayUpdated(displayId: number): void
  onDisplayPinned(displayId: number | undefined): void
  onDisplayResolvedForApps(key: string | undefined): void
  onScreenshotCaptured(dims: ScreenshotDims): void
  checkCuLock(): Promise<{ holder: string | undefined; isSelf: boolean }>
  acquireCuLock(): Promise<void>
  formatLockHeldMessage(holder: string): string
}

export type CuContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType?: string }
  | { type: 'audio'; data: string; mimeType?: string }
  | { type: 'resource'; resource: unknown }
  | { type: 'resource_link'; uri: string; name: string }

export type CuCallToolResult = {
  content: string | CuContentBlock[]
  isError?: boolean
  telemetry?: Record<string, unknown> & { error_kind?: string }
}

export type ComputerUseTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
