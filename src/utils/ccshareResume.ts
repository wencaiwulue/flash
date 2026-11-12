import { randomBytes } from 'crypto'
import { createInterface } from 'readline/promises'
import { lstat, mkdir, open, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import type { LogOption } from '../types/logs.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { loadTranscriptFromFile } from './sessionStorage.js'

const DEFAULT_ORIGIN = 'https://go'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_LINES = 20_000
const MAX_REDIRECTS = 5
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type CcshareLoadOptions = {
  timeoutMs?: number
  maxBytes?: number
  maxLines?: number
  /** Called only when a redirect changes origin. Returning false aborts. */
  confirmCrossOrigin?: (from: URL, to: URL) => Promise<boolean>
}

function configuredOrigin(): URL {
  const raw = process.env.CLAUDE_CODE_CCSHARE_ORIGIN || DEFAULT_ORIGIN
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('CLAUDE_CODE_CCSHARE_ORIGIN must be a valid HTTPS origin.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (raw === DEFAULT_ORIGIN && url.port && url.port !== '443')
  ) {
    throw new Error(
      'The ccshare origin must be HTTPS and contain no path, credentials, query, or fragment.',
    )
  }
  return url
}

function validId(id: string | undefined): id is string {
  return Boolean(
    id && ID_PATTERN.test(id) && id !== '.' && id !== '..',
  )
}

export function parseCcshareId(value: string): string | null {
  let url: URL
  let origin: URL
  try {
    url = new URL(value)
    origin = configuredOrigin()
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== origin.origin
  ) {
    return null
  }
  const match = /^\/ccshare\/([A-Za-z0-9._-]+)\/?$/.exec(url.pathname)
  return validId(match?.[1]) ? match[1] : null
}

async function defaultCrossOriginConfirmation(from: URL, to: URL): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(
      `ccshare redirect changes origin from ${from.origin} to ${to.origin}. Continue without Authorization? [y/N] `,
    )
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    prompt.close()
  }
}

async function readCredential(): Promise<string | undefined> {
  const path =
    process.env.CLAUDE_CODE_CCSHARE_TOKEN_FILE ||
    join(getClaudeConfigHomeDir(), 'ccshare-credentials.json')
  let info
  try {
    info = await lstat(path)
  } catch {
    return undefined
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('The ccshare credential must be a regular, non-symlink file.')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('The ccshare credential file must have mode 0600.')
  }
  if (info.size > 4096) throw new Error('The ccshare credential file is too large.')
  const raw = await readFile(path, 'utf8')
  let token: unknown
  try {
    token = (JSON.parse(raw) as { token?: unknown }).token
  } catch {
    throw new Error('The ccshare credential file is not valid JSON.')
  }
  if (token !== undefined && (typeof token !== 'string' || !token.trim())) {
    throw new Error('The ccshare credential token must be a non-empty string.')
  }
  return typeof token === 'string' ? token.trim() : undefined
}

function contentTypeIsJsonl(response: Response): boolean {
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return type === 'application/x-ndjson' || type === 'application/jsonl'
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The next request must still proceed if a redirect body was already closed.
  }
}

async function fetchTranscript(
  id: string,
  options: CcshareLoadOptions,
): Promise<{ response: Response; signal: AbortSignal; cleanup: () => void }> {
  const origin = configuredOrigin()
  let current = new URL(`/ccshare/${encodeURIComponent(id)}`, origin)
  const token = await readCredential()
  let sendAuthorization = Boolean(token)
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid ccshare timeout.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let completed = false
  try {
    for (let redirects = 0; ; redirects++) {
      if (redirects > MAX_REDIRECTS) throw new Error('Too many ccshare redirects.')
      let response: Response
      try {
        response = await fetch(current, {
          method: 'GET',
          headers: {
            Accept: 'application/x-ndjson, application/jsonl',
            ...(sendAuthorization && token ? { Authorization: `Bearer ${token}` } : {}),
          },
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw new Error('ccshare download timed out.')
        throw error
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) {
          await discardResponse(response)
          throw new Error('ccshare redirect has no Location header.')
        }
        const next = new URL(location, current)
        await discardResponse(response)
        if (next.protocol !== 'https:' || next.username || next.password) {
          throw new Error('ccshare redirects must use HTTPS without userinfo.')
        }
        if (next.origin !== current.origin) {
          const confirm = options.confirmCrossOrigin ?? defaultCrossOriginConfirmation
          if (!(await confirm(current, next))) {
            throw new Error('Cross-origin ccshare redirect was not confirmed.')
          }
          // Credentials are never restored later in this redirect chain, even if
          // it eventually points back to the initial origin.
          sendAuthorization = false
        }
        current = next
        continue
      }
      if (!response.ok) {
        await discardResponse(response)
        throw new Error(`ccshare download failed with HTTP ${response.status}.`)
      }
      if (!contentTypeIsJsonl(response)) {
        await discardResponse(response)
        throw new Error('ccshare response must have a JSONL content type.')
      }
      completed = true
      return {
        response,
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
      }
    }
  } finally {
    if (!completed) clearTimeout(timer)
  }
}

async function writeBoundedResponse(
  response: Response,
  path: string,
  maxBytes: number,
  maxLines: number,
): Promise<void> {
  if (!response.body) throw new Error('ccshare response has no body.')
  const handle = await open(path, 'wx', 0o600)
  let bytes = 0
  let lines = 0
  try {
    for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value)
      bytes += chunk.length
      if (bytes > maxBytes) throw new Error(`ccshare transcript exceeds ${maxBytes} bytes.`)
      for (const byte of chunk) if (byte === 10) lines++
      if (lines > maxLines) throw new Error(`ccshare transcript exceeds ${maxLines} lines.`)
      await handle.write(chunk)
    }
    if (bytes > 0 && lines >= maxLines) {
      // A final unterminated record still counts as a JSONL record.
      const tail = Buffer.alloc(1)
      const { bytesRead } = await handle.read(tail, 0, 1, bytes - 1)
      if (bytesRead === 1 && tail[0] !== 10) lines++
      if (lines > maxLines) throw new Error(`ccshare transcript exceeds ${maxLines} lines.`)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function loadCcshare(
  id: string,
  options: CcshareLoadOptions = {},
): Promise<LogOption> {
  if (!validId(id)) throw new Error('Invalid ccshare id.')
  const directory = join(getClaudeConfigHomeDir(), 'tmp')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('ccshare temporary directory must be a real directory.')
  }
  const download = await fetchTranscript(id, options)
  const path = join(directory, `ccshare-${randomBytes(16).toString('hex')}.jsonl`)
  try {
    await writeBoundedResponse(
      download.response,
      path,
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      options.maxLines ?? DEFAULT_MAX_LINES,
    )
    const log = await loadTranscriptFromFile(path)
    // A share is untrusted data. Preserve transcript timestamps and messages,
    // but never use its claimed project path as a local working directory.
    return { ...log, projectPath: undefined }
  } catch (error) {
    await unlink(path).catch(() => {})
    if (download.signal.aborted) throw new Error('ccshare download timed out.')
    throw error
  } finally {
    download.cleanup()
    await discardResponse(download.response)
  }
}
