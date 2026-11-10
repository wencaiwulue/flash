import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { registerHunterSkill } from '../src/skills/bundled/hunter.ts'
import { getBundledSkills } from '../src/skills/bundledSkills.ts'
import {
  parseReviewerOutput,
  reviewArtifact,
  ReviewArtifactTool,
} from '../src/tools/ReviewArtifactTool/ReviewArtifactTool.ts'
import type { ToolUseContext } from '../src/Tool.ts'

const context = {} as ToolUseContext
const allow = async () => ({ behavior: 'allow' as const, updatedInput: {} })

describe('ReviewArtifactTool', () => {
  test('requires exactly one artifact source', async () => {
    expect((await ReviewArtifactTool.validateInput({}, context)).result).toBe(false)
    expect(
      (await ReviewArtifactTool.validateInput(
        { artifact_path: 'a', content: 'b' },
        context,
      )).result,
    ).toBe(false)
    expect(
      (await ReviewArtifactTool.validateInput({ content: 'code' }, context))
        .result,
    ).toBe(true)
  })

  test('passes artifact and requirements to an independent reviewer', async () => {
    const runner = mock(async () =>
      JSON.stringify({
        summary: 'One correctness issue',
        findings: [
          {
            severity: 'blocker',
            title: 'Missing null check',
            description: 'The parser dereferences an optional value',
            file_path: 'src/parser.ts',
            line: 42,
            verification: 'Not executed',
            status: 'unverified',
          },
        ],
      }),
    )
    const result = await reviewArtifact(
      {
        content: 'function parse(value) { return value.x }',
        focus: 'null safety',
        context: 'Optional values must not throw',
      },
      context,
      allow,
      runner,
    )
    expect(result.summary).toBe('One correctness issue')
    expect(result.findings[0]?.status).toBe('unverified')
    const prompt = runner.mock.calls[0]?.[0] as string
    expect(prompt).toContain('null safety')
    expect(prompt).toContain('Optional values must not throw')
    expect(prompt).toContain('function parse(value)')
  })

  test('reads file artifacts within the size limit', async () => {
    const dir = await mkdtemp(join('/tmp', 'claude-review-artifact-'))
    try {
      await writeFile(join(dir, 'artifact.txt'), 'file artifact')
      const result = await reviewArtifact(
        { artifact_path: join(dir, 'artifact.txt') },
        context,
        allow,
        async () => '{"summary":"ok","findings":[]}',
      )
      expect(result.summary).toBe('ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects oversized artifacts and malformed reviewer output', async () => {
    await expect(
      reviewArtifact(
        { content: 'x'.repeat(1_000_001) },
        context,
        allow,
        async () => '{"summary":"ok","findings":[]}',
      ),
    ).rejects.toThrow('1 MB')
    expect(() => parseReviewerOutput('no json')).toThrow('JSON object')
    expect(parseReviewerOutput('{"summary":"ok","findings":[]}').findings).toEqual(
      [],
    )
  })
})

describe('/hunter', () => {
  test('registers a user-invocable evidence review prompt', async () => {
    registerHunterSkill()
    const hunter = getBundledSkills().find(skill => skill.name === 'hunter')
    expect(hunter).toBeDefined()
    expect(hunter?.userInvocable).toBe(true)
    if (hunter?.type !== 'prompt') return
    const prompt = await hunter.getPromptForCommand('review this', context)
    expect(JSON.stringify(prompt)).toContain('ReviewArtifact')
    expect(JSON.stringify(prompt)).toContain('unverified')
  })
})
