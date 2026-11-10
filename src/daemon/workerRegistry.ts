import {
  startRemoteControlServer,
  waitForRemoteControlServer,
} from '../commands/remoteControlServer/server.js'

export async function runDaemonWorker(
  kind: string | undefined,
  dependencies: {
    start?: typeof startRemoteControlServer
    wait?: typeof waitForRemoteControlServer
  } = {},
): Promise<void> {
  switch (kind) {
    case 'assistant':
    case 'remote-control':
      await (dependencies.start ?? startRemoteControlServer)()
      await (dependencies.wait ?? waitForRemoteControlServer)()
      return
    case undefined:
      throw new Error('Missing daemon worker kind')
    default:
      throw new Error(`Unknown daemon worker kind: ${kind}`)
  }
}
