import type { ServerConfig } from './types.js'

/** Print the bearer credential once, directly to the invoking terminal. */
export function printBanner(
  config: ServerConfig,
  authToken: string,
  actualPort: number,
): void {
  const token = encodeURIComponent(authToken)
  const host = config.host.includes(':') ? `[${config.host}]` : config.host
  const url = config.unix
    ? `cc+unix://${config.unix}?token=${token}`
    : `cc://${host}:${actualPort}?token=${token}`
  process.stderr.write(
    `\nflash Direct Connect (${'direct-connect-v1'})\n` +
      `Listening: ${config.unix ?? `${config.host}:${actualPort}`}\n` +
      `Connect: ${url}\n` +
      'Keep this URL private. cc:// uses HTTP; use a TLS boundary off-loopback.\n\n',
  )
}
