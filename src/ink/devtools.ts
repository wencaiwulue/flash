import { connectToDevTools as connect } from 'react-devtools-core'
import WebSocket from 'ws'
import { logForDebugging } from '../utils/debug.js'

const DEVTOOLS_HOST = 'localhost'
const DEVTOOLS_PORT = 8097

/** Connect Ink's renderer to a standalone React DevTools UI in development. */
export function connectToDevTools(): void {
  // Bun.build defaults NODE_ENV to development while bundling. Read the key
  // dynamically so a production artifact retains the actual runtime guard
  // instead of opening a DevTools socket during unrelated CLI fast paths.
  if (process.env[['NODE', 'ENV'].join('_')] !== 'development') {
    return
  }

  const endpoint = `ws://${DEVTOOLS_HOST}:${DEVTOOLS_PORT}`
  try {
    const websocket = new WebSocket(endpoint)
    websocket.once('error', () => {
      // Keep connection failures out of the terminal frame. The debug log has
      // an actionable remedy while react-devtools-core continues its retry.
      logForDebugging(
        `React DevTools could not connect to ${endpoint}. Start the UI with ` +
          '`npx react-devtools` and keep its default port (8097), then restart Claude Code.',
        { level: 'warn' },
      )
    })
    connect({
      websocket,
      retryConnectionDelay: 2000,
    })
  } catch (error) {
    logForDebugging(
      `React DevTools initialization failed for ${endpoint}: ${
        error instanceof Error ? error.message : String(error)
      }. Start the UI with \`npx react-devtools\` and restart Claude Code.`,
      { level: 'warn' },
    )
  }
}
