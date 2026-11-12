import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getPlatform } from '../../utils/platform.js'
import { getClaudeSocketName } from '../../utils/tmuxSocket.js'

export type TmuxResult = { stdout: string; stderr: string; code: number }

/** Execute tmux with argv isolation. Callers never supply -L or a socket. */
export async function execTmuxCommand(
  args: string[],
  options: { cwd?: string } = {},
): Promise<TmuxResult> {
  const argv = ['-L', getClaudeSocketName(), ...args]
  const result =
    getPlatform() === 'windows'
      ? await execFileNoThrow('wsl', ['-e', 'tmux', ...argv], {
          env: { ...process.env, WSL_UTF8: '1' },
          useCwd: options.cwd !== undefined,
        })
      : await execFileNoThrow('tmux', argv, {
          useCwd: options.cwd !== undefined,
        })
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.code,
  }
}

export type TungstenSession = {
  name: string
  windows: number
  attached: boolean
}

export async function listTungstenSessions(): Promise<TungstenSession[]> {
  const result = await execTmuxCommand([
    'list-sessions',
    '-F',
    '#{session_name}\t#{session_windows}\t#{session_attached}',
  ])
  if (result.code !== 0) {
    throw new Error(`tmux list-sessions failed: ${result.stderr || `exit ${result.code}`}`)
  }
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, windows, attached] = line.split('\t')
      if (!name) throw new Error('tmux returned a session without a name.')
      return {
        name,
        windows: Number.parseInt(windows || '0', 10) || 0,
        attached: Number(attached) > 0,
      }
    })
}

export async function captureTungstenSession(
  name: string,
  lines: number,
): Promise<string> {
  const result = await execTmuxCommand([
    'capture-pane',
    '-p',
    '-t',
    name,
    '-S',
    `-${lines}`,
  ])
  if (result.code !== 0) {
    throw new Error(`tmux capture-pane failed for ${name}: ${result.stderr || `exit ${result.code}`}`)
  }
  return result.stdout
}

export async function getTungstenActiveCommand(name: string): Promise<string> {
  const result = await execTmuxCommand([
    'display-message',
    '-p',
    '-t',
    name,
    '#{pane_current_command}',
  ])
  if (result.code !== 0) {
    throw new Error(`tmux display-message failed for ${name}: ${result.stderr || `exit ${result.code}`}`)
  }
  return result.stdout.trim()
}
