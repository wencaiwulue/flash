import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { DistSdk } from './sdk.ts'

export const MCP_FORM_MESSAGE = 'SDK_MCP_FORM_QUESTION_33B'

export function createFormElicitationEchoServer(
  sdk: DistSdk,
  marker: string,
  calls: Array<Record<string, unknown>>,
  elicitationResults?: ElicitResult[],
) {
  let server: ReturnType<DistSdk['createSdkMcpServer']>
  server = sdk.createSdkMcpServer({
    name: 'mock',
    version: '1.0.0',
    tools: [sdk.tool(
      'echo',
      'Echo input and optionally request a form value',
      { text: z.string(), elicit: z.boolean().optional() },
      async (args, extra) => {
        calls.push(args)
        let elicitation: ElicitResult | undefined
        if (args.elicit) {
          elicitation = await server.instance.server.elicitInput(
            {
              mode: 'form',
              message: MCP_FORM_MESSAGE,
              requestedSchema: {
                type: 'object',
                properties: {
                  answer: { type: 'string', description: 'A test answer' },
                },
                required: ['answer'],
              },
            },
            // Propagate tools/call cancellation to the nested elicitation.
            { signal: (extra as { signal: AbortSignal }).signal },
          )
          elicitationResults?.push(elicitation)
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ marker, echo: args.text, elicitation }),
          }],
        }
      },
    )],
  })
  return server
}
