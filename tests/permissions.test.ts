import { describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { z } from 'zod'
import type { ToolPermissionContext, ToolUseContext } from '../src/Tool.ts'
import { hasPermissionsToUseTool } from '../src/utils/permissions/permissions.ts'
import { createAssistantMessage } from '../src/utils/messages.ts'

// ============================================================================
// Test utilities
// ============================================================================

function createEmptyPermissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  } as ToolPermissionContext
}

// ============================================================================
// Denial Tracking Tests (B2-permissions-01, B2-permissions-03)
// ============================================================================

describe('denial tracking state machine', () => {
  test('initializes with zero counts', async () => {
    const denialTracking = await import('../src/utils/permissions/denialTracking.ts')
    const state = denialTracking.createDenialTrackingState()
    expect(state.consecutiveDenials).toBe(0)
    expect(state.totalDenials).toBe(0)
  })

  test('records consecutive denials and total denials', async () => {
    const denialTracking = await import('../src/utils/permissions/denialTracking.ts')
    let state = denialTracking.createDenialTrackingState()

    state = denialTracking.recordDenial(state)
    expect(state.consecutiveDenials).toBe(1)
    expect(state.totalDenials).toBe(1)

    state = denialTracking.recordDenial(state)
    expect(state.consecutiveDenials).toBe(2)
    expect(state.totalDenials).toBe(2)

    state = denialTracking.recordDenial(state)
    expect(state.consecutiveDenials).toBe(3)
    expect(state.totalDenials).toBe(3)
  })

  test('resets consecutive denials on success, preserves total', async () => {
    const denialTracking = await import('../src/utils/permissions/denialTracking.ts')
    let state = denialTracking.createDenialTrackingState()

    state = denialTracking.recordDenial(state)
    state = denialTracking.recordDenial(state)
    state = denialTracking.recordDenial(state)
    expect(state.consecutiveDenials).toBe(3)
    expect(state.totalDenials).toBe(3)

    state = denialTracking.recordSuccess(state)
    expect(state.consecutiveDenials).toBe(0)
    expect(state.totalDenials).toBe(3)
  })

  test('no-op success when consecutive already zero', async () => {
    const denialTracking = await import('../src/utils/permissions/denialTracking.ts')
    const state = denialTracking.createDenialTrackingState()
    const newState = denialTracking.recordSuccess(state)
    expect(newState).toBe(state) // Reference equality when no change
  })

  test('triggers fallback after 3 consecutive denials', async () => {
    const denialTracking = await import('../src/utils/permissions/denialTracking.ts')
    let state = denialTracking.createDenialTrackingState()

    expect(denialTracking.shouldFallbackToPrompting(state)).toBe(false)

    state = denialTracking.recordDenial(state)
    expect(denialTracking.shouldFallbackToPrompting(state)).toBe(false)

    state = denialTracking.recordDenial(state)
    expect(denialTracking.shouldFallbackToPrompting(state)).toBe(false)

    state = denialTracking.recordDenial(state)
    expect(denialTracking.shouldFallbackToPrompting(state)).toBe(true)
  })

  test('triggers fallback after 20 total denials', async () => {
    const denialTracking = await import('../src/utils/permissions/denialTracking.ts')
    let state = denialTracking.createDenialTrackingState()

    // Add 19 denials with intermittent success to keep consecutive below 3
    for (let i = 0; i < 19; i++) {
      state = denialTracking.recordDenial(state)
      state = denialTracking.recordSuccess(state)
    }

    // Add one more denial to reach total 20
    state = denialTracking.recordDenial(state)

    expect(state.totalDenials).toBe(20)
    expect(denialTracking.shouldFallbackToPrompting(state)).toBe(true)
  })

  test('DENIAL_LIMITS are correctly defined', async () => {
    const denialTracking = await import('../src/utils/permissions/denialTracking.ts')
    expect(denialTracking.DENIAL_LIMITS.maxConsecutive).toBe(3)
    expect(denialTracking.DENIAL_LIMITS.maxTotal).toBe(20)
  })
})

// ============================================================================
// Permission Mode Tests (B2-permissions-03)
// ============================================================================

describe('permission mode utilities', () => {
  test('permission mode from string gracefully handles invalid', async () => {
    const permissionMode = await import('../src/utils/permissions/PermissionMode.ts')
    expect(permissionMode.permissionModeFromString('default')).toBe('default')
    expect(permissionMode.permissionModeFromString('acceptEdits')).toBe('acceptEdits')
    expect(permissionMode.permissionModeFromString('invalid-mode')).toBe('default')
    expect(permissionMode.permissionModeFromString('')).toBe('default')
  })

  test('permission mode titles are defined', async () => {
    const permissionMode = await import('../src/utils/permissions/PermissionMode.ts')
    expect(typeof permissionMode.permissionModeTitle('default')).toBe('string')
    expect(typeof permissionMode.permissionModeTitle('acceptEdits')).toBe('string')
    expect(typeof permissionMode.permissionModeTitle('dontAsk')).toBe('string')
    expect(typeof permissionMode.permissionModeTitle('plan')).toBe('string')
    expect(typeof permissionMode.permissionModeTitle('bypassPermissions')).toBe('string')
  })

  test('isDefaultMode correctly identifies defaults', async () => {
    const permissionMode = await import('../src/utils/permissions/PermissionMode.ts')
    expect(permissionMode.isDefaultMode('default')).toBe(true)
    expect(permissionMode.isDefaultMode(undefined)).toBe(true)
    expect(permissionMode.isDefaultMode('acceptEdits')).toBe(false)
    expect(permissionMode.isDefaultMode('dontAsk')).toBe(false)
  })
})

// ============================================================================
// Permission Rule Tests (B2-permissions-03)
// ============================================================================

describe('permission rule parsing', () => {
  test('parses simple tool rules', async () => {
    const ruleParser = await import('../src/utils/permissions/permissionRuleParser.ts')
    const rule = ruleParser.permissionRuleValueFromString('Bash')
    expect(rule.toolName).toBe('Bash')
    expect(rule.ruleContent).toBeUndefined()
  })

  test('parses content-specific rules', async () => {
    const ruleParser = await import('../src/utils/permissions/permissionRuleParser.ts')
    const rule = ruleParser.permissionRuleValueFromString('Bash(prompt: ls)')
    expect(rule.toolName).toBe('Bash')
    expect(rule.ruleContent).toBe('prompt: ls')
  })

  test('parses wildcard rules as tool-wide rules', async () => {
    const ruleParser = await import('../src/utils/permissions/permissionRuleParser.ts')
    const rule = ruleParser.permissionRuleValueFromString('Bash(*)')
    expect(rule.toolName).toBe('Bash')
    expect(rule.ruleContent).toBeUndefined() // Wildcard is treated as tool-wide rule
  })

  test('serializes rules back to strings', async () => {
    const ruleParser = await import('../src/utils/permissions/permissionRuleParser.ts')
    const cases = [
      { input: 'Bash', expected: 'Bash' },
      { input: 'Bash(prompt: ls)', expected: 'Bash(prompt: ls)' },
      { input: 'Bash(*)', expected: 'Bash' }, // Wildcard becomes tool-wide
      { input: 'Read', expected: 'Read' },
      { input: 'Write(path: test.ts)', expected: 'Write(path: test.ts)' },
    ]

    for (const { input, expected } of cases) {
      const parsed = ruleParser.permissionRuleValueFromString(input)
      const serialized = ruleParser.permissionRuleValueToString(parsed)
      expect(serialized).toBe(expected)
    }
  })
})

// ============================================================================
// Dangerous Permission Detection Tests (B2-permissions-03)
// ============================================================================

describe('dangerous permission detection', () => {
  test('identifies dangerous Bash rules', async () => {
    const permissionSetup = await import('../src/utils/permissions/permissionSetup.ts')
    expect(permissionSetup.isDangerousBashPermission('Bash', undefined)).toBe(true)
    expect(permissionSetup.isDangerousBashPermission('Bash', '*')).toBe(true)
    expect(permissionSetup.isDangerousBashPermission('Bash', '')).toBe(true)
  })

  test('safe Bash rules are not flagged', async () => {
    const permissionSetup = await import('../src/utils/permissions/permissionSetup.ts')
    expect(permissionSetup.isDangerousBashPermission('Bash', 'prompt: ls')).toBe(false)
    expect(permissionSetup.isDangerousBashPermission('Bash', 'command: git status')).toBe(false)
  })

  test('identifies dangerous PowerShell rules', async () => {
    const permissionSetup = await import('../src/utils/permissions/permissionSetup.ts')
    expect(permissionSetup.isDangerousPowerShellPermission('PowerShell', undefined)).toBe(true)
    expect(permissionSetup.isDangerousPowerShellPermission('PowerShell', '*')).toBe(true)
  })

  test('identifies Agent rules as dangerous', async () => {
    const permissionSetup = await import('../src/utils/permissions/permissionSetup.ts')
    expect(permissionSetup.isDangerousTaskPermission('Agent', undefined)).toBe(true)
  })

  test('only flags dangerous rules for correct tools', async () => {
    const permissionSetup = await import('../src/utils/permissions/permissionSetup.ts')
    expect(permissionSetup.isDangerousBashPermission('Read', undefined)).toBe(false)
    expect(permissionSetup.isDangerousPowerShellPermission('Bash', '*')).toBe(false)
  })
})

// ============================================================================
// Empty Permission Context Tests
// ============================================================================

describe('empty permission context', () => {
  test('creates valid empty context', async () => {
    const { getEmptyToolPermissionContext } = await import('../src/Tool.ts')
    const context = getEmptyToolPermissionContext()

    expect(context.mode).toBe('default')
    expect(context.additionalWorkingDirectories.size).toBe(0)
    expect(context.alwaysAllowRules).toEqual({})
    expect(context.alwaysDenyRules).toEqual({})
    expect(context.alwaysAskRules).toEqual({})
    expect(context.isBypassPermissionsModeAvailable).toBe(false)
  })
})

// ============================================================================
// Rule Precedence and Denial Enforcement (B2-permissions-03)
// ============================================================================

describe('permission rule precedence logic', () => {
  test('getAllowRules/getDenyRules/getAskRules functions exist', async () => {
    const permissions = await import('../src/utils/permissions/permissions.ts')
    expect(typeof permissions.getAllowRules).toBe('function')
    expect(typeof permissions.getDenyRules).toBe('function')
    expect(typeof permissions.getAskRules).toBe('function')
  })

  test('getSettingSources defines the rule sources', async () => {
    const settingSources = await import('../src/utils/settings/constants.ts')
    // SETTING_SOURCES is part of the system, PERMISSION_RULE_SOURCES adds cliArg, command, session
    expect(settingSources.SETTING_SOURCES).toBeDefined()
  })
})

// ============================================================================
// dontAsk Mode Behavior (B2-permissions-01, B2-permissions-03)
// ============================================================================

describe('dontAsk mode decision logic', () => {
  test('DONT_ASK_REJECT_MESSAGE is defined', async () => {
    const messages = await import('../src/utils/messages.ts')
    expect(typeof messages.DONT_ASK_REJECT_MESSAGE).toBe('function')

    const msg = messages.DONT_ASK_REJECT_MESSAGE('Bash')
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
    expect(msg).toContain('Bash')
  })

  test('auto mode messages are defined', async () => {
    const messages = await import('../src/utils/messages.ts')

    expect(typeof messages.AUTO_REJECT_MESSAGE).toBe('function')
    expect(typeof messages.buildClassifierUnavailableMessage).toBe('function')
    expect(typeof messages.buildYoloRejectionMessage).toBe('function')

    const autoReject = messages.AUTO_REJECT_MESSAGE('Bash')
    expect(typeof autoReject).toBe('string')
    expect(autoReject.length).toBeGreaterThan(0)
  })

  test('createPermissionRequestMessage is defined', async () => {
    const permissions = await import('../src/utils/permissions/permissions.ts')
    expect(typeof permissions.createPermissionRequestMessage).toBe('function')
  })
})

// ============================================================================
// Auto Mode Safety Gate (B2-permissions-03)
// ============================================================================

describe('auto mode safety gates', () => {
  test('permissionSetup has auto-mode related functions', async () => {
    const permissionSetup = await import('../src/utils/permissions/permissionSetup.ts')
    expect(typeof permissionSetup.isAutoModeGateEnabled).toBe('function')
    expect(typeof permissionSetup.getAutoModeUnavailableReason).toBe('function')
    expect(typeof permissionSetup.isDefaultPermissionModeAuto).toBe('function')
    expect(typeof permissionSetup.shouldPlanUseAutoMode).toBe('function')
  })
})

// ============================================================================
// Bypass Permissions Mode (B2-permissions-03)
// ============================================================================

describe('bypass permissions mode', () => {
  test('createDisabledBypassPermissionsContext transforms context correctly', async () => {
    const permissionSetup = await import('../src/utils/permissions/permissionSetup.ts')
    const original = createEmptyPermissionContext({
      mode: 'bypassPermissions',
      isBypassPermissionsModeAvailable: true,
    })

    const transformed = permissionSetup.createDisabledBypassPermissionsContext(original)

    // Bypass mode should be disabled
    expect(transformed.isBypassPermissionsModeAvailable).toBe(false)

    // Mode should revert to default if it was bypass
    expect(transformed.mode).toBe('default')
  })

  test('createDisabledBypassPermissionsContext preserves other modes', async () => {
    const permissionSetup = await import('../src/utils/permissions/permissionSetup.ts')
    const original = createEmptyPermissionContext({
      mode: 'acceptEdits',
      isBypassPermissionsModeAvailable: true,
    })

    const transformed = permissionSetup.createDisabledBypassPermissionsContext(original)

    // Mode should be preserved if it wasn't bypass
    expect(transformed.mode).toBe('acceptEdits')
  })
})

// ============================================================================
// Integration: Actual production decision flow (B2-permissions-03)
// ============================================================================

function toolContext(permission: ToolPermissionContext): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: permission,
      sessionHooks: new Map(),
    }),
    messages: [],
    options: { tools: [] },
  } as unknown as ToolUseContext
}

function demoTool(name = 'DemoTool') {
  return {
    name,
    inputSchema: z.object({}),
    checkPermissions: async (_input: unknown, context: ToolUseContext) => {
      if (context.getAppState().toolPermissionContext.mode === 'acceptEdits') {
        return { behavior: 'allow', updatedInput: {} }
      }
      return { behavior: 'passthrough', message: 'approval required' }
    },
  } as any
}

const assistant = createAssistantMessage({ content: 'permission test' })

describe('actual hasPermissionsToUseTool decisions', () => {
  test('deny rule wins before tool implementation and other rules', async () => {
    const permission = createEmptyPermissionContext({
      alwaysDenyRules: { session: ['DemoTool'] },
      alwaysAllowRules: { session: ['DemoTool'] },
      alwaysAskRules: { session: ['DemoTool'] },
    })
    const result = await hasPermissionsToUseTool(demoTool(), {}, toolContext(permission), assistant, 'tool-1')
    expect(result.behavior).toBe('deny')
  })

  test('ask rule is preserved in default mode', async () => {
    const permission = createEmptyPermissionContext({ alwaysAskRules: { session: ['DemoTool'] } })
    const result = await hasPermissionsToUseTool(demoTool(), {}, toolContext(permission), assistant, 'tool-1')
    expect(result.behavior).toBe('ask')
  })

  test('dontAsk converts an ask result to deny', async () => {
    const permission = createEmptyPermissionContext({
      mode: 'dontAsk',
      alwaysAskRules: { session: ['DemoTool'] },
    })
    const result = await hasPermissionsToUseTool(demoTool(), {}, toolContext(permission), assistant, 'tool-1')
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason).toMatchObject({ type: 'mode', mode: 'dontAsk' })
  })

  test('allow rule permits without invoking a classifier', async () => {
    const permission = createEmptyPermissionContext({ alwaysAllowRules: { session: ['DemoTool'] } })
    const result = await hasPermissionsToUseTool(demoTool(), {}, toolContext(permission), assistant, 'tool-1')
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({ type: 'rule' })
  })

  test('tool-specific deny is enforced even in bypass mode', async () => {
    const permission = createEmptyPermissionContext({ mode: 'bypassPermissions' })
    const tool = {
      ...demoTool(),
      checkPermissions: async () => ({ behavior: 'deny', message: 'tool denied' }),
    }
    const result = await hasPermissionsToUseTool(tool, {}, toolContext(permission), assistant, 'tool-1')
    expect(result.behavior).toBe('deny')
  })

  test('auto acceptEdits fast path returns an actual allow decision', async () => {
    const permission = createEmptyPermissionContext({ mode: 'auto' })
    const result = await hasPermissionsToUseTool(demoTool(), {}, toolContext(permission), assistant, 'tool-1')
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      expect(result.behavior).toBe('allow')
      expect(result.decisionReason).toMatchObject({ type: 'mode', mode: 'auto' })
    } else {
      expect(result.behavior).toBe('ask')
    }
  })

  test('auto non-approvable safety check denies headless agent without prompts', async () => {
    const permission = createEmptyPermissionContext({
      mode: 'auto',
      shouldAvoidPermissionPrompts: true,
    })
    const tool = {
      ...demoTool(),
      checkPermissions: async () => ({
        behavior: 'ask',
        message: 'interactive approval required',
        decisionReason: { type: 'safetyCheck', classifierApprovable: false },
      }),
    }
    const result = await hasPermissionsToUseTool(tool, {}, toolContext(permission), assistant, 'tool-1')
    expect(result.behavior).toBe('deny')
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      expect(result.decisionReason?.type).toBe('asyncAgent')
    }
  })
})
