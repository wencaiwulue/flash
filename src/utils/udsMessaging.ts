export function getDefaultUdsSocketPath(): never {
  throw new Error('UDS messaging is unavailable in this build')
}

export function getUdsMessagingSocketPath(): string | undefined {
  return undefined
}

export async function startUdsMessaging(
  _socketPath: string,
  _options: { isExplicit: boolean },
): Promise<never> {
  throw new Error('UDS messaging is unavailable in this build')
}

export function setOnEnqueue(_callback: () => void): boolean {
  return false
}
