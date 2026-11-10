import type { DirectConnectConfig } from './directConnectManager.js'

export async function runConnectHeadless(
  _config: DirectConnectConfig,
  _prompt: string,
  _outputFormat: string,
  _interactive: boolean,
): Promise<never> {
  throw new Error('Headless direct-connect is unavailable in this build')
}
