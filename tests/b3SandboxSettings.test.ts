import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { SandboxSettingsSchema } from '../src/entrypoints/sandboxTypes.ts'
import {
  convertToSandboxRuntimeConfig,
  shouldAllowManagedSandboxDomainsOnly,
} from '../src/utils/sandbox/sandbox-adapter.ts'
import * as settingsModule from '../src/utils/settings/settings.ts'

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  spies.forEach(s => s.mockRestore())
  spies.length = 0
})

// Upstream 2.1.311 sandbox.* schema + runtime-conversion alignment. The
// anti-escape invariant (denyWrite always covers settings.json paths) and the
// domain/filesystem extraction in convertToSandboxRuntimeConfig are the
// fail-closed core; these tests pin them without standing up a real sandbox.
describe('sandbox schema', () => {
  it('accepts enabled/network/filesystem/ripgrep subfields', () => {
    const parsed = SandboxSettingsSchema().parse({
      enabled: true,
      network: { allowedDomains: ['a.com'], httpProxyPort: 8080 },
      filesystem: { denyWrite: ['/etc'], allowRead: ['/tmp'] },
      ripgrep: { command: 'rg', args: ['--hidden'] },
    })
    expect(parsed.enabled).toBe(true)
    expect(parsed.network?.httpProxyPort).toBe(8080)
    expect(parsed.filesystem?.denyWrite).toEqual(['/etc'])
    expect(parsed.ripgrep?.command).toBe('rg')
  })

  it('rejects a non-boolean enabled', () => {
    expect(() => SandboxSettingsSchema().parse({ enabled: 'yes' })).toThrow()
  })

  it('accepts boolean toggle subfields', () => {
    const parsed = SandboxSettingsSchema().parse({
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      enableWeakerNestedSandbox: true,
      enableWeakerNetworkIsolation: true,
      excludedCommands: ['git'],
    })
    expect(parsed.autoAllowBashIfSandboxed).toBe(false)
    expect(parsed.allowUnsandboxedCommands).toBe(false)
    expect(parsed.failIfUnavailable).toBe(true)
    expect(parsed.excludedCommands).toEqual(['git'])
  })
})

describe('convertToSandboxRuntimeConfig (fail-closed)', () => {
  it('denyWrite always covers settings.json paths (anti-escape)', () => {
    const cfg = convertToSandboxRuntimeConfig({} as never)
    expect(
      cfg.filesystem.denyWrite.some(p => p.includes('settings')),
    ).toBe(true)
  })

  it('allowWrite always includes cwd and the temp dir', () => {
    const cfg = convertToSandboxRuntimeConfig({} as never)
    expect(cfg.filesystem.allowWrite).toContain('.')
    expect(cfg.filesystem.allowWrite.length).toBeGreaterThanOrEqual(2)
  })

  it('extracts allowedDomains from sandbox.network.allowedDomains', () => {
    const cfg = convertToSandboxRuntimeConfig({
      sandbox: { network: { allowedDomains: ['example.com'] } },
    } as never)
    expect(cfg.network.allowedDomains).toContain('example.com')
  })

  it('extracts deniedDomains from permissions.deny WebFetch(domain:) rules', () => {
    const cfg = convertToSandboxRuntimeConfig({
      permissions: { deny: ['WebFetch(domain:evil.com)'] },
    } as never)
    expect(cfg.network.deniedDomains).toContain('evil.com')
  })

  it('passes through network/filesystem/weaker/ignoreViolations fields', () => {
    const cfg = convertToSandboxRuntimeConfig({
      sandbox: {
        network: { httpProxyPort: 8080, allowLocalBinding: true },
        enableWeakerNestedSandbox: true,
        enableWeakerNetworkIsolation: true,
        ignoreViolations: { Bash: ['x'] },
      },
    } as never)
    expect(cfg.network.httpProxyPort).toBe(8080)
    expect(cfg.network.allowLocalBinding).toBe(true)
    expect(cfg.enableWeakerNestedSandbox).toBe(true)
    expect(cfg.enableWeakerNetworkIsolation).toBe(true)
    expect(cfg.ignoreViolations).toEqual({ Bash: ['x'] })
  })
})

describe('sandbox managed-only (fail-closed)', () => {
  it('allowManagedDomainsOnly reads policySettings only', () => {
    spies.push(
      spyOn(settingsModule, 'getSettingsForSource').mockReturnValue({
        sandbox: { network: { allowManagedDomainsOnly: true } },
      } as never),
    )
    expect(shouldAllowManagedSandboxDomainsOnly()).toBe(true)
  })

  it('false when only a non-managed source sets it', () => {
    spies.push(
      spyOn(settingsModule, 'getSettingsForSource').mockReturnValue(
        undefined as never,
      ),
    )
    expect(shouldAllowManagedSandboxDomainsOnly()).toBe(false)
  })

  it('managed-only domains: only managed domains used, user domains ignored', () => {
    spies.push(
      spyOn(settingsModule, 'getSettingsForSource').mockImplementation(
        ((source: string) =>
          source === 'policySettings'
            ? {
                sandbox: {
                  network: {
                    allowManagedDomainsOnly: true,
                    allowedDomains: ['managed.com'],
                  },
                },
              }
            : undefined) as never,
      ),
    )
    const cfg = convertToSandboxRuntimeConfig({
      sandbox: { network: { allowedDomains: ['user.com'] } },
    } as never)
    expect(cfg.network.allowedDomains).toContain('managed.com')
    expect(cfg.network.allowedDomains).not.toContain('user.com')
  })
})
