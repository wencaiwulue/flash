import type { ServerConfig } from './types.js'

export function printBanner(
  _config: ServerConfig,
  _authToken: string,
  _actualPort: number,
): never {
  throw new Error('The direct-connect server is unavailable in this build')
}
