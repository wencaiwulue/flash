export type ServerLogger = {
  debug: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

function write(level: string, message: string): void {
  process.stderr.write(`[claude-server] ${level}: ${message}\n`)
}

export function createServerLogger(): ServerLogger {
  return {
    debug: message => write('debug', message),
    info: message => write('info', message),
    warn: message => write('warn', message),
    error: message => write('error', message),
  }
}
