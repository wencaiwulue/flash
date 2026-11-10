import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isSkillSearchEnabled } from '../../services/skillSearch/featureCheck.js'
import { searchLocalSkills } from '../../services/skillSearch/localSearch.js'
import { DISCOVER_SKILLS_TOOL_NAME } from './prompt.js'

const inputSchema = z.strictObject({
  query: z.string().min(1).describe('Task or workflow to find relevant skills for'),
  limit: z.number().int().min(1).max(10).optional(),
})
type InputSchema = typeof inputSchema
const outputSchema = z.object({
  query: z.string(),
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
})
type Output = z.infer<typeof outputSchema>

export const DiscoverSkillsTool = buildTool({
  name: DISCOVER_SKILLS_TOOL_NAME,
  inputSchema,
  outputSchema,
  maxResultSizeChars: 20_000,
  isEnabled: () => isSkillSearchEnabled(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderToolUseMessage() {
    return null
  },
  getToolUseSummary: input => input?.query ?? null,
  async description() {
    return 'Search local project, user, and plugin skills for a task'
  },
  async prompt() {
    return 'Search local skill names, descriptions, and usage guidance. Already visible or invoked skills are omitted. Returns up to limit relevant skills (default 5); invoke a result with Skill(name) to load its full instructions.'
  },
  async call({ query, limit }, context) {
    const matches = await searchLocalSkills(query, context, { limit })
    return {
      data: {
        query,
        skills: matches.map(({ name, description }) => ({ name, description })),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content:
        output.skills.length === 0
          ? `No new local skills matched: ${output.query}`
          : output.skills
              .map(skill => `- ${skill.name}: ${skill.description}`)
              .join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
