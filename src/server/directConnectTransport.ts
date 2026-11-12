/** Internal transport boundary for the logical http://unix<path> server URL. */
export function getUnixSocketPath(serverUrl: string): string | undefined {
  if (!serverUrl.startsWith('http://unix/')) return undefined
  const socketPath = serverUrl.slice('http://unix'.length)
  return socketPath.startsWith('/') ? socketPath : undefined
}

export function directConnectHttpUrl(serverUrl: string, path: string): string {
  const base = getUnixSocketPath(serverUrl) ? 'http://localhost' : serverUrl
  return `${base}${path}`
}

export function directConnectFetchOptions(serverUrl: string): RequestInit {
  const unix = getUnixSocketPath(serverUrl)
  return unix ? ({ unix } as unknown as RequestInit) : {}
}

export function directConnectWebSocketUrl(config: {
  serverUrl: string
  wsUrl: string
  after?: number
}): { url: string; options: { headers: Record<string, string>; unix?: string } } {
  const unix = getUnixSocketPath(config.serverUrl)
  const logical = new URL(
    config.wsUrl.replace(/^ws:\/\/unix\//, 'ws://localhost/'),
  )
  if (config.after !== undefined && config.after > 0) {
    logical.searchParams.set('after', String(config.after))
  }
  return {
    url: unix ? logical.toString() : logical.toString(),
    options: {
      headers: {},
      ...(unix ? { unix } : {}),
    },
  }
}
