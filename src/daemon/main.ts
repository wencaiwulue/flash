export async function daemonMain(_args: string[]): Promise<never> {
  throw new Error('The daemon is unavailable in this build')
}
