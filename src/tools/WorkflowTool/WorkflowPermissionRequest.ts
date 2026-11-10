import React, { useEffect } from 'react'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { Text } from '../../ink.js'

export function WorkflowPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
}: PermissionRequestProps): React.ReactNode {
  useEffect(() => {
    toolUseConfirm.onReject('Workflow is unavailable in this build')
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  return React.createElement(
    Text,
    { color: 'warning' },
    'Workflow is unavailable in this build.',
  )
}
