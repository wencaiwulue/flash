import type {
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from './computer-use-types.js'
import { privatePackageUnavailable } from './unavailable.js'

export type ComputerUseAPI = {
  display: {
    getSize(displayId?: number): DisplayGeometry
    listAll(): Promise<DisplayGeometry[]>
  }
  screenshot: {
    captureExcluding(
      allowedBundleIds: string[],
      jpegQuality: number,
      targetWidth: number,
      targetHeight: number,
      displayId?: number,
    ): Promise<ScreenshotResult>
    captureRegion(
      allowedBundleIds: string[],
      x: number,
      y: number,
      width: number,
      height: number,
      targetWidth: number,
      targetHeight: number,
      jpegQuality: number,
      displayId?: number,
    ): Promise<{ base64: string; width: number; height: number }>
  }
  apps: {
    prepareDisplay(
      allowlistBundleIds: string[],
      hostBundleId: string,
      displayId?: number,
    ): Promise<{ hidden: string[]; activated?: string }>
    previewHideSet(
      allowlistBundleIds: string[],
      displayId?: number,
    ): Promise<Array<{ bundleId: string; displayName: string }>>
    findWindowDisplays(
      bundleIds: string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>>
    appUnderPoint(x: number, y: number): Promise<FrontmostApp | null>
    listInstalled(): Promise<InstalledApp[]>
    iconDataUrl(path: string): string | null
    listRunning(): Promise<RunningApp[]>
    open(bundleId: string): Promise<void>
    unhide(bundleIds: string[]): Promise<void>
  }
  tcc: {
    checkAccessibility(): boolean
    checkScreenRecording(): boolean
  }
  hotkey: {
    registerEscape(onEscape: () => void): boolean
    unregister(): void
    notifyExpectedEscape(): void
  }
  resolvePrepareCapture(
    allowedBundleIds: string[],
    hostBundleId: string,
    jpegQuality: number,
    targetWidth: number,
    targetHeight: number,
    preferredDisplayId: number | undefined,
    autoResolve: boolean,
    doHide?: boolean,
  ): Promise<ResolvePrepareCaptureResult>
  _drainMainRunLoop(): void
}

function unavailable(): never {
  throw privatePackageUnavailable('@ant/computer-use-swift')
}

export const display: ComputerUseAPI['display'] = {
  getSize: unavailable,
  listAll: unavailable,
}

export const screenshot: ComputerUseAPI['screenshot'] = {
  captureExcluding: unavailable,
  captureRegion: unavailable,
}

export const apps: ComputerUseAPI['apps'] = {
  prepareDisplay: unavailable,
  previewHideSet: unavailable,
  findWindowDisplays: unavailable,
  appUnderPoint: unavailable,
  listInstalled: unavailable,
  iconDataUrl: unavailable,
  listRunning: unavailable,
  open: unavailable,
  unhide: unavailable,
}

export const tcc: ComputerUseAPI['tcc'] = {
  checkAccessibility: unavailable,
  checkScreenRecording: unavailable,
}

export const hotkey: ComputerUseAPI['hotkey'] = {
  registerEscape: unavailable,
  unregister: unavailable,
  notifyExpectedEscape: unavailable,
}

export const resolvePrepareCapture: ComputerUseAPI['resolvePrepareCapture'] =
  unavailable

export const _drainMainRunLoop: ComputerUseAPI['_drainMainRunLoop'] =
  unavailable
