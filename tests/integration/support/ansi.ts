// ANSI escape sequences: CSI (...final byte @-~), OSC (BEL or ST terminated),
// and standalone two-byte escapes. Covers Ink/React output rendering.
const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '')
}
