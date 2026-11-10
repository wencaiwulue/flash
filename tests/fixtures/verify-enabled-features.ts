import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '../..')
const outdir = process.argv[2]
if (!outdir) throw new Error('Missing output directory')

const result = await Bun.build({
  entrypoints: [join(root, 'tests/fixtures/feature-check.ts')],
  outdir,
  target: 'bun',
  format: 'esm',
  features: [
    'AGENT_TRIGGERS',
    'AGENT_TRIGGERS_REMOTE',
    'VOICE_MODE',
    'BRIDGE_MODE',
    'ULTRAPLAN',
    'FILE_PERSISTENCE',
    'KAIROS_BRIEF',
    'MONITOR_TOOL',
    'OVERFLOW_TEST_TOOL',
    'TERMINAL_PANEL',
    'PROACTIVE',
    'COORDINATOR_MODE',
    'EXPERIMENTAL_SKILL_SEARCH',
    'UDS_INBOX',
    'DAEMON',
    'WORKFLOW_SCRIPTS',
    'CONTEXT_COLLAPSE',
    'REACTIVE_COMPACT',
    'BUDDY',
    'FORK_SUBAGENT',
    'HISTORY_SNIP',
    'REVIEW_ARTIFACT',
  ],
  define: {
    'process.env.USER_TYPE': JSON.stringify('external'),
    'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('false'),
  },
  loader: {
    '.md': 'text',
    '.txt': 'text',
  },
})

if (!result.success) {
  throw new Error(result.logs.map(String).join('\n'))
}

const {
  getAllBaseTools,
  builtInCommandNames,
  getCoordinatorAgents,
  isReactiveCompactEnabled,
  getBundledSkills,
  initBundledSkills,
  activateProactive,
  deactivateProactive,
  isProactiveActive,
} = await import(join(outdir, 'feature-check.js'))
const tools = await getAllBaseTools()
const commandNames = builtInCommandNames()
const sleepTool = tools.find((tool: { name: string }) => tool.name === 'Sleep')
const sleepInitiallyEnabled = sleepTool?.isEnabled() ?? false
activateProactive('command')
const proactiveActive = isProactiveActive()
const sleepWhenActive = sleepTool?.isEnabled() ?? false
deactivateProactive()
const worker = getCoordinatorAgents()[0]
initBundledSkills()
console.log(
  `FEATURE_PROFILE=${JSON.stringify({
    toolCount: tools.length,
    nullCount: tools.filter((tool: unknown) => !tool).length,
    toolNames: tools.map((tool: { name: string }) => tool.name),
    sleepInitiallyEnabled,
    proactiveActive,
    sleepWhenActive,
    workerType: worker?.agentType,
    workerBackground: worker?.background,
    workerHasBash: worker?.tools?.includes('Bash') ?? false,
    workerHasAgent: worker?.tools?.includes('Agent') ?? false,
    reactiveCompactEnabled: isReactiveCompactEnabled(),
    hasHunterSkill: getBundledSkills().some(
      (skill: { name: string }) => skill.name === 'hunter',
    ),
    hasProactiveCommand: commandNames.has('proactive'),
    hasPeersCommand: commandNames.has('peers'),
    hasRemoteControlServerCommand: commandNames.has('remote-control-server'),
    hasWorkflowsCommand: commandNames.has('workflows'),
    hasBuddyCommand: commandNames.has('buddy'),
    hasForkCommand: commandNames.has('fork'),
    hasForceSnipCommand: commandNames.has('force-snip'),
    hasUltraplan: commandNames.has('ultraplan'),
    hasVoice: commandNames.has('voice'),
    hasBrief: commandNames.has('brief'),
  })}`,
)
