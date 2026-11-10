export async function environmentRunnerMain(_args: string[]): Promise<never> {
  throw new Error('The environment runner is unavailable in this build')
}
