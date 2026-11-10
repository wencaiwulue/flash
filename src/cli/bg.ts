function unavailable(): never {
  throw new Error('Background session management is unavailable in this build')
}

export async function psHandler(_args: string[]): Promise<never> {
  unavailable()
}

export async function logsHandler(_sessionId: string | undefined): Promise<never> {
  unavailable()
}

export async function attachHandler(
  _sessionId: string | undefined,
): Promise<never> {
  unavailable()
}

export async function killHandler(_sessionId: string | undefined): Promise<never> {
  unavailable()
}

export async function handleBgFlag(_args: string[]): Promise<never> {
  unavailable()
}
