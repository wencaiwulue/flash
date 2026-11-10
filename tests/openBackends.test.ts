import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'http'
import { closeOpenBrowserClient, listBrowserTools } from '../src/external-stubs/claude-for-chrome-mcp.ts'
import {
  bindSessionContext,
  closeOpenComputerUseClient,
  listOpenComputerUseTools,
} from '../src/external-stubs/computer-use-mcp.ts'
import { WebBrowserTool } from '../src/tools/WebBrowserTool/WebBrowserTool.ts'
import type { ToolUseContext } from '../src/Tool.ts'

let server: Server | undefined
let baseUrl = ''

afterEach(async () => {
  await closeOpenBrowserClient()
  await closeOpenComputerUseClient()
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
})

describe('open Computer Use and Browser backends', () => {
  test('enumerates real Zavora tool schemas and blocks denied actions', async () => {
    const tools = await listOpenComputerUseTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some(tool => tool.name === 'screenshot')).toBe(true)
    expect(tools[0]?.inputSchema).toBeDefined()

    const dispatch = bindSessionContext({} as never, 'pixels', {
      getAllowedApps: () => [],
      getGrantFlags: () => ({
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      }),
      onPermissionRequest: async () => ({
        granted: [],
        denied: [{ bundleId: 'test', reason: 'user_denied' }],
        flags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
      }),
    } as never)
    await expect(dispatch('click', { x: 1, y: 1 })).rejects.toThrow(
      'permission denied',
    )
  }, 30_000)

  test('navigates a real isolated browser to a local page', async () => {
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<html><title>Flash Browser Test</title><main>Local content</main></html>')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    baseUrl = `http://127.0.0.1:${address.port}`

    const tools = await listBrowserTools()
    expect(tools.some(tool => tool.name === 'browser_navigate')).toBe(true)
    const result = await WebBrowserTool.call(
      { action: 'browser_navigate', arguments: { url: baseUrl } },
      {} as ToolUseContext,
    )
    expect(JSON.stringify(result.data.content)).toContain('Flash Browser Test')
    const snapshot = await WebBrowserTool.call(
      { action: 'browser_snapshot', arguments: {} },
      {} as ToolUseContext,
    )
    expect(JSON.stringify(snapshot.data.content)).toContain('Local content')
    await WebBrowserTool.call({ action: 'browser_close', arguments: {} }, {} as ToolUseContext)
  }, 60_000)
})
