import React from 'react'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { FallbackPermissionRequest } from '../FallbackPermissionRequest.js'

/** Reviewing is read-only; file-backed reviews reuse FileRead permission checks. */
export function ReviewArtifactPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  return <FallbackPermissionRequest {...props} />
}
