import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  buildComputerUseTools,
  closeOpenComputerUseClient,
  createNativeComputerUseBackend,
  createZavoraComputerUseBackend,
  targetImageSize,
  type ComputerUseHostAdapter,
  type ComputerUseSessionContext,
  type CuGrantFlags,
  type ScreenshotDims,
} from '../src/external-stubs/computer-use-mcp.ts'
import {
  DEFAULT_GRANT_FLAGS,
  type AppGrant,
} from '../src/external-stubs/computer-use-types.ts'
import {
  getSentinelCategory,
  SENTINEL_APPS,
} from '../src/external-stubs/computer-use-sentinel-apps.ts'

const appA: AppGrant = {
  bundleId: 'example.A',
  displayName: 'A',
  grantedAt: 1,
}
const appB: AppGrant = {
  bundleId: 'example.B',
  displayName: 'B',
  grantedAt: 2,
}
const dims: ScreenshotDims = {
  width: 500,
  height: 400,
  displayWidth: 1000,
  displayHeight: 800,
  displayId: 7,
  originX: -100,
  originY: 50,
}

function makeContext(initialGrants: AppGrant[] = [appA]) {
  let grants = [...initialGrants]
  let flags: CuGrantFlags = { ...DEFAULT_GRANT_FLAGS }
  let lastDims: ScreenshotDims | undefined = dims
  const permission = mock(async () => ({
    granted: grants,
    denied: [],
    flags: {
      clipboardRead: true,
      clipboardWrite: true,
      systemKeyCombos: true,
    },
  }))
  const screenshot = mock(() => {})
  const context: ComputerUseSessionContext = {
    getAllowedApps: () => grants,
    getGrantFlags: () => flags,
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => 7,
    getDisplayPinnedByModel: () => true,
    getDisplayResolvedForApps: () => undefined,
    getLastScreenshotDims: () => lastDims,
    onPermissionRequest: permission,
    onAllowedAppsChanged: (next, nextFlags) => {
      grants = [...next]
      flags = nextFlags
    },
    onAppsHidden: () => {},
    onResolvedDisplayUpdated: () => {},
    onDisplayPinned: () => {},
    onDisplayResolvedForApps: () => {},
    onScreenshotCaptured: screenshot,
    checkCuLock: async () => ({ holder: 'self', isSelf: true }),
    acquireCuLock: async () => {},
    formatLockHeldMessage: holder => `held:${holder}`,
  }
  return { context, permission, screenshot }
}

function makeAdapter() {
  const executor: ComputerUseHostAdapter['executor'] = {
    capabilities: {
      screenshotFiltering: 'native',
      platform: 'darwin',
      hostBundleId: 'example.Host',
    },
    prepareForAction: mock(async () => []),
    previewHideSet: mock(async () => []),
    getDisplaySize: mock(async () => ({
      displayId: 7,
      width: 1000,
      height: 800,
      scaleFactor: 2,
      originX: -100,
      originY: 50,
    })),
    listDisplays: mock(async () => [
      {
        displayId: 7,
        width: 1000,
        height: 800,
        scaleFactor: 2,
        originX: -100,
        originY: 50,
      },
    ]),
    findWindowDisplays: mock(async () => []),
    resolvePrepareCapture: mock(async () => ({
      base64: 'real-jpeg',
      ...dims,
      hidden: ['example.Hidden'],
    })),
    screenshot: mock(async () => ({ base64: 'real-jpeg', ...dims })),
    zoom: mock(async () => ({ base64: 'region', width: 10, height: 10 })),
    key: mock(async () => {}),
    holdKey: mock(async () => {}),
    type: mock(async () => {}),
    readClipboard: mock(async () => 'clipboard'),
    writeClipboard: mock(async () => {}),
    moveMouse: mock(async () => {}),
    click: mock(async () => {}),
    mouseDown: mock(async () => {}),
    mouseUp: mock(async () => {}),
    getCursorPosition: mock(async () => ({ x: 1, y: 2 })),
    drag: mock(async () => {}),
    scroll: mock(async () => {}),
    getFrontmostApp: mock(async () => ({
      bundleId: appA.bundleId,
      displayName: appA.displayName,
    })),
    appUnderPoint: mock(async () => ({
      bundleId: appA.bundleId,
      displayName: appA.displayName,
    })),
    listInstalledApps: mock(async () => []),
    getAppIcon: mock(async () => undefined),
    listRunningApps: mock(async () => []),
    openApp: mock(async () => {}),
  }
  const adapter: ComputerUseHostAdapter = {
    serverName: 'native-test',
    logger: {
      silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    },
    executor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: true,
      mouseAnimation: false,
      hideBeforeAction: true,
      autoTargetDisplay: true,
      clipboardGuard: true,
    }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
  return { adapter, executor }
}

const backends: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(backends.splice(0).map(backend => backend.close()))
  await closeOpenComputerUseClient()
})

describe('explicit native and Zavora backends', () => {
  test('native factory consumes its adapter and strict catalog without Zavora', async () => {
    const { adapter, executor } = makeAdapter()
    const backend = createNativeComputerUseBackend(adapter, 'normalized')
    backends.push(backend)
    expect(backend.kind).toBe('native-adapter')
    const tools = await backend.listTools()
    expect(tools.length).toBeGreaterThan(15)
    expect(tools.every(tool => tool.inputSchema.additionalProperties === false)).toBe(true)
    expect(tools.find(tool => tool.name === 'left_click')?.description).toContain('normalized')
    const { context } = makeContext()
    const result = await backend.dispatch('list_displays', {}, context, new AbortController().signal)
    expect(result.isError).toBeUndefined()
    expect(executor.listDisplays).toHaveBeenCalledTimes(1)
    expect(executor.click).not.toHaveBeenCalled()
  })

  test('native normalized and pixel coordinates preserve display origins', async () => {
    const { adapter, executor } = makeAdapter()
    const { context } = makeContext()
    const normalized = createNativeComputerUseBackend(adapter, 'normalized')
    backends.push(normalized)
    await normalized.dispatch(
      'left_click',
      { coordinate: [0.5, 0.25], target_app: appA.bundleId },
      context,
      new AbortController().signal,
    )
    expect(executor.click).toHaveBeenLastCalledWith(400, 250, 'left', 1, undefined)

    const pixels = createNativeComputerUseBackend(adapter, 'pixels')
    backends.push(pixels)
    await pixels.dispatch(
      'left_click',
      { coordinate: [-100, 850], target_app: appA.bundleId },
      context,
      new AbortController().signal,
    )
    expect(executor.click).toHaveBeenLastCalledWith(-100, 850, 'left', 1, undefined)

    for (const coordinate of [[Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [1.1, 0.5]]) {
      const result = await normalized.dispatch(
        'left_click',
        { coordinate, target_app: appA.bundleId },
        context,
        new AbortController().signal,
      )
      expect(result.isError).toBe(true)
      expect(result.structuredContent?.error).toMatch(/invalid|stale/)
    }
    expect(executor.click).toHaveBeenCalledTimes(2)
  })

  test('native TCC preflight fails closed for every missing permission combination', async () => {
    for (const [accessibility, screenRecording] of [[false, false], [false, true], [true, false]]) {
      const { adapter, executor } = makeAdapter()
      adapter.ensureOsPermissions = async () => ({
        granted: false,
        accessibility,
        screenRecording,
      })
      const backend = createNativeComputerUseBackend(adapter, 'pixels')
      backends.push(backend)
      const result = await backend.dispatch('list_displays', {}, makeContext().context, new AbortController().signal)
      expect(result.isError).toBe(true)
      expect(result.structuredContent?.error).toBe('tcc_denied')
      expect(executor.listDisplays).not.toHaveBeenCalled()
    }
  })

  test('native target grant is exact and denial happens before input', async () => {
    const { adapter, executor } = makeAdapter()
    const { context, permission } = makeContext([appA])
    permission.mockImplementation(async () => ({
      granted: [appA],
      denied: [{ bundleId: appB.bundleId, reason: 'user_denied' }],
      flags: { ...DEFAULT_GRANT_FLAGS },
    }))
    const backend = createNativeComputerUseBackend(adapter, 'pixels')
    backends.push(backend)
    const result = await backend.dispatch(
      'left_click',
      { coordinate: [0, 100], target_app: appB.bundleId },
      context,
      new AbortController().signal,
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.error).toBe('permission_denied')
    expect(executor.prepareForAction).not.toHaveBeenCalled()
    expect(executor.click).not.toHaveBeenCalled()
  })

  test('native rejects an ungranted app under the pointer before prepare or input', async () => {
    const { adapter, executor } = makeAdapter()
    executor.appUnderPoint.mockImplementation(async () => ({
      bundleId: appB.bundleId,
      displayName: appB.displayName,
    }))
    const backend = createNativeComputerUseBackend(adapter, 'pixels')
    backends.push(backend)
    const result = await backend.dispatch('left_click', { coordinate: [0, 100], target_app: appA.bundleId }, makeContext().context, new AbortController().signal)
    expect(result.structuredContent?.error).toBe('permission_denied')
    expect(executor.prepareForAction).not.toHaveBeenCalled()
    expect(executor.click).not.toHaveBeenCalled()
  })

  test('native clipboard and system-combo gates are independent', async () => {
    const { adapter, executor } = makeAdapter()
    const { context } = makeContext()
    const backend = createNativeComputerUseBackend(adapter, 'pixels')
    backends.push(backend)
    expect((await backend.dispatch('read_clipboard', {}, context, new AbortController().signal)).structuredContent?.text).toBe('clipboard')
    expect(executor.readClipboard).toHaveBeenCalledTimes(1)
    await backend.dispatch('write_clipboard', { text: 'new' }, context, new AbortController().signal)
    expect(executor.writeClipboard).toHaveBeenCalledWith('new')
    await backend.dispatch('key', { text: 'command+shift+a', target_app: appA.bundleId }, context, new AbortController().signal)
    expect(executor.key).toHaveBeenCalledWith('command+shift+a', 1)
    await backend.dispatch('key', { text: 'a', target_app: appA.bundleId }, context, new AbortController().signal)
    expect(executor.key).toHaveBeenLastCalledWith('a', 1)
  })

  test('native screenshot returns real image blocks and records display metadata', async () => {
    const { adapter, executor } = makeAdapter()
    const { context, screenshot } = makeContext()
    const backend = createNativeComputerUseBackend(adapter, 'pixels')
    backends.push(backend)
    const result = await backend.dispatch('screenshot', {}, context, new AbortController().signal)
    expect(result.content).toEqual([
      { type: 'image', data: 'real-jpeg', mimeType: 'image/jpeg' },
    ])
    expect(result.structuredContent).toEqual(dims)
    expect(screenshot).toHaveBeenCalledWith(dims)
    expect(executor.resolvePrepareCapture).toHaveBeenCalledTimes(1)
  })

  test('native exceptions stay structured tool errors and abort stays abort', async () => {
    const { adapter, executor } = makeAdapter()
    executor.click.mockImplementation(async () => {
      throw new Error('synthetic input failure')
    })
    const { context } = makeContext()
    const backend = createNativeComputerUseBackend(adapter, 'pixels')
    backends.push(backend)
    const result = await backend.dispatch('left_click', { coordinate: [0, 100] }, context, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: 'native_action_failed' })
    const controller = new AbortController()
    controller.abort()
    await expect(backend.dispatch('left_click', { coordinate: [0, 100] }, context, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('Zavora factory enumerates its own schemas and preserves structured errors', async () => {
    const backend = createZavoraComputerUseBackend()
    backends.push(backend)
    expect(backend.kind).toBe('zavora')
    const tools = await backend.listTools()
    expect(tools.some(tool => tool.name === 'run_script')).toBe(false)
    expect(tools.find(tool => tool.name === 'click')?.inputSchema.additionalProperties).not.toBe(true)
    const { context } = makeContext()
    const result = await backend.dispatch('click', { target_app: appA.bundleId }, context, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeDefined()
  }, 30_000)

  test('Zavora exact target denial happens before backend execution', async () => {
    const backend = createZavoraComputerUseBackend()
    backends.push(backend)
    const { context, permission } = makeContext([appA])
    permission.mockImplementation(async () => ({
      granted: [appA],
      denied: [{ bundleId: appB.bundleId, reason: 'user_denied' }],
      flags: { ...DEFAULT_GRANT_FLAGS },
    }))
    const result = await backend.dispatch('click', { coordinate: [1, 1], target_app: appB.bundleId }, context, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.error).toBe('permission_denied')
    expect(JSON.stringify(result.content)).toContain('permission denied')
  }, 30_000)
})

describe('native helpers and sentinel data', () => {
  test('targetImageSize validates inputs and obeys all three limits', () => {
    const params = { maxWidth: 1568, maxHeight: 1568, maxPixels: 1_150_000 }
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => targetImageSize(value, 100, params)).toThrow(RangeError)
      expect(() => targetImageSize(100, value, params)).toThrow(RangeError)
    }
    for (const [width, height] of [[4000, 100], [100, 4000], [2000, 2000], [1, 1]]) {
      const [w, h] = targetImageSize(width, height, params)
      expect(w).toBeLessThanOrEqual(params.maxWidth)
      expect(h).toBeLessThanOrEqual(params.maxHeight)
      expect(w * h).toBeLessThanOrEqual(params.maxPixels)
      expect(w).toBeGreaterThan(0)
      expect(h).toBeGreaterThan(0)
    }
  })

  test('sentinel catalog is public, typed and unknown/case variants fail closed', () => {
    expect(Object.isFrozen(SENTINEL_APPS)).toBe(true)
    expect(getSentinelCategory('com.apple.Terminal')).toBe('shell')
    expect(getSentinelCategory('com.apple.finder')).toBe('filesystem')
    expect(getSentinelCategory('com.apple.systempreferences')).toBe('system_settings')
    expect(getSentinelCategory('example.Unknown')).toBeNull()
    expect(getSentinelCategory('COM.APPLE.TERMINAL')).toBeNull()
  })

  test('native tool builder has no legacy catch-all schemas', () => {
    const tools = buildComputerUseTools(
      { screenshotFiltering: 'native', platform: 'darwin' },
      'pixels',
    )
    expect(tools.every(tool => tool.inputSchema.additionalProperties === false)).toBe(true)
    expect(tools.some(tool => tool.name === 'run_script')).toBe(false)
  })
})
