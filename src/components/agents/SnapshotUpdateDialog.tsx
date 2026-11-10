import React, { useEffect } from 'react'
import { Text } from '../../ink.js'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'

export type SnapshotUpdateChoice = 'merge' | 'keep' | 'replace'

export function buildMergePrompt(
  _agentType: string,
  _scope: AgentMemoryScope,
): string {
  throw new Error('Agent memory snapshot merging is unavailable in this build')
}

type Props = {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (choice: SnapshotUpdateChoice) => void
  onCancel: () => void
}

export function SnapshotUpdateDialog({
  agentType: _agentType,
  scope: _scope,
  snapshotTimestamp: _snapshotTimestamp,
  onComplete: _onComplete,
  onCancel,
}: Props): React.ReactNode {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return <Text color="warning">Agent memory snapshots are unavailable in this build.</Text>
}
