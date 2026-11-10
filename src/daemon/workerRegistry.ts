export async function runDaemonWorker(_kind: string | undefined): Promise<never> {
  throw new Error('Daemon workers are unavailable in this build')
}
