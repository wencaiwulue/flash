import React, { useState } from 'react'
import { setOriginalCwd } from '../../bootstrap/state.js'
import { TeleportRepoMismatchDialog } from '../../components/TeleportRepoMismatchDialog.js'
import { TeleportResumeWrapper } from '../../components/TeleportResumeWrapper.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { TeleportRemoteResponse } from '../../utils/conversationRecovery.js'
import { getCwd } from '../../utils/cwd.js'
import { setCwd } from '../../utils/Shell.js'
import { errorMessage } from '../../utils/errors.js'
import {
  filterExistingPaths,
  getKnownPathsForRepo,
} from '../../utils/githubRepoPathMapping.js'
import {
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
  type RepoValidationResult,
  validateGitState,
  validateSessionRepository,
} from '../../utils/teleport.js'
import { fetchSession } from '../../utils/teleport/api.js'

export async function restoreDownloadedSession(
  result: TeleportRemoteResponse,
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: Parameters<LocalJSXCommandCall>[0],
): Promise<void> {
  try {
    // Never stash, clean, or reset user work. A dirty tree stops before checkout.
    await validateGitState()
    const { branchError } = await checkOutTeleportedSessionBranch(result.branch)
    const messages = processMessagesForTeleportResume(result.log, branchError)
    context.setMessages(() => messages)
    onDone(
      branchError
        ? `Session restored, but its branch could not be checked out: ${branchError.message}`
        : `Session restored in ${getCwd()}.`,
      { display: 'skip' },
    )
  } catch (error) {
    onDone(
      `Teleport cancelled before checkout. Existing workspace changes were preserved: ${errorMessage(error)}`,
    )
  }
}

function DirectTeleport({
  session,
  validation,
  existingPaths,
  context,
  onDone,
}: {
  session: Awaited<ReturnType<typeof fetchSession>>
  validation: RepoValidationResult
  existingPaths: string[]
  context: Parameters<LocalJSXCommandCall>[1]
  onDone: Parameters<LocalJSXCommandCall>[0]
}): React.ReactNode {
  const [pathSelected, setPathSelected] = useState(false)
  const needsRepoSelection =
    validation.status === 'mismatch' || validation.status === 'not_in_repo'

  if (needsRepoSelection && !pathSelected) {
    return (
      <TeleportRepoMismatchDialog
        targetRepo={validation.sessionRepo ?? 'the session repository'}
        initialPaths={existingPaths}
        onSelectPath={path => {
          process.chdir(path)
          setCwd(path)
          setOriginalCwd(path)
          setPathSelected(true)
        }}
        onCancel={() =>
          onDone('Teleport cancelled. The current workspace was not changed.')
        }
      />
    )
  }

  return (
    <TeleportResumeWrapper
      initialSession={session}
      source="localCommand"
      onComplete={result =>
        void restoreDownloadedSession(result, context, onDone)
      }
      onCancel={() => onDone('Teleport cancelled. No session was restored.')}
      onError={message => onDone(`Teleport failed: ${message}`)}
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const sessionId = args.trim()
  if (sessionId && /\s/.test(sessionId)) {
    onDone('Usage: /teleport [session-id]')
    return null
  }

  if (!sessionId) {
    return (
      <TeleportResumeWrapper
        source="localCommand"
        onComplete={result =>
          void restoreDownloadedSession(result, context, onDone)
        }
        onCancel={() => onDone('Teleport cancelled. No session was restored.')}
        onError={message => onDone(`Teleport failed: ${message}`)}
      />
    )
  }

  try {
    const session = await fetchSession(sessionId)
    const validation = await validateSessionRepository(session)
    if (validation.status === 'error') {
      onDone(validation.errorMessage ?? 'Failed to validate the session repository.')
      return null
    }

    let existingPaths: string[] = []
    if (
      validation.status === 'mismatch' ||
      validation.status === 'not_in_repo'
    ) {
      if (!validation.sessionRepo) {
        onDone('Unable to determine the repository required by this session.')
        return null
      }
      existingPaths = await filterExistingPaths(
        getKnownPathsForRepo(validation.sessionRepo),
      )
      if (existingPaths.length === 0) {
        onDone(
          `Run /teleport ${sessionId} from a checkout of ${validation.sessionRepo}. The current workspace was not changed.`,
        )
        return null
      }
    }

    return (
      <DirectTeleport
        session={session}
        validation={validation}
        existingPaths={existingPaths}
        context={context}
        onDone={onDone}
      />
    )
  } catch (error) {
    onDone(`Teleport failed before workspace changes: ${errorMessage(error)}`)
    return null
  }
}
