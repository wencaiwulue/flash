export function isAssistantMode(): boolean {
  return false
}

export function isAssistantForced(): boolean {
  return false
}

export function markAssistantForced(): boolean {
  return false
}

export function getAssistantActivationPath(): string | undefined {
  return undefined
}

export function getAssistantSystemPromptAddendum(): string {
  return ''
}

export async function initializeAssistantTeam(): Promise<never> {
  throw new Error('Assistant teams are unavailable in this build')
}
