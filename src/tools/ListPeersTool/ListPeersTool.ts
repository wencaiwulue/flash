import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { listAllLiveSessions } from '../../utils/udsClient.js'

const inputSchema = z.strictObject({})
type InputSchema = typeof inputSchema
const outputSchema = z.object({
  peers: z.array(
    z.object({
      sessionId: z.string(),
      kind: z.string().optional(),
      socketPath: z.string(),
      pid: z.number().optional(),
    }),
  ),
})
type Output = z.infer<typeof outputSchema>

export const ListPeersTool = buildTool({
  name: 'ListPeers',
  inputSchema,
  outputSchema,
  maxResultSizeChars: 20_000,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderToolUseMessage() {
    return null
  },
  async description() {
    return 'List live local flash sessions registered over UDS'
  },
  async prompt() {
    return 'List live local peer sessions and their UDS addresses. Send a plain-text message with SendMessage(to: "uds:<sessionId>", message: "...") or SendMessage(to: "/absolute/socket/path", ...).'
  },
  async call() {
    const sessions = await listAllLiveSessions()
    return {
      data: {
        peers: sessions.map(session => ({
          sessionId: session.sessionId!,
          kind: session.kind,
          socketPath: session.socketPath,
          pid: session.pid,
        })),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content:
        output.peers.length === 0
          ? 'No live UDS peer sessions.'
          : output.peers
              .map(
                peer =>
                  `- ${peer.sessionId} (${peer.kind ?? 'unknown'}): uds:${peer.sessionId} [${peer.socketPath}]`,
              )
              .join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
