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

const { getAllBaseTools, builtInCommandNames } = await import(
  join(outdir, 'feature-check.js')
)
const tools = await getAllBaseTools()
const commandNames = builtInCommandNames()
console.log(
  `FEATURE_PROFILE=${JSON.stringify({
    toolCount: tools.length,
    nullCount: tools.filter((tool: unknown) => !tool).length,
    toolNames: tools.map((tool: { name: string }) => tool.name),
    hasUltraplan: commandNames.has('ultraplan'),
    hasVoice: commandNames.has('voice'),
    hasBrief: commandNames.has('brief'),
  })}`,
)
