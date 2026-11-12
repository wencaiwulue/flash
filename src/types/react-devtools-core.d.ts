declare module 'react-devtools-core' {
  import type WebSocket from 'ws'

  export function connectToDevTools(options?: {
    host?: string
    port?: number
    websocket?: WebSocket
    retryConnectionDelay?: number
    useHttps?: boolean
    isAppActive?: () => boolean
  }): void
}
