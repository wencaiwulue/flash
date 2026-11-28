import { describe, it, expect } from 'bun:test'
import { SettingsSchema } from '../src/utils/settings/types.ts'

function parseSetting(key: string, value: unknown) {
  return SettingsSchema().safeParse({ [key]: value })
}

// B4 (#21): integration-facing settings — align the 4 partials that already have
// a zod schema + runtime consumer. forceLoginMethod stays partial (upstream also
// honors "gateway", which flash's zod enum omits — recorded as a gap).
describe('B4 integration settings', () => {
  it('forceLoginOrgUUID accepts a string', () => {
    expect(parseSetting('forceLoginOrgUUID', 'org-uuid-123').success).toBe(true)
    expect(parseSetting('forceLoginOrgUUID', 42).success).toBe(false)
  })

  it('pluginTrustMessage accepts a string (managed-only)', () => {
    expect(parseSetting('pluginTrustMessage', 'Trust this plugin?').success).toBe(true)
    expect(parseSetting('pluginTrustMessage', 42).success).toBe(false)
  })

  it('pluginConfigs accepts pluginId -> { mcpServers, options }', () => {
    const r = parseSetting('pluginConfigs', {
      'my-plugin': {
        mcpServers: { srv: { API_KEY: 'secret', PORT: 8080, DEBUG: true } },
        options: { region: 'us-east-1', retries: 3 },
      },
    })
    expect(r.success).toBe(true)
  })

  it('forceLoginMethod enum omits "gateway" (upstream gap)', () => {
    // Upstream honors "gateway" (from the same sources as forceLoginGatewayUrl).
    // flash's zod enum is only ['claudeai','console'] — recorded as a gap.
    expect(parseSetting('forceLoginMethod', 'claudeai').success).toBe(true)
    expect(parseSetting('forceLoginMethod', 'console').success).toBe(true)
    expect(parseSetting('forceLoginMethod', 'gateway').success).toBe(false)
  })
})

describe('B4 remote.defaultEnvironmentId', () => {
  it('remote.defaultEnvironmentId accepts a string', () => {
    const r = parseSetting('remote', { defaultEnvironmentId: 'ccpool_abc123' })
    expect(r.success).toBe(true)
  })
})
