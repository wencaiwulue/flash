import { createHash } from 'crypto'
import { lstat, readFile, readdir } from 'fs/promises'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'path'
import React from 'react'
import { z } from 'zod/v4'
import { buildTool, type Tool } from '../../Tool.js'
import { Text } from '../../ink.js'
import { jsonParse } from '../../utils/slowOperations.js'
import type { AgentMemoryScope } from './agentMemory.js'
import {
  commitSyncedMeta,
  getSnapshotPaths,
} from './agentMemorySnapshot.js'

export const COMPLETE_AGENT_MEMORY_SNAPSHOT_MERGE =
  'CompleteAgentMemorySnapshotMerge'

const completionInputSchema = z.strictObject({
  changedFiles: z.array(z.string()),
  noChangeRequired: z.boolean(),
})
type CompletionInput = z.infer<typeof completionInputSchema>

type PendingMerge = {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  targetHashesBefore: Map<string, string | null>
  completing: boolean
}

let pendingMerge: PendingMerge | null = null

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function readTargetHashes(
  targetDir: string,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  let entries
  try {
    entries = await readdir(targetDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue
    const path = join(targetDir, entry.name)
    const stats = await lstat(path)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Target Markdown is not a regular file: ${entry.name}`)
    }
    result.set(entry.name, hash(await readFile(path, 'utf8')))
  }
  return result
}

/** Register the one completion protocol instance for this startup merge. */
export async function beginAgentMemorySnapshotMerge(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<Tool> {
  if (pendingMerge) {
    throw new Error('An agent memory snapshot merge is already pending')
  }
  const { snapshotDir, targetDir } = getSnapshotPaths(agentType, scope)
  const source = z
    .object({ updatedAt: z.string() })
    .safeParse(jsonParse(await readFile(join(snapshotDir, 'snapshot.json'), 'utf8')))
  if (!source.success || source.data.updatedAt !== snapshotTimestamp) {
    throw new Error('The snapshot changed before the merge could be started')
  }
  const pending: PendingMerge = {
    agentType,
    scope,
    snapshotTimestamp,
    targetHashesBefore: await readTargetHashes(targetDir),
    completing: false,
  }
  pendingMerge = pending
  return createCompletionTool(pending)
}

export function hasPendingAgentMemorySnapshotMerge(): boolean {
  return pendingMerge !== null
}

/** Clear only in-memory startup state on session teardown; never touches files. */
export function abandonAgentMemorySnapshotMerge(): void {
  pendingMerge = null
}

function validateChangedPath(targetDir: string, input: string): string {
  if (!input || isAbsolute(input) || input.includes('\0')) {
    throw new Error('changedFiles must contain relative paths inside the target')
  }
  const normalized = normalize(input)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('..' + sep) ||
    basename(normalized) !== normalized ||
    !normalized.endsWith('.md')
  ) {
    throw new Error(`Invalid changed Markdown path: ${input}`)
  }
  const target = resolve(targetDir, normalized)
  if (!target.startsWith(resolve(targetDir) + sep)) {
    throw new Error(`Changed file escapes the target: ${input}`)
  }
  return target
}

async function completeMerge(
  pending: PendingMerge,
  input: CompletionInput,
): Promise<void> {
  if (pendingMerge !== pending) {
    throw new Error('No matching agent memory snapshot merge is pending')
  }
  if (pending.completing) {
    throw new Error('Snapshot merge completion is already in progress')
  }
  pending.completing = true
  try {
    const { snapshotDir, targetDir } = getSnapshotPaths(
      pending.agentType,
      pending.scope,
    )
    const source = z
      .object({ updatedAt: z.string() })
      .safeParse(
        jsonParse(await readFile(join(snapshotDir, 'snapshot.json'), 'utf8')),
      )
    if (
      !source.success ||
      source.data.updatedAt !== pending.snapshotTimestamp
    ) {
      throw new Error(
        'The snapshot timestamp changed. Cancel this merge and re-check the update.',
      )
    }

    if (input.noChangeRequired && input.changedFiles.length > 0) {
      throw new Error('noChangeRequired=true requires changedFiles=[]')
    }
    if (!input.noChangeRequired && input.changedFiles.length === 0) {
      throw new Error('List the changed Markdown files or use noChangeRequired')
    }
    const changedNames = new Set(input.changedFiles)
    if (changedNames.size !== input.changedFiles.length) {
      throw new Error('changedFiles must not contain duplicates')
    }

    const changedPaths = new Map<string, string>()
    for (const name of changedNames) {
      changedPaths.set(name, validateChangedPath(targetDir, name))
    }
    const after = await readTargetHashes(targetDir)

    // A listed path may have been deleted. Existing paths must still be regular
    // files inside the real target; readTargetHashes rejects symlinks.
    for (const [name, path] of changedPaths) {
      const before = pending.targetHashesBefore.get(name) ?? null
      const current = after.get(name) ?? null
      if (!pending.targetHashesBefore.has(name) && !after.has(name)) {
        throw new Error(`Changed file does not exist before or after merge: ${name}`)
      }
      if (before === current) {
        throw new Error(`Listed file did not change: ${name}`)
      }
      // Resolve an existing path as an additional symlink-escape check.
      if (after.has(name)) {
        const stats = await lstat(path)
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new Error(`Changed file is not a regular file: ${name}`)
        }
      }
    }
    for (const [name, current] of after) {
      const before = pending.targetHashesBefore.get(name) ?? null
      if (before !== current && !changedNames.has(name)) {
        throw new Error(`Unreported target Markdown change: ${name}`)
      }
    }
    for (const name of pending.targetHashesBefore.keys()) {
      if (!after.has(name) && !changedNames.has(name)) {
        throw new Error(`Unreported target Markdown deletion: ${name}`)
      }
    }

    // This is deliberately the final operation. Any validation or write error
    // leaves the pending merge and existing synced metadata untouched.
    await commitSyncedMeta(
      pending.agentType,
      pending.scope,
      pending.snapshotTimestamp,
    )
    pendingMerge = null
  } finally {
    pending.completing = false
  }
}

function createCompletionTool(pending: PendingMerge): Tool {
  return buildTool({
    name: COMPLETE_AGENT_MEMORY_SNAPSHOT_MERGE,
    searchHint: 'finish validated agent memory merge',
    alwaysLoad: true,
    maxResultSizeChars: 2000,
    inputSchema: completionInputSchema,
    async description() {
      return 'Validate and complete the pending agent memory snapshot merge.'
    },
    async prompt() {
      return 'Call only after the requested Markdown merge has been completed.'
    },
    async call(input) {
      await completeMerge(pending, input)
      return { data: 'Agent memory snapshot merge completed and marked synced.' }
    },
    renderToolUseMessage() {
      return React.createElement(Text, null, 'Complete agent memory snapshot merge')
    },
    renderToolResultMessage(output: string) {
      return React.createElement(Text, { color: 'success' }, output)
    },
    mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content }
    },
  }) as Tool
}
