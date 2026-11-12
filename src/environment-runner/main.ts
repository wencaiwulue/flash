import { openRunnerMain } from '../open-runner/main.js'

/** Public environment-runner entry using only explicit Open Runner options. */
export async function environmentRunnerMain(args: string[]): Promise<never> {
  await openRunnerMain(['run', ...args])
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(process.exitCode ?? 0)
}
