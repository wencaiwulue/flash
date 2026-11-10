import type { Command, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getRemoteControlServerInfo,
  startRemoteControlServer,
} from './server.js'

async function call(onDone: LocalJSXCommandOnDone): Promise<null> {
  try {
    const info = getRemoteControlServerInfo() ?? (await startRemoteControlServer())
    onDone(`Remote Control server running: ${info.session_url}`)
  } catch (error) {
    onDone(
      `Failed to start Remote Control server: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return null
}

export default {
  type: 'local-jsx',
  name: 'remote-control-server',
  description: 'Start or show the local Remote Control server',
  availability: ['claude-ai'],
  isEnabled: () => true,
  load: () => Promise.resolve({ call }),
} satisfies Command
