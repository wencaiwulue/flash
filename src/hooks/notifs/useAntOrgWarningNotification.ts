import { useEffect } from 'react'
import {
  type Notification,
  useNotifications,
} from '../../context/notifications.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import type { AccountInfo } from '../../utils/config.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

export const ORGANIZATION_WARNING_NOTIFICATION_KEY = 'organization-warning'

/** Build the managed-organization warning without reading global state. */
export function getOrganizationWarning(
  settings: Pick<SettingsJson, 'organizationWarning'>,
  account: Pick<AccountInfo, 'organizationUuid'> | undefined,
): Notification | null {
  const config = settings.organizationWarning
  if (!config || config.enabled === false) {
    return null
  }
  if (
    account?.organizationUuid &&
    config.allowedOrganizationUuids.includes(account.organizationUuid)
  ) {
    return null
  }

  return {
    key: ORGANIZATION_WARNING_NOTIFICATION_KEY,
    text:
      config.message ??
      'The current account is not signed in to an organization approved by your administrator. Switch organizations or contact your administrator.',
    color: 'warning',
    priority: 'high',
    timeoutMs: 15000,
  }
}

/** Show a one-shot warning for the publicly configured organization allowlist. */
export function useAntOrgWarningNotification(): void {
  const { addNotification } = useNotifications()

  useEffect(() => {
    const warning = getOrganizationWarning(
      getInitialSettings(),
      getOauthAccountInfo(),
    )
    if (warning) {
      addNotification(warning)
    }
  }, [addNotification])
}
