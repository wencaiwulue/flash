import React, { useEffect } from 'react'
import { Text } from '../../../ink.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

export function ReviewArtifactPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
}: PermissionRequestProps): React.ReactNode {
  useEffect(() => {
    toolUseConfirm.onReject('ReviewArtifact is unavailable in this build')
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  return <Text color="warning">ReviewArtifact is unavailable in this build.</Text>
}
