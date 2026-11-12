import { expect, test } from 'bun:test'
import { EXTERNAL_FEATURES } from '../scripts/externalFeatureProfile.ts'

test('production and verification builds share one exact external feature list', async () => {
  const build = await Bun.file('scripts/build.ts').text()
  const verification = await Bun.file('tests/fixtures/verify-enabled-features.ts').text()
  expect(build).toContain('features: [...EXTERNAL_FEATURES]')
  expect(verification).toContain('features: [...EXTERNAL_FEATURES]')
  expect(EXTERNAL_FEATURES).toEqual([
    'AGENT_MEMORY_SNAPSHOT',
    'AGENT_TRIGGERS',
    'AGENT_TRIGGERS_REMOTE',
    'VOICE_MODE',
    'BRIDGE_MODE',
    'ULTRAPLAN',
    'FILE_PERSISTENCE',
    'KAIROS_BRIEF',
    'MONITOR_TOOL',
    'TEMPLATES',
    'OPEN_RUNNER',
    'OVERFLOW_TEST_TOOL',
    'TERMINAL_PANEL',
    'PROACTIVE',
    'COORDINATOR_MODE',
    'EXPERIMENTAL_SKILL_SEARCH',
    'UDS_INBOX',
    'DAEMON',
    'WORKFLOW_SCRIPTS',
    'CONTEXT_COLLAPSE',
    'DIRECT_CONNECT',
    'BG_SESSIONS',
    'REACTIVE_COMPACT',
    'SSH_REMOTE',
    'BUDDY',
    'FORK_SUBAGENT',
    'HISTORY_SNIP',
    'REVIEW_ARTIFACT',
    'KAIROS',
    'KAIROS_GITHUB_WEBHOOKS',
    'CHICAGO_MCP',
    'COMMIT_ATTRIBUTION',
    'BASH_CLASSIFIER',
    'WEB_BROWSER_TOOL',
  ])
})
