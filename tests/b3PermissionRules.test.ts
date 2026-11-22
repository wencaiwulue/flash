import { describe, expect, it } from 'bun:test'
import { checkRuleBasedPermissions } from '../src/utils/permissions/permissions.ts'

// Upstream 2.1.311 permissions.allow/ask/deny fail-closed precedence.
// checkRuleBasedPermissions evaluates deny (1a) before ask (1b) before the
// tool-specific check, so a deny rule wins over both allow and ask, and an ask
// rule forces a prompt when no deny matches. Lightweight mock tool/context pin
// that precedence without standing up the full tool/runtime stack.
type Ctx = {
  alwaysAllowRules: Record<string, string[]>
  alwaysDenyRules: Record<string, string[]>
  alwaysAskRules: Record<string, string[]>
}

function makeTool(name: string) {
  return {
    name,
    inputSchema: { parse: (x: unknown) => x },
    checkPermissions: async () => ({
      behavior: 'passthrough',
      message: '',
    }),
  } as never
}

function makeContext(toolPermissionContext: Ctx) {
  return {
    getAppState: () => ({ toolPermissionContext }),
    abortController: new AbortController(),
  } as never
}

function ctx({
  allow = [],
  deny = [],
  ask = [],
}: {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}): Ctx {
  return {
    alwaysAllowRules: { userSettings: allow },
    alwaysDenyRules: { userSettings: deny },
    alwaysAskRules: { userSettings: ask },
  }
}

describe('rule-based permission precedence (fail-closed)', () => {
  it('deny wins over allow for the same tool', async () => {
    const r = await checkRuleBasedPermissions(
      makeTool('Bash'),
      {},
      makeContext(ctx({ allow: ['Bash'], deny: ['Bash'] })),
    )
    expect(r?.behavior).toBe('deny')
  })

  it('deny wins over ask for the same tool', async () => {
    const r = await checkRuleBasedPermissions(
      makeTool('Bash'),
      {},
      makeContext(ctx({ deny: ['Bash'], ask: ['Bash'] })),
    )
    expect(r?.behavior).toBe('deny')
  })

  it('an ask rule forces a prompt when no deny matches', async () => {
    const r = await checkRuleBasedPermissions(
      makeTool('Bash'),
      {},
      makeContext(ctx({ ask: ['Bash'] })),
    )
    expect(r?.behavior).toBe('ask')
  })

  it('returns null (no objection) when only an allow rule matches', async () => {
    const r = await checkRuleBasedPermissions(
      makeTool('Bash'),
      {},
      makeContext(ctx({ allow: ['Bash'] })),
    )
    expect(r).toBeNull()
  })

  it('an unrelated tool is unaffected by a deny rule', async () => {
    const r = await checkRuleBasedPermissions(
      makeTool('Read'),
      {},
      makeContext(ctx({ deny: ['Bash'] })),
    )
    expect(r).toBeNull()
  })
})
