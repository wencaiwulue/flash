import { lstat, readFile } from 'fs/promises'
import { resolve } from 'path'
import { z } from 'zod/v4'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { createUserMessage } from '../../utils/messages.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const MAX_ARTIFACT_BYTES = 1_000_000
const inputSchema = z.strictObject({
  artifact_path: z.string().optional().describe('Path to the artifact to review'),
  content: z.string().optional().describe('Inline artifact content'),
  focus: z.string().optional().describe('Review priorities or artifact type'),
  context: z.string().optional().describe('Intended behavior and relevant requirements'),
})
type InputSchema = typeof inputSchema

const findingSchema = z.object({
  severity: z.enum(['blocker', 'warning', 'nit']),
  title: z.string(),
  description: z.string(),
  file_path: z.string().optional(),
  line: z.number().int().positive().optional(),
  verification: z.string().optional(),
  status: z.enum(['verified', 'unverified']).default('unverified'),
})
const reviewerOutputSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
})
const outputSchema = reviewerOutputSchema.extend({ message: z.string() })
type Output = z.infer<typeof outputSchema>

export type ArtifactReviewInput = z.infer<typeof inputSchema>
export type ReviewerRunner = (
  prompt: string,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
) => Promise<string>

async function defaultReviewer(
  prompt: string,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): Promise<string> {
  const [{ runAgent }, { GENERAL_PURPOSE_AGENT }, { asSystemPrompt }] =
    await Promise.all([
      import('../AgentTool/runAgent.js'),
      import('../AgentTool/built-in/generalPurposeAgent.js'),
      import('../../utils/systemPromptType.js'),
    ])
  const availableTools = context.options.tools.filter(tool =>
    ['Read', 'Grep', 'Glob'].includes(tool.name),
  )
  const texts: string[] = []
  for await (const message of runAgent({
    agentDefinition: GENERAL_PURPOSE_AGENT,
    promptMessages: [createUserMessage({ content: prompt })],
    toolUseContext: context,
    canUseTool,
    isAsync: false,
    canShowPermissionPrompts: true,
    querySource: 'agent:custom',
    override: {
      systemPrompt: asSystemPrompt([
        'You are an independent artifact reviewer. Do not modify files. Report only evidence-backed problems and clearly mark anything unverified.',
      ]),
    },
    availableTools,
    maxTurns: 8,
    description: 'Review artifact',
  })) {
    if (message.type !== 'assistant') continue
    const text = message.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text) texts.push(text)
  }
  const response = texts.at(-1)
  if (!response) throw new Error('Reviewer returned no response')
  return response
}

export function parseReviewerOutput(text: string): Omit<Output, 'message'> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('Reviewer did not return a JSON object')
  }
  return reviewerOutputSchema.parse(JSON.parse(text.slice(start, end + 1)))
}

async function readArtifact(input: ArtifactReviewInput): Promise<string> {
  if (input.content !== undefined) {
    if (Buffer.byteLength(input.content) > MAX_ARTIFACT_BYTES) {
      throw new Error('Artifact content exceeds the 1 MB limit')
    }
    return input.content
  }
  const path = resolve(getCwd(), input.artifact_path!)
  const metadata = await lstat(path)
  if (!metadata.isFile()) throw new Error(`Artifact is not a regular file: ${path}`)
  if (metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds the 1 MB limit: ${path}`)
  }
  return readFile(path, 'utf8')
}

export async function reviewArtifact(
  input: ArtifactReviewInput,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  runner: ReviewerRunner = defaultReviewer,
): Promise<Output> {
  const artifact = await readArtifact(input)
  const prompt = `Review this artifact independently. Return JSON only with this shape:
{"summary":"...","findings":[{"severity":"blocker|warning|nit","title":"...","description":"...","file_path":"optional","line":1,"verification":"optional","status":"verified|unverified"}]}

Rules:
- Use the intended behavior as the review target, not personal style.
- Blockers require concrete evidence. Do not invent a passing result or findings.
- Mark anything not actually verified as "unverified".
- Return an empty findings array when no issue is found.

Focus: ${input.focus ?? 'correctness, regressions, security, and missing verification'}
Requirements: ${input.context ?? 'No additional requirements supplied'}
Artifact: ${input.artifact_path ?? '<inline>'}
<artifact>\n${artifact}\n</artifact>`
  return {
    ...parseReviewerOutput(await runner(prompt, context, canUseTool)),
    message: 'Artifact review completed',
  }
}

export const ReviewArtifactTool = buildTool({
  name: 'ReviewArtifact',
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  async description() {
    return 'Independently review an artifact for evidence-backed issues'
  },
  async prompt() {
    return 'Review a file or inline artifact with an independent read-only reviewer. Returns structured blocker/warning/nit findings, evidence, and unverified status. Supply either artifact_path or content, never both.'
  },
  async checkPermissions(input, context) {
    if (!input.artifact_path) return { behavior: 'allow', updatedInput: input }
    const { FileReadTool } = await import('../FileReadTool/FileReadTool.js')
    return FileReadTool.checkPermissions(
      { file_path: input.artifact_path },
      context,
    )
  },
  async validateInput(input) {
    if ((input.artifact_path === undefined) === (input.content === undefined)) {
      return {
        result: false as const,
        message: 'Provide exactly one of artifact_path or content',
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context, canUseTool) {
    return { data: await reviewArtifact(input, context, canUseTool) }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: jsonStringify(output),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
