export type CrossSessionTransport = 'sessions-v1' | 'uds'

export type CrossSessionMessage = {
  from: string
  transport: CrossSessionTransport
  text: string
}

const WRAPPER_PATTERN = /^<cross-session-message from="([^"]*)" transport="([^"]*)">\n([\s\S]*)\n<\/cross-session-message>$/
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const UNESCAPES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
}

function escapeCrossSessionValue(value: string): string {
  return value.replace(/[&<>"']/g, char => ESCAPES[char]!)
}

function decodeCrossSessionValue(value: string): string | undefined {
  const decoded = value.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, entity: string) => UNESCAPES[entity]!,
  )
  return escapeCrossSessionValue(decoded) === value ? decoded : undefined
}

function validAddress(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    (value.startsWith('bridge:') || value.startsWith('uds:')) &&
    ![...value].some(char => char.charCodeAt(0) < 32)
  )
}

export function formatCrossSessionMessage(message: CrossSessionMessage): string {
  if (
    !validAddress(message.from) ||
    (message.transport !== 'sessions-v1' && message.transport !== 'uds') ||
    typeof message.text !== 'string' ||
    message.text.trim().length === 0 ||
    message.text.length > 1_000_000
  ) {
    throw new Error('invalid_cross_session_message')
  }
  return `<cross-session-message from="${escapeCrossSessionValue(message.from)}" transport="${message.transport}">\n${escapeCrossSessionValue(message.text)}\n</cross-session-message>`
}

export function parseCrossSessionMessage(
  value: string,
): CrossSessionMessage | undefined {
  const match = WRAPPER_PATTERN.exec(value)
  if (!match) return undefined
  const from = decodeCrossSessionValue(match[1]!)
  const transport = decodeCrossSessionValue(match[2]!)
  const text = decodeCrossSessionValue(match[3]!)
  if (
    from === undefined ||
    !validAddress(from) ||
    (transport !== 'sessions-v1' && transport !== 'uds') ||
    text === undefined ||
    text.trim().length === 0 ||
    text.length > 1_000_000
  ) {
    return undefined
  }
  return { from, transport, text }
}
