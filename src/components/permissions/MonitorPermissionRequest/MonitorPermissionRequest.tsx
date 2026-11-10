import React from 'react'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { BashPermissionRequest } from '../BashPermissionRequest/BashPermissionRequest.js'

/** Monitor executes a shell command, so it uses Bash's permission UI and rules. */
export function MonitorPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  return <BashPermissionRequest {...props} />
}
