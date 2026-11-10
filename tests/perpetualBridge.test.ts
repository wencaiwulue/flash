import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { BridgePointer } from '../src/bridge/bridgePointer.ts'
import type { PollIntervalConfig } from '../src/bridge/pollConfigDefaults.ts'
import type {
  BridgeCoreHandle,
  BridgeCoreParams,
  ReplBridgeHandle,
} from '../src/bridge/replBridge.ts'
import type { ReplBridgeTransport } from '../src/bridge/replBridgeTransport.ts'
import type { BridgeConfig } from '../src/bridge/types.ts'

const DIR = '/virtual/perpetual-bridge-test'
const PRIOR_POINTER: BridgePointer & { ageMs: number } = {
  sessionId: 'session-prior',
  environmentId: 'env-prior',
  source: 'repl',
  ageMs: 1,
}
const POLL_CONFIG: PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: 0,
  poll_interval_ms_at_capacity: 0,
  non_exclusive_heartbeat_interval_ms: 0,
  multisession_poll_interval_ms_not_at_capacity: 0,
  multisession_poll_interval_ms_partial_capacity: 0,
  multisession_poll_interval_ms_at_capacity: 0,
  reclaim_older_than_ms: 0,
  session_keepalive_interval_v2_ms: 0,
}

let storedPointer: (BridgePointer & { ageMs: number }) | null = null
const readBridgePointer = mock(async (_dir: string) => storedPointer)
const writeBridgePointer = mock(
  async (_dir: string, pointer: BridgePointer) => {
    storedPointer = { ...pointer, ageMs: 0 }
  },
)
const clearBridgePointer = mock(async (_dir: string) => {
  storedPointer = null
})

mock.module('../src/bridge/bridgePointer.ts', () => ({
  readBridgePointer,
  writeBridgePointer,
  clearBridgePointer,
}))

const registerBridgeEnvironment = mock(async (config: BridgeConfig) => ({
  environment_id: config.reuseEnvironmentId ?? 'env-fresh',
  environment_secret: 'environment-secret',
}))
const reconnectSession = mock(
  async (_environmentId: string, _sessionId: string) => {},
)
const stopWork = mock(
  async (_environmentId: string, _workId: string, _force: boolean) => {},
)
const acknowledgeWork = mock(
  async (_environmentId: string, _workId: string, _token: string) => {},
)
const heartbeatWork = mock(
  async (_environmentId: string, _workId: string, _token: string) => {},
)
const deregisterEnvironment = mock(async (_environmentId: string) => {})

function waitForPollAbort(signal: AbortSignal): Promise<null> {
  return new Promise((_, reject) => {
    const abort = () => reject(new Error('test poll aborted'))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

const pollForWork = mock(
  async (
    _environmentId: string,
    _environmentSecret: string,
    signal: AbortSignal,
    _reclaimOlderThanMs: number,
  ) => waitForPollAbort(signal),
)

const api = {
  registerBridgeEnvironment,
  reconnectSession,
  pollForWork,
  stopWork,
  acknowledgeWork,
  heartbeatWork,
  deregisterEnvironment,
}

mock.module('../src/bridge/bridgeApi.ts', () => ({
  createBridgeApiClient: () => api,
  validateBridgeId: () => {},
  isExpiredErrorType: () => false,
  isSuppressible403: () => false,
  BridgeFatalError: class BridgeFatalError extends Error {
    status = 0
    errorType?: string
  },
}))

let transportOnConnect: (() => void) | undefined
const transportWrite = mock(async (_message: unknown) => {})
const transportWriteBatch = mock(async (_messages: unknown[]) => {})
const transportClose = mock(() => {})
const transportConnect = mock(() => transportOnConnect?.())
const transport: ReplBridgeTransport = {
  write: transportWrite,
  writeBatch: transportWriteBatch,
  close: transportClose,
  isConnectedStatus: () => true,
  getStateLabel: () => 'connected',
  setOnData: () => {},
  setOnClose: () => {},
  setOnConnect: callback => {
    transportOnConnect = callback
  },
  connect: transportConnect,
  getLastSequenceNum: () => 0,
  droppedBatchCount: 0,
  reportState: () => {},
  reportMetadata: () => {},
  reportDelivery: () => {},
  flush: async () => {},
}

mock.module('../src/bridge/replBridgeTransport.ts', () => ({
  createV1ReplTransport: () => transport,
  createV2ReplTransport: async () => transport,
}))
mock.module('../src/cli/transports/HybridTransport.ts', () => ({
  HybridTransport: class HybridTransport {},
}))
mock.module('../src/bridge/workSecret.ts', () => ({
  decodeWorkSecret: () => ({
    session_ingress_token: 'ingress-token',
    use_code_sessions: false,
  }),
  buildSdkUrl: () => 'wss://bridge.invalid/session',
  buildCCRv2SdkUrl: () => 'https://bridge.invalid/session',
  sameSessionId: (a: string, b: string) => a === b,
}))
mock.module('../src/bridge/bridgeMessaging.ts', () => ({
  handleIngressMessage: () => {},
  handleServerControlRequest: () => {},
  makeResultMessage: (sessionId: string) => ({
    type: 'result',
    session_id: sessionId,
  }),
  isEligibleBridgeMessage: () => true,
  extractTitleText: () => undefined,
  BoundedUUIDSet: class BoundedUUIDSet {
    private readonly values = new Set<string>()
    add(value: string) {
      this.values.add(value)
    }
    has(value: string) {
      return this.values.has(value)
    }
    clear() {
      this.values.clear()
    }
  },
}))
mock.module('../src/bridge/sessionIdCompat.ts', () => ({
  setCseShimGate: () => {},
  toCompatSessionId: (sessionId: string) => sessionId,
  toInfraSessionId: (sessionId: string) => sessionId,
}))
mock.module('../src/utils/concurrentSessions.ts', () => ({
  updateSessionBridgeId: async () => {},
}))
mock.module('../src/bridge/trustedDevice.ts', () => ({
  getTrustedDeviceToken: () => undefined,
}))
mock.module('../src/utils/sessionIngressAuth.ts', () => ({
  updateSessionIngressAuthToken: () => {},
}))
mock.module('../src/utils/envUtils.ts', () => ({
  isEnvTruthy: () => false,
  isInProtectedNamespace: () => false,
}))
mock.module('../src/bridge/bridgeDebug.ts', () => ({
  wrapApiForFaultInjection: (value: unknown) => value,
  registerBridgeDebugHandle: () => {},
  clearBridgeDebugHandle: () => {},
  injectBridgeFault: () => {},
}))
mock.module('../src/utils/cleanupRegistry.ts', () => ({
  registerCleanup: () => () => {},
}))
mock.module('../src/utils/debug.ts', () => ({
  logForDebugging: () => {},
}))
mock.module('../src/utils/diagLogs.ts', () => ({
  logForDiagnosticsNoPII: () => {},
}))
mock.module('../src/services/analytics/index.ts', () => ({
  logEvent: () => {},
}))
mock.module('../src/bridge/debugUtils.ts', () => ({
  describeAxiosError: (error: unknown) => String(error),
  extractHttpStatus: () => undefined,
  logBridgeSkip: () => {},
}))
mock.module('../src/utils/errors.ts', () => ({
  errorMessage: (error: unknown) => String(error),
}))

const envLessHandle: ReplBridgeHandle = {
  bridgeSessionId: 'session-env-less',
  environmentId: 'env-less',
  sessionIngressUrl: 'https://bridge.invalid',
  writeMessages: () => {},
  writeSdkMessages: () => {},
  sendControlRequest: () => {},
  sendControlResponse: () => {},
  sendControlCancelRequest: () => {},
  sendResult: () => {},
  teardown: async () => {},
}
const initEnvLessBridgeCore = mock(async (_options: unknown) => envLessHandle)
mock.module('../src/bridge/remoteBridgeCore.ts', () => ({
  initEnvLessBridgeCore,
}))

const isBridgeEnabledBlocking = mock(async () => true)
const isEnvLessBridgeEnabled = mock(() => true)
mock.module('../src/bridge/bridgeEnabled.ts', () => ({
  isBridgeEnabledBlocking,
  isEnvLessBridgeEnabled,
  isCseShimEnabled: () => true,
  checkBridgeMinVersion: () => null,
}))
mock.module('../src/bridge/envLessBridgeConfig.ts', () => ({
  checkEnvLessBridgeMinVersion: async () => null,
}))
mock.module('../src/bridge/bridgeConfig.ts', () => ({
  getBridgeAccessToken: () => 'oauth-token',
  getBridgeBaseUrl: () => 'https://bridge.invalid',
  getBridgeTokenOverride: () => 'oauth-token',
}))
mock.module('../src/services/policyLimits/index.ts', () => ({
  isPolicyAllowed: () => true,
  waitForPolicyLimitsToLoad: async () => {},
}))
mock.module('../src/services/oauth/client.ts', () => ({
  getOrganizationUUID: async () => 'org-id',
}))
mock.module('../src/utils/auth.ts', () => ({
  checkAndRefreshOAuthTokenIfNeeded: async () => {},
  getClaudeAIOAuthTokens: () => ({ expiresAt: null }),
  handleOAuth401Error: async () => false,
}))
mock.module('../src/utils/config.ts', () => ({
  getGlobalConfig: () => ({}),
  saveGlobalConfig: () => {},
}))
mock.module('../src/bootstrap/state.ts', () => ({
  getOriginalCwd: () => DIR,
  getSessionId: () => 'local-session-id',
}))
mock.module('../src/services/analytics/growthbook.ts', () => ({
  getFeatureValue_CACHED_WITH_REFRESH: (
    _name: string,
    defaultValue: number,
  ) => defaultValue,
}))
mock.module('../src/utils/git.ts', () => ({
  getBranch: async () => 'main',
  getRemoteUrl: async () => 'https://git.invalid/repo',
}))
mock.module('../src/utils/sessionStorage.ts', () => ({
  getCurrentSessionTitle: () => undefined,
}))
mock.module('../src/utils/sessionTitle.ts', () => ({
  extractConversationText: () => '',
  generateSessionTitle: async () => undefined,
}))
mock.module('../src/utils/words.ts', () => ({
  generateShortWordSlug: () => 'test-slug',
}))
mock.module('../src/utils/displayTags.ts', () => ({
  stripDisplayTagsAllowEmpty: (value: string) => value,
}))
mock.module('../src/utils/messages/mappers.ts', () => ({
  toSDKMessages: () => [],
}))
mock.module('../src/utils/messages.ts', () => ({
  getContentText: () => '',
  getMessagesAfterCompactBoundary: (messages: unknown) => messages,
  isSyntheticMessage: () => false,
}))
mock.module('../src/bridge/pollConfig.ts', () => ({
  getPollIntervalConfig: () => POLL_CONFIG,
}))
const createBridgeSession = mock(async (_options: unknown) => 'session-wrapper')
const archiveBridgeSession = mock(async (_sessionId: string) => {})
mock.module('../src/bridge/createSession.ts', () => ({
  createBridgeSession,
  archiveBridgeSession,
  updateBridgeSessionTitle: async () => {},
}))
mock.module('bun:bundle', () => ({ feature: () => false }))

let initBridgeCore: typeof import('../src/bridge/replBridge.ts').initBridgeCore
let initReplBridge: typeof import('../src/bridge/initReplBridge.ts').initReplBridge
const activeHandles: Array<Pick<ReplBridgeHandle, 'teardown'>> = []

beforeAll(async () => {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: '1.0.0',
      BUILD_TIME: '',
      PACKAGE_URL: '',
      NATIVE_PACKAGE_URL: '',
      VERSION_CHANGELOG: '',
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
    },
  })
  ;({ initBridgeCore } = await import('../src/bridge/replBridge.ts'))
  ;({ initReplBridge } = await import('../src/bridge/initReplBridge.ts'))
})

beforeEach(() => {
  mock.clearAllMocks()
  storedPointer = null
  transportOnConnect = undefined
  registerBridgeEnvironment.mockImplementation(async config => ({
    environment_id: config.reuseEnvironmentId ?? 'env-fresh',
    environment_secret: 'environment-secret',
  }))
  reconnectSession.mockResolvedValue(undefined)
  pollForWork.mockImplementation(
    async (_environmentId, _environmentSecret, signal) =>
      waitForPollAbort(signal),
  )
  isEnvLessBridgeEnabled.mockReturnValue(true)
})

afterEach(async () => {
  for (const handle of activeHandles.splice(0).reverse()) {
    await handle.teardown()
  }
})

function track<T extends Pick<ReplBridgeHandle, 'teardown'>>(handle: T): T {
  activeHandles.push(handle)
  return handle
}

function coreParams(
  createSession: BridgeCoreParams['createSession'],
  archiveSession: BridgeCoreParams['archiveSession'],
): BridgeCoreParams {
  return {
    dir: DIR,
    machineName: 'test-machine',
    branch: 'main',
    gitRepoUrl: null,
    title: 'perpetual-test',
    baseUrl: 'https://bridge.invalid',
    sessionIngressUrl: 'https://bridge.invalid',
    workerType: 'claude_code',
    getAccessToken: () => 'oauth-token',
    createSession,
    archiveSession,
    getPollIntervalConfig: () => POLL_CONFIG,
    perpetual: true,
  }
}

async function requireCoreHandle(
  params: BridgeCoreParams,
): Promise<BridgeCoreHandle> {
  const handle = await initBridgeCore(params)
  expect(handle).not.toBeNull()
  return track(handle!)
}

async function waitForTransport(): Promise<void> {
  for (let i = 0; i < 50 && transportConnect.mock.calls.length === 0; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(transportConnect).toHaveBeenCalledTimes(1)
}

describe('perpetual bridge path selection', () => {
  test('env-less gate plus perpetual selects env-less with persistent continuity', async () => {
    const handle = await initReplBridge({
      initialName: 'perpetual-test',
      perpetual: true,
    })

    expect(handle).toBe(envLessHandle)
    track(handle!)
    expect(initEnvLessBridgeCore).toHaveBeenCalledTimes(1)
    expect(registerBridgeEnvironment).not.toHaveBeenCalled()
    expect(createBridgeSession).not.toHaveBeenCalled()
  })

  test('env-less gate without perpetual selects env-less', async () => {
    const handle = await initReplBridge({
      initialName: 'non-perpetual-test',
      perpetual: false,
    })

    expect(handle).toBe(envLessHandle)
    track(handle!)
    expect(initEnvLessBridgeCore).toHaveBeenCalledTimes(1)
    expect(registerBridgeEnvironment).not.toHaveBeenCalled()
    expect(createBridgeSession).not.toHaveBeenCalled()
  })
})

describe('perpetual bridge pointer lifecycle', () => {
  test('reuses a valid pointer environment and session', async () => {
    storedPointer = PRIOR_POINTER
    const createSession = mock(async () => 'session-new')
    const archiveSession = mock(async () => {})

    const handle = await requireCoreHandle(
      coreParams(createSession, archiveSession),
    )

    expect(registerBridgeEnvironment.mock.calls[0]?.[0].reuseEnvironmentId).toBe(
      PRIOR_POINTER.environmentId,
    )
    expect(reconnectSession).toHaveBeenCalledWith(
      PRIOR_POINTER.environmentId,
      PRIOR_POINTER.sessionId,
    )
    expect(createSession).not.toHaveBeenCalled()
    expect(handle.environmentId).toBe(PRIOR_POINTER.environmentId)
    expect(handle.bridgeSessionId).toBe(PRIOR_POINTER.sessionId)
    expect(storedPointer).toMatchObject({
      sessionId: PRIOR_POINTER.sessionId,
      environmentId: PRIOR_POINTER.environmentId,
      source: 'repl',
    })
  })

  test('clears an invalid pointer and creates a fresh session', async () => {
    storedPointer = PRIOR_POINTER
    reconnectSession.mockRejectedValue(new Error('stale pointer'))
    const createSession = mock(async () => 'session-new')
    const archiveSession = mock(async () => {})

    const handle = await requireCoreHandle(
      coreParams(createSession, archiveSession),
    )

    expect(clearBridgePointer).toHaveBeenCalledWith(DIR)
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(handle.bridgeSessionId).toBe('session-new')
    expect(storedPointer).toMatchObject({
      sessionId: 'session-new',
      environmentId: PRIOR_POINTER.environmentId,
      source: 'repl',
    })
  })

  test('perpetual teardown preserves the pointer without archive or result', async () => {
    const createSession = mock(async () => 'session-live')
    const archiveSession = mock(async () => {})
    pollForWork
      .mockResolvedValueOnce({
        id: 'work-live',
        secret: 'test-work-secret',
        data: { type: 'session', id: 'session-live' },
      })
      .mockImplementation(
        async (_environmentId, _environmentSecret, signal) =>
          waitForPollAbort(signal),
      )

    const handle = await requireCoreHandle(
      coreParams(createSession, archiveSession),
    )
    await waitForTransport()
    await handle.teardown()

    expect(archiveSession).not.toHaveBeenCalled()
    expect(transportWrite).not.toHaveBeenCalled()
    expect(transportClose).not.toHaveBeenCalled()
    expect(stopWork).not.toHaveBeenCalled()
    expect(clearBridgePointer).not.toHaveBeenCalled()
    expect(storedPointer).toMatchObject({
      sessionId: 'session-live',
      environmentId: 'env-fresh',
      source: 'repl',
    })
  })
})
