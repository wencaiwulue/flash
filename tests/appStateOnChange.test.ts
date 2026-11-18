import { beforeEach, describe, expect, mock, test } from 'bun:test'

const clearApiKeyHelperCache = mock(() => {})
const clearAwsCredentialsCache = mock(() => {})
const clearGcpCredentialsCache = mock(() => {})
const updateSettingsForSource = mock(() => ({ error: null }))
const applyConfigEnvironmentVariables = mock(() => {})
const notifySessionMetadataChanged = mock(() => {})
const notifyPermissionModeChanged = mock(() => {})

const authModule = await import('../src/utils/auth.ts')
mock.module('../src/utils/auth.ts', () => ({
  ...authModule,
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
}))
const settingsModule = await import('../src/utils/settings/settings.ts')
mock.module('../src/utils/settings/settings.ts', () => ({
  ...settingsModule,
  updateSettingsForSource,
}))
const managedEnvModule = await import('../src/utils/managedEnv.ts')
mock.module('../src/utils/managedEnv.ts', () => ({
  ...managedEnvModule,
  applyConfigEnvironmentVariables,
}))
const sessionStateModule = await import('../src/utils/sessionState.ts')
mock.module('../src/utils/sessionState.ts', () => ({
  ...sessionStateModule,
  notifySessionMetadataChanged,
  notifyPermissionModeChanged,
}))

const { onChangeAppState } = await import('../src/state/onChangeAppState.ts')
const { getDefaultAppState } = await import('../src/state/AppStateStore.ts')
const { getGlobalConfig, saveGlobalConfig } = await import(
  '../src/utils/config.ts'
)
const {
  getMainLoopModelOverride,
  resetStateForTests,
} = await import('../src/bootstrap/state.ts')

beforeEach(() => {
  for (const fn of [
    clearApiKeyHelperCache,
    clearAwsCredentialsCache,
    clearGcpCredentialsCache,
    updateSettingsForSource,
    applyConfigEnvironmentVariables,
    notifySessionMetadataChanged,
    notifyPermissionModeChanged,
  ]) {
    fn.mockClear()
  }
  resetStateForTests()
  saveGlobalConfig(current => ({
    ...current,
    verbose: false,
    showExpandedTodos: undefined,
    showSpinnerTree: undefined,
  }))
})

describe('onChangeAppState side effects', () => {
  test('persists verbose and expandedView without touching auth caches', () => {
    const oldState = getDefaultAppState()
    onChangeAppState({
      oldState,
      newState: { ...oldState, verbose: true, expandedView: 'tasks' },
    })

    expect(getGlobalConfig().verbose).toBe(true)
    expect(getGlobalConfig().showExpandedTodos).toBe(true)
    expect(getGlobalConfig().showSpinnerTree).toBe(false)
    expect(clearApiKeyHelperCache).not.toHaveBeenCalled()
    expect(updateSettingsForSource).not.toHaveBeenCalled()

    onChangeAppState({
      oldState: { ...oldState, expandedView: 'tasks' },
      newState: { ...oldState, expandedView: 'teammates' },
    })
    expect(getGlobalConfig().showExpandedTodos).toBe(false)
    expect(getGlobalConfig().showSpinnerTree).toBe(true)
  })

  test('settings changes clear auth/provider caches and reapply environment', () => {
    const oldState = getDefaultAppState()
    onChangeAppState({
      oldState,
      newState: {
        ...oldState,
        settings: { env: { OFFLINE_SETTING: '1' } },
      },
    })

    expect(clearApiKeyHelperCache).toHaveBeenCalledTimes(1)
    expect(clearAwsCredentialsCache).toHaveBeenCalledTimes(1)
    expect(clearGcpCredentialsCache).toHaveBeenCalledTimes(1)
    expect(applyConfigEnvironmentVariables).toHaveBeenCalledTimes(1)
  })

  test('model changes persist and clear both settings and bootstrap override', () => {
    const oldState = getDefaultAppState()
    onChangeAppState({
      oldState,
      newState: { ...oldState, mainLoopModel: 'offline-model-b' },
    })
    expect(updateSettingsForSource).toHaveBeenCalledWith('userSettings', {
      model: 'offline-model-b',
    })
    expect(getMainLoopModelOverride()).toBe('offline-model-b')

    onChangeAppState({
      oldState: { ...oldState, mainLoopModel: 'offline-model-b' },
      newState: oldState,
    })
    expect(updateSettingsForSource).toHaveBeenCalledWith('userSettings', {
      model: undefined,
    })
    expect(getMainLoopModelOverride()).toBeNull()
  })

  test('permission changes distinguish external metadata from raw mode notifications', () => {
    const oldState = getDefaultAppState()
    const bubbleState = {
      ...oldState,
      toolPermissionContext: {
        ...oldState.toolPermissionContext,
        mode: 'bubble' as const,
      },
    }
    onChangeAppState({ oldState, newState: bubbleState })
    expect(notifyPermissionModeChanged).toHaveBeenCalledWith('bubble')
    expect(notifySessionMetadataChanged).not.toHaveBeenCalled()

    const planState = {
      ...bubbleState,
      isUltraplanMode: true,
      toolPermissionContext: {
        ...bubbleState.toolPermissionContext,
        mode: 'plan' as const,
      },
    }
    onChangeAppState({ oldState: bubbleState, newState: planState })
    expect(notifySessionMetadataChanged).toHaveBeenCalledWith({
      permission_mode: 'plan',
      is_ultraplan_mode: true,
    })
    expect(notifyPermissionModeChanged).toHaveBeenCalledWith('plan')
  })
})
