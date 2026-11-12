import {
  getComputerUseHelper,
  type ComputerUseHelper,
} from '../utils/computerUse/nativeHelper.js'
import type {
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from './computer-use-types.js'

export type ComputerUseAPI = {
  display: {
    getSize(displayId?: number): Promise<DisplayGeometry>
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
    iconDataUrl(path: string): Promise<string | null>
    listRunning(): Promise<RunningApp[]>
    open(bundleId: string): Promise<void>
    unhide(bundleIds: string[]): Promise<void>
  }
  tcc: {
    checkAccessibility(): Promise<boolean>
    checkScreenRecording(): Promise<boolean>
  }
  hotkey: {
    registerEscape(onEscape: () => void): Promise<boolean>
    unregister(): Promise<void>
    notifyExpectedEscape(): Promise<void>
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
  _drainMainRunLoop(): Promise<void>
}

/** Public ScreenCaptureKit/NSWorkspace/CGEvent adapter, injectable for tests. */
export function createComputerUseSwift(
  helper: ComputerUseHelper,
): ComputerUseAPI {
  const request = <T>(
    method: string,
    params: Record<string, unknown> = {},
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> => helper.request<T>(method, params, options)
  let removeEscapeListener: (() => void) | undefined
  const clearEscapeListener = (): void => {
    const remove = removeEscapeListener
    removeEscapeListener = undefined
    remove?.()
  }

  return {
    display: {
      getSize: displayId =>
        request<DisplayGeometry>('display.getSize', { displayId }),
      listAll: () => request<DisplayGeometry[]>('display.listAll'),
    },
    screenshot: {
      captureExcluding: (
        allowedBundleIds,
        jpegQuality,
        targetWidth,
        targetHeight,
        displayId,
      ) =>
        request<ScreenshotResult>('screenshot.captureExcluding', {
          allowedBundleIds,
          jpegQuality,
          targetWidth,
          targetHeight,
          displayId,
        }),
      captureRegion: (
        allowedBundleIds,
        x,
        y,
        width,
        height,
        targetWidth,
        targetHeight,
        jpegQuality,
        displayId,
      ) =>
        request('screenshot.captureRegion', {
          allowedBundleIds,
          x,
          y,
          width,
          height,
          targetWidth,
          targetHeight,
          jpegQuality,
          displayId,
        }),
    },
    apps: {
      prepareDisplay: (allowlistBundleIds, hostBundleId, displayId) =>
        request<{ hidden: string[]; activated?: string }>(
          'apps.prepareDisplay',
          { allowlistBundleIds, hostBundleId, displayId },
        ),
      previewHideSet: (allowlistBundleIds, displayId) =>
        request('apps.previewHideSet', { allowlistBundleIds, displayId }),
      findWindowDisplays: bundleIds =>
        request('apps.findWindowDisplays', { bundleIds }),
      appUnderPoint: (x, y) =>
        request<FrontmostApp | null>('apps.appUnderPoint', { x, y }),
      listInstalled: () => request<InstalledApp[]>('apps.listInstalled'),
      iconDataUrl: path =>
        request<string | null>('apps.iconDataUrl', { path }),
      listRunning: () => request<RunningApp[]>('apps.listRunning'),
      open: async bundleId => {
        await request('apps.open', { bundleId })
      },
      unhide: async bundleIds => {
        await request('apps.unhide', { bundleIds })
      },
    },
    tcc: {
      checkAccessibility: async () =>
        (await request<{ granted: boolean }>('tcc.checkAccessibility')).granted,
      checkScreenRecording: async () =>
        (await request<{ granted: boolean }>('tcc.checkScreenRecording'))
          .granted,
    },
    hotkey: {
      async registerEscape(onEscape) {
        clearEscapeListener()
        removeEscapeListener = helper.onEvent('escape', onEscape)
        try {
          const result = await request<{ registered: boolean }>(
            'hotkey.registerEscape',
          )
          if (!result.registered) {
            clearEscapeListener()
          }
          return result.registered
        } catch (error) {
          removeEscapeListener()
          removeEscapeListener = undefined
          throw error
        }
      },
      async unregister() {
        clearEscapeListener()
        await request('hotkey.unregister')
      },
      async notifyExpectedEscape() {
        await request('hotkey.notifyExpectedEscape')
      },
    },
    resolvePrepareCapture: (
      allowedBundleIds,
      hostBundleId,
      jpegQuality,
      targetWidth,
      targetHeight,
      preferredDisplayId,
      autoResolve,
      doHide,
    ) =>
      request<ResolvePrepareCaptureResult>('resolvePrepareCapture', {
        allowedBundleIds,
        hostBundleId,
        jpegQuality,
        targetWidth,
        targetHeight,
        preferredDisplayId,
        autoResolve,
        doHide,
      }),
    _drainMainRunLoop: async () => {
      await request('drainMainRunLoop', {}, { timeoutMs: 1_000 })
    },
  }
}

let cached: ComputerUseAPI | undefined
export function resetComputerUseSwiftAdapter(): void {
  cached = undefined
}

function defaultSwift(): ComputerUseAPI {
  return (cached ??= createComputerUseSwift(getComputerUseHelper()))
}

export const display: ComputerUseAPI['display'] = {
  getSize: displayId => defaultSwift().display.getSize(displayId),
  listAll: () => defaultSwift().display.listAll(),
}
export const screenshot: ComputerUseAPI['screenshot'] = {
  captureExcluding: (...args) =>
    defaultSwift().screenshot.captureExcluding(...args),
  captureRegion: (...args) => defaultSwift().screenshot.captureRegion(...args),
}
export const apps: ComputerUseAPI['apps'] = {
  prepareDisplay: (...args) => defaultSwift().apps.prepareDisplay(...args),
  previewHideSet: (...args) => defaultSwift().apps.previewHideSet(...args),
  findWindowDisplays: (...args) => defaultSwift().apps.findWindowDisplays(...args),
  appUnderPoint: (...args) => defaultSwift().apps.appUnderPoint(...args),
  listInstalled: () => defaultSwift().apps.listInstalled(),
  iconDataUrl: (...args) => defaultSwift().apps.iconDataUrl(...args),
  listRunning: () => defaultSwift().apps.listRunning(),
  open: (...args) => defaultSwift().apps.open(...args),
  unhide: (...args) => defaultSwift().apps.unhide(...args),
}
export const tcc: ComputerUseAPI['tcc'] = {
  checkAccessibility: () => defaultSwift().tcc.checkAccessibility(),
  checkScreenRecording: () => defaultSwift().tcc.checkScreenRecording(),
}
export const hotkey: ComputerUseAPI['hotkey'] = {
  registerEscape: (...args) => defaultSwift().hotkey.registerEscape(...args),
  unregister: () => defaultSwift().hotkey.unregister(),
  notifyExpectedEscape: () => defaultSwift().hotkey.notifyExpectedEscape(),
}
export const resolvePrepareCapture: ComputerUseAPI['resolvePrepareCapture'] = (
  ...args
) => defaultSwift().resolvePrepareCapture(...args)
export const _drainMainRunLoop: ComputerUseAPI['_drainMainRunLoop'] = () =>
  defaultSwift()._drainMainRunLoop()
