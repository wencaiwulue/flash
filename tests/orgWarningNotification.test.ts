import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'stream'
import { createElement } from 'react'
import { renderSync } from '../src/ink/root.ts'
import { SettingsSchema } from '../src/utils/settings/types.ts'

const addNotification = mock(() => {})
let currentSettings: Record<string, unknown> = {}
let currentAccount: { organizationUuid?: string } | undefined

const actualNotifications = await import('../src/context/notifications.tsx')
const actualAuth = await import('../src/utils/auth.ts')
const actualSettings = await import('../src/utils/settings/settings.ts')

mock.module('../src/context/notifications.tsx', () => ({
  ...actualNotifications,
  useNotifications: () => ({
    addNotification,
    removeNotification: () => {},
  }),
}))
mock.module('../src/utils/auth.ts', () => ({
  ...actualAuth,
  getOauthAccountInfo: () => currentAccount,
}))
mock.module('../src/utils/settings/settings.ts', () => ({
  ...actualSettings,
  getInitialSettings: () => currentSettings,
}))

const {
  getOrganizationWarning,
  ORGANIZATION_WARNING_NOTIFICATION_KEY,
  useAntOrgWarningNotification,
} = await import('../src/hooks/notifs/useAntOrgWarningNotification.ts')

beforeEach(() => {
  addNotification.mockClear()
  currentAccount = { organizationUuid: 'org-unapproved' }
  currentSettings = {
    organizationWarning: {
      allowedOrganizationUuids: ['org-approved'],
    },
  }
})

afterAll(() => {
  mock.restore()
})

describe('public organization warning', () => {
  test('accepts managed-settings shape without any built-in organization UUID', () => {
    const parsed = SettingsSchema().safeParse(currentSettings)
    expect(parsed.success).toBe(true)
  })

  test('does not warn for a matching organization or when disabled', () => {
    currentAccount = { organizationUuid: 'org-approved' }
    expect(getOrganizationWarning(currentSettings, currentAccount)).toBeNull()

    currentAccount = { organizationUuid: 'org-unapproved' }
    currentSettings = {
      organizationWarning: {
        enabled: false,
        allowedOrganizationUuids: ['org-approved'],
      },
    }
    expect(getOrganizationWarning(currentSettings, currentAccount)).toBeNull()
  })

  test('warns for mismatches and missing organizations with configurable text', () => {
    const warning = getOrganizationWarning(currentSettings, currentAccount)
    expect(warning).toMatchObject({
      key: ORGANIZATION_WARNING_NOTIFICATION_KEY,
      color: 'warning',
      priority: 'high',
    })
    expect(getOrganizationWarning(currentSettings, undefined)).not.toBeNull()

    currentSettings = {
      organizationWarning: {
        allowedOrganizationUuids: ['org-approved'],
        message: 'Use the Acme organization for this managed device.',
      },
    }
    expect(getOrganizationWarning(currentSettings, currentAccount)?.text).toBe(
      'Use the Acme organization for this managed device.',
    )
  })

  test('adds one hook notification across rerenders and stops cleanly on unmount', async () => {
    const stdout = new PassThrough() as NodeJS.WriteStream
    const stderr = new PassThrough() as NodeJS.WriteStream
    const stdin = new PassThrough() as NodeJS.ReadStream
    Object.assign(stdout, { columns: 80, rows: 24, isTTY: false })
    Object.assign(stderr, { columns: 80, rows: 24, isTTY: false })
    Object.assign(stdin, { isTTY: false })

    function Hook() {
      useAntOrgWarningNotification()
      return null
    }

    const instance = renderSync(createElement(Hook), {
      stdout,
      stderr,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    await Bun.sleep(20)
    expect(addNotification).toHaveBeenCalledTimes(1)

    instance.rerender(createElement(Hook))
    instance.rerender(createElement(Hook))
    await Bun.sleep(0)
    expect(addNotification).toHaveBeenCalledTimes(1)

    instance.unmount()
    instance.cleanup()
    await Bun.sleep(0)
    expect(addNotification).toHaveBeenCalledTimes(1)
    stdout.end()
    stderr.end()
    stdin.end()
  })
})
