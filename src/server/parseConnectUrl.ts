export type ParsedConnectUrl = {
  serverUrl: string
  authToken?: string
}

/** Parse a cc:// or cc+unix:// direct-connect URL. */
export function parseConnectUrl(input: string): ParsedConnectUrl {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('Invalid flash connect URL')
  }

  if (url.protocol !== 'cc:' && url.protocol !== 'cc+unix:') {
    throw new Error('Connect URL must use cc:// or cc+unix://')
  }

  const authToken =
    process.env.CLAUDE_DIRECT_CONNECT_TOKEN ??
    url.searchParams.get('token') ??
    url.searchParams.get('auth_token') ??
    undefined

  if (url.protocol === 'cc+unix:') {
    const socketPath = `${url.host}${url.pathname}`
    if (!socketPath.startsWith('/') || socketPath === '/') {
      throw new Error('A cc+unix URL must include an absolute socket path')
    }
    return { serverUrl: `http://unix${socketPath}`, authToken }
  }

  if (!url.host) {
    throw new Error('A cc URL must include a server host')
  }
  const httpUrl = new URL(url.href.replace(/^cc:/, 'http:'))
  httpUrl.username = ''
  httpUrl.password = ''
  httpUrl.search = ''
  httpUrl.hash = ''
  httpUrl.pathname = httpUrl.pathname.replace(/\/+$/, '')
  return { serverUrl: httpUrl.toString().replace(/\/$/, ''), authToken }
}
