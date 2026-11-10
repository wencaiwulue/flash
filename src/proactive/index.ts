export type ProactiveUnsubscribe = () => void

/** Proactive mode is disabled at this external feature boundary. */
export function isProactiveActive(): boolean {
  return false
}

export function isProactivePaused(): boolean {
  return false
}

export function getNextTickAt(): number | null {
  return null
}

export function subscribeToProactiveChanges(
  _listener: () => void,
): ProactiveUnsubscribe {
  return () => {}
}

export function activateProactive(_source: 'command'): boolean {
  return false
}

export function deactivateProactive(): boolean {
  return false
}

export function pauseProactive(): boolean {
  return false
}

export function resumeProactive(): boolean {
  return false
}

export function setContextBlocked(_blocked: boolean): boolean {
  return false
}
