export type UdsLiveSession = {
  kind?: string
  sessionId?: string
}

/** No UDS registry is available in this build. */
export async function listAllLiveSessions(): Promise<UdsLiveSession[]> {
  return []
}

export async function sendToUdsSocket(
  _socketPath: string,
  _message: string,
): Promise<never> {
  throw new Error('UDS messaging is unavailable in this build')
}
