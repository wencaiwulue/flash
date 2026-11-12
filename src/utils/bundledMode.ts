import { resolve } from 'node:path'

/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * Bun.embeddedFiles only includes explicit assets, so also check for the
 * virtual filesystem entrypoint used by asset-free compiled binaries.
 */
export function isInBundledMode(
  mainPath = typeof Bun !== 'undefined' ? Bun.main : undefined,
): boolean {
  return (
    (typeof Bun !== 'undefined' &&
      Array.isArray(Bun.embeddedFiles) &&
      Bun.embeddedFiles.length > 0) ||
    mainPath?.startsWith('/$bunfs/') === true ||
    /^[A-Za-z]:[\\/]~BUN[\\/]/.test(mainPath ?? '')
  )
}

/**
 * Returns the args that must precede CLI flags when spawning a child claude
 * process. In compiled binaries, process.execPath is the claude binary itself
 * and args go directly to it. In npm installs (node running cli.js),
 * process.execPath is the node runtime — the child spawn must pass the script
 * path as the first arg, otherwise node interprets --sdk-url as a node option
 * and exits with "bad option: --sdk-url". See anthropics/claude-code#28334.
 */
export function spawnScriptArgs(
  scriptPath = process.argv[1],
  bundled = isInBundledMode(),
): string[] {
  if (bundled) return []
  if (!scriptPath) {
    throw new Error(
      'Cannot locate the CLI entrypoint: process.argv[1] is missing outside bundled mode',
    )
  }
  return [resolve(scriptPath)]
}
