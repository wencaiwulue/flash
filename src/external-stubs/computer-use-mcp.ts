import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp/server'
import { MUTATING_TOOLS } from '@zavora-ai/computer-use-mcp/tool-catalog'
import type {
  ComputerUseCapabilities,
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  ComputerUseTool,
  CoordinateMode,
  CuCallToolResult,
  CuGrantFlags,
} from './computer-use-types.js'

export * from './computer-use-types.js'

export type ImageResizeParams = {
  maxWidth: number
  maxHeight: number
  maxPixels: number
}

export const API_RESIZE_PARAMS: Readonly<ImageResizeParams> = Object.freeze({
  maxWidth: 1568,
  maxHeight: 1568,
  maxPixels: 1_150_000,
})

export function targetImageSize(
  width: number,
  height: number,
  params: ImageResizeParams,
): [number, number] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError('Image dimensions must be finite positive numbers')
  }
  const scale = Math.min(
    1,
    params.maxWidth / width,
    params.maxHeight / height,
    Math.sqrt(params.maxPixels / (width * height)),
  )
  return [Math.round(width * scale), Math.round(height * scale)]
}

let clientPromise: Promise<Client> | undefined

async function connectClient(): Promise<Client> {
  const server = createComputerUseServer({ profile: 'desktop' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'flash-computer-use', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

export function getOpenComputerUseClient(): Promise<Client> {
  clientPromise ??= connectClient().catch(error => {
    clientPromise = undefined
    throw error
  })
  return clientPromise
}

export async function closeOpenComputerUseClient(): Promise<void> {
  const pending = clientPromise
  clientPromise = undefined
  if (pending) await (await pending).close()
}

export async function listOpenComputerUseTools(): Promise<ComputerUseTool[]> {
  const client = await getOpenComputerUseClient()
  const result = await client.listTools()
  return result.tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }))
}

export function buildComputerUseTools(
  _capabilities: ComputerUseCapabilities,
  _coordinateMode: CoordinateMode,
  _installedAppNames?: string[],
): ComputerUseTool[] {
  // Compatibility for synchronous callers. Real setup uses listOpenComputerUseTools
  // so descriptions and schemas come directly from the open MCP server.
  return Array.from(MUTATING_TOOLS).map(name => ({
    name,
    description: `Computer Use action: ${name}`,
    inputSchema: { type: 'object', additionalProperties: true },
  }))
}

export function createComputerUseMcpServer(
  _adapter: ComputerUseHostAdapter,
  _coordinateMode: CoordinateMode,
): Server {
  return createComputerUseServer({ profile: 'desktop' }) as unknown as Server
}

function requiredFlags(name: string): Partial<CuGrantFlags> {
  if (name === 'read_clipboard') return { clipboardRead: true }
  if (name === 'write_clipboard') return { clipboardWrite: true }
  if (name === 'key' || name === 'hold_key') return { systemKeyCombos: true }
  return {}
}

export function bindSessionContext(
  _adapter: ComputerUseHostAdapter,
  _coordinateMode: CoordinateMode,
  context: ComputerUseSessionContext,
): (name: string, args: unknown) => Promise<CuCallToolResult> {
  return async (name, args) => {
    const client = await getOpenComputerUseClient()
    if (MUTATING_TOOLS.has(name)) {
      const currentFlags = context.getGrantFlags()
      const needed = requiredFlags(name)
      const missing = Object.entries(needed).some(
        ([key, required]) => required && !currentFlags[key as keyof CuGrantFlags],
      )
      const allowedApps = context.getAllowedApps()
      if (missing || allowedApps.length === 0) {
        const requestedName =
          typeof (args as { target_app?: unknown }).target_app === 'string'
            ? String((args as { target_app: string }).target_app)
            : 'this application'
        const response = await context.onPermissionRequest(
          {
            apps: [
              {
                requestedName,
                alreadyGranted: allowedApps.length > 0,
              },
            ],
            requestedFlags: { ...currentFlags, ...needed },
            reason: `Allow Computer Use action: ${name}`,
          },
          new AbortController().signal,
        )
        if (response.denied.length > 0 || response.granted.length === 0) {
          throw new Error(`Computer Use permission denied: ${name}`)
        }
        const flags = response.flags
        const stillMissing = Object.entries(needed).some(
          ([key, required]) => required && !flags[key as keyof CuGrantFlags],
        )
        if (stillMissing) throw new Error(`Computer Use flag not granted: ${name}`)
        context.onAllowedAppsChanged(response.granted, flags)
      }
    }
    const result = await client.callTool({
      name,
      arguments: (args ?? {}) as Record<string, unknown>,
    })
    return {
      content: result.content as CuCallToolResult['content'],
      ...(result.isError ? { isError: true } : {}),
    }
  }
}
