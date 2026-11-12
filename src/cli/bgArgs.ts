const OPTIONS_WITH_VALUES = new Set([
  '--session-id',
  '--name',
  '--model',
  '--fallback-model',
  '--settings',
  '--setting-sources',
  '--mcp-config',
  '--permission-mode',
  '--add-dir',
  '--plugin-dir',
  '--agents',
  '--agent',
  '--betas',
  '--debug',
  '--debug-file',
  '--system-prompt',
  '--append-system-prompt',
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--permission-prompt-tool',
  '--output-format',
  '--input-format',
  '--max-turns',
  '--max-budget-usd',
  '--resume',
  '--continue',
  '--fork-session',
  '--ide',
  '--channels',
  '--worktree',
  '-w',
  '-c',
  '-r',
  '-p',
  '--print',
  '--prompt',
])

const OPTIONAL_VALUES = new Set(['-c', '--continue', '-p', '--print'])

/** Only actual CLI flags count; option values and everything after -- are opaque. */
export function stripBackgroundFlags(args: string[]): {
  args: string[]
  background: boolean
} {
  const result: string[] = []
  let background = false
  let options = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (options && arg === '--') {
      options = false
      result.push(arg)
      continue
    }
    if (options && (arg === '--bg' || arg === '--background')) {
      background = true
      continue
    }
    result.push(arg)
    if (
      options &&
      OPTIONS_WITH_VALUES.has(arg) &&
      index + 1 < args.length &&
      !(OPTIONAL_VALUES.has(arg) && args[index + 1].startsWith('-'))
    ) {
      result.push(args[++index])
    }
  }
  return { args: result, background }
}

export function hasBackgroundFlag(args: string[]): boolean {
  return stripBackgroundFlags(args).background
}
