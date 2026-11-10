import React from 'react'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { FallbackPermissionRequest } from '../../components/permissions/FallbackPermissionRequest.js'

/** Workflow steps use their own tool permissions; this is only a launch review. */
export function WorkflowPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  return React.createElement(FallbackPermissionRequest, props)
}
