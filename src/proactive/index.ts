export type ProactiveUnsubscribe = () => void

type ProactiveControlState = Readonly<{
  active: boolean
  paused: boolean
  contextBlocked: boolean
}>

let controlState: ProactiveControlState = {
  active: false,
  paused: false,
  contextBlocked: false,
}
let nextTickAt: number | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function setControlState(next: ProactiveControlState): void {
  controlState = next
  notify()
}

export function isProactiveActive(): boolean {
  return controlState.active
}

export function isProactivePaused(): boolean {
  return controlState.paused
}

export function isProactiveContextBlocked(): boolean {
  return controlState.contextBlocked
}

export function getProactiveControlState(): ProactiveControlState {
  return controlState
}

export function getNextTickAt(): number | null {
  return nextTickAt
}

export function setProactiveNextTickAt(value: number | null): void {
  if (nextTickAt === value) return
  nextTickAt = value
  notify()
}

export function subscribeToProactiveChanges(
  listener: () => void,
): ProactiveUnsubscribe {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function activateProactive(_source: 'command'): boolean {
  if (controlState.active) return false
  nextTickAt = null
  setControlState({ active: true, paused: false, contextBlocked: false })
  return true
}

export function deactivateProactive(): boolean {
  if (!controlState.active) return false
  nextTickAt = null
  setControlState({ active: false, paused: false, contextBlocked: false })
  return true
}

export function pauseProactive(): boolean {
  if (!controlState.active || controlState.paused) return false
  nextTickAt = null
  setControlState({ ...controlState, paused: true })
  return true
}

export function resumeProactive(): boolean {
  if (!controlState.active || !controlState.paused) return false
  setControlState({ ...controlState, paused: false })
  return true
}

export function setContextBlocked(blocked: boolean): boolean {
  if (!controlState.active || controlState.contextBlocked === blocked) {
    return false
  }
  if (blocked) nextTickAt = null
  setControlState({ ...controlState, contextBlocked: blocked })
  return true
}
