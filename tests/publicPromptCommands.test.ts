import { describe, expect, test } from 'bun:test'
import autofixPr, {
  buildAutofixPRPrompt,
  parseAutofixPRReference,
} from '../src/commands/autofix-pr/index.ts'
import summary, {
  buildSummaryPrompt,
} from '../src/commands/summary/index.ts'
import type { ToolUseContext } from '../src/Tool.ts'

const context = { messages: [] } as ToolUseContext

function text(blocks: Awaited<ReturnType<typeof buildSummaryPrompt>>): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

describe('/summary', () => {
  test('expands an optional focus into a normal prompt without compaction', async () => {
    const populated = { messages: [{}] } as ToolUseContext
    const blocks = await summary.getPromptForCommand('database decisions', populated)
    const prompt = text(blocks)
    expect(summary.name).toBe('summary')
    expect(summary.progressMessage).toBe('summarizing conversation')
    expect(summary.type).toBe('prompt')
    expect(prompt).toContain('database decisions')
    expect(prompt).toContain('normal assistant response')
    expect(prompt).toContain('Do not compact, truncate, rewrite, checkpoint')
    expect(prompt).not.toContain('/compact')
  })

  test('handles no focus and an empty conversation', async () => {
    expect(text(await summary.getPromptForCommand('', context))).toContain(
      'no earlier conversation',
    )
    expect(text(buildSummaryPrompt('', 1))).toContain('existing conversation')
  })
})

describe('/autofix-pr', () => {
  test('accepts numbers and URLs and rejects other references', () => {
    expect(parseAutofixPRReference('123')).toBe('123')
    expect(parseAutofixPRReference('#456')).toBe('#456')
    expect(parseAutofixPRReference('https://github.com/o/r/pull/789')).toBe(
      'https://github.com/o/r/pull/789',
    )
    expect(parseAutofixPRReference('')).toBe('')
    expect(parseAutofixPRReference('0')).toBeNull()
    expect(parseAutofixPRReference('-1')).toBeNull()
    expect(parseAutofixPRReference('123; git push')).toBeNull()
    expect(parseAutofixPRReference('https://github.com/o/r/issues/123')).toBeNull()
    expect(text(buildAutofixPRPrompt('bad'))).toContain(
      'Usage: /autofix-pr [PR-number-or-URL]',
    )
  })

  test('requests both comment APIs with pagination and forbids publishing', async () => {
    const prompt = text(await autofixPr.getPromptForCommand('42', context))
    expect(prompt).toContain('issue-comments and pull-request-comments')
    expect(prompt).toContain('gh api --paginate')
    expect(prompt).toContain('existing changes')
    expect(prompt).toContain('tests fail')
    expect(prompt).toContain('Never create a commit, push, merge')
    expect(prompt).not.toContain('gh pr create')
    expect(prompt).not.toContain('git commit -')
    expect(prompt).not.toContain('git push ')
    expect(autofixPr.allowedTools).not.toContain('Bash(git push:*)')
    expect(autofixPr.allowedTools).not.toContain('Bash(gh pr merge:*)')
    expect(autofixPr.allowedTools).not.toContain('Bash(gh api:*)')
  })

  test('uses the current branch PR when no reference is supplied', () => {
    expect(text(buildAutofixPRPrompt(''))).toContain(
      'pull request for the current branch',
    )
  })
})
