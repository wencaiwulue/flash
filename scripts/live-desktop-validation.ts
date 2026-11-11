import {
  closeOpenComputerUseClient,
  getOpenComputerUseClient,
} from '../src/external-stubs/computer-use-mcp.js'

if (process.env.CLAUDE_DESKTOP_LIVE !== '1') {
  console.log('DESKTOP_LIVE_SKIPPED')
} else {
  try {
    const client = await getOpenComputerUseClient()
    const result = await client.callTool({ name: 'screenshot', arguments: {} })
    if (result.isError) throw new Error('Desktop screenshot failed')
    console.log('DESKTOP_LIVE_OK')
  } finally {
    await closeOpenComputerUseClient()
  }
}
