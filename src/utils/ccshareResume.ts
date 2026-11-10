import type { LogOption } from '../types/logs.js'

export function parseCcshareId(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'go') return null
  const match = /^\/ccshare\/([A-Za-z0-9._-]+)\/?$/.exec(url.pathname)
  return match?.[1] ?? null
}

export async function loadCcshare(_id: string): Promise<LogOption> {
  throw new Error('ccshare resume is unavailable in this build')
}
