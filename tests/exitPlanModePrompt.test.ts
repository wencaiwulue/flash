import { describe, expect, spyOn, test } from 'bun:test'
import { buildPermissionUpdates } from '../src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx'
import * as modelModule from '../src/utils/model/model.ts'
import { ExitPlanModeV2Tool } from '../src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts'
import { EXIT_PLAN_MODE_V2_TOOL_PROMPT } from '../src/tools/ExitPlanModeTool/prompt.ts'

describe('ExitPlanMode allowedPrompts public guidance', () => {
  test('documents minimal, user-reviewed session prompt rules', async () => {
    expect(EXIT_PLAN_MODE_V2_TOOL_PROMPT).toContain('allowedPrompts')
    expect(EXIT_PLAN_MODE_V2_TOOL_PROMPT).toContain('tool: "Bash"')
    expect(EXIT_PLAN_MODE_V2_TOOL_PROMPT).toContain('minimum categories')
    expect(EXIT_PLAN_MODE_V2_TOOL_PROMPT).toContain('user will review')
    expect(EXIT_PLAN_MODE_V2_TOOL_PROMPT).toContain('current session')
    expect(EXIT_PLAN_MODE_V2_TOOL_PROMPT).toContain('omit `allowedPrompts`')
    expect(await ExitPlanModeV2Tool.prompt()).toBe(
      EXIT_PLAN_MODE_V2_TOOL_PROMPT,
    )
  })

  test('accepts semantic Bash prompts and rejects other tools', () => {
    const result = ExitPlanModeV2Tool.inputSchema.safeParse({
      allowedPrompts: [
        { tool: 'Bash', prompt: 'run tests' },
        { tool: 'Bash', prompt: 'install dependencies' },
      ],
    })
    expect(result.success).toBe(true)
    expect(
      ExitPlanModeV2Tool.inputSchema.safeParse({
        allowedPrompts: [{ tool: 'Read', prompt: 'read everything' }],
      }).success,
    ).toBe(false)
  })

  test('does not grant prompt rules while classifier permissions are unavailable', () => {
    const modelSpy = spyOn(modelModule, 'getSmallFastModel').mockReturnValue('')
    try {
      const updates = buildPermissionUpdates('default', [
        { tool: 'Bash', prompt: 'run tests' },
      ])
      expect(updates).toEqual([
        { type: 'setMode', mode: 'default', destination: 'session' },
      ])
      expect(updates.some(update => update.type === 'addRules')).toBe(false)
    } finally {
      modelSpy.mockRestore()
    }
  })
})
