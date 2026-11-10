export type AssistantSession = {
  id: string
  title?: string
  machineName?: string
  cwd?: string
  branch?: string
  lastActiveAt?: number
}

/** No assistant discovery backend is bundled in this build. */
export async function discoverAssistantSessions(): Promise<AssistantSession[]> {
  return []
}
