import { isReplBridgeActive } from '../bootstrap/state.js'
import { errorMessage } from '../utils/errors.js'
import { formatCrossSessionMessage } from './crossSessionMessages.js'
import { sendEventToRemoteSession } from '../utils/teleport/api.js'
import {
  getReplBridgeHandle,
  getSelfBridgeCompatId,
} from './replBridgeHandle.js'
import { toCompatSessionId } from './sessionIdCompat.js'

const MAX_PEER_MESSAGE_BYTES = 64 * 1024
const SESSION_ID_PATTERN = /^session_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export type PeerPostResult =
  | { ok: true }
  | { ok: false; error: string }

type PeerSessionDependencies = {
  getHandle: typeof getReplBridgeHandle
  getSelfId: typeof getSelfBridgeCompatId
  isActive: typeof isReplBridgeActive
  send: typeof sendEventToRemoteSession
}

const defaultDependencies: PeerSessionDependencies = {
  getHandle: getReplBridgeHandle,
  getSelfId: getSelfBridgeCompatId,
  isActive: isReplBridgeActive,
  send: sendEventToRemoteSession,
}

export function encodeCrossSessionMessage(
  message: string,
  from: string,
): string {
  return formatCrossSessionMessage({
    from,
    transport: 'sessions-v1',
    text: message,
  })
}

export async function postInterClaudeMessage(
  target: string,
  message: string,
  injectedDependencies: Partial<PeerSessionDependencies> = {},
): Promise<PeerPostResult> {
  const dependencies = { ...defaultDependencies, ...injectedDependencies }
  if (!dependencies.getHandle() || !dependencies.isActive()) {
    return { ok: false, error: 'Remote Control is not connected' }
  }

  const self = dependencies.getSelfId()
  if (!self) {
    return { ok: false, error: 'Unable to determine the local bridge session' }
  }
  if (target.length === 0 || target !== target.trim()) {
    return { ok: false, error: 'Invalid bridge session ID' }
  }

  const compatTarget = toCompatSessionId(target)
  if (!SESSION_ID_PATTERN.test(compatTarget)) {
    return { ok: false, error: 'Invalid bridge session ID' }
  }
  if (compatTarget === self) {
    return { ok: false, error: 'Cannot send a peer message to this session' }
  }
  if (
    message.length === 0 ||
    Buffer.byteLength(message, 'utf8') > MAX_PEER_MESSAGE_BYTES
  ) {
    return { ok: false, error: 'Peer message is empty or too large' }
  }

  const content = encodeCrossSessionMessage(message, `bridge:${self}`)
  try {
    const accepted = await dependencies.send(compatTarget, content)
    return accepted
      ? { ok: true }
      : { ok: false, error: 'Sessions API rejected the peer event' }
  } catch (error) {
    return {
      ok: false,
      error: `Unable to send the peer event: ${errorMessage(error)}`,
    }
  }
}
