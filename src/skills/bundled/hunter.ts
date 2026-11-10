import { registerBundledSkill } from '../bundledSkills.js'

const HUNTER_PROMPT = `# /hunter — independent artifact review

Collect the artifact and intended behavior before reviewing. Use the ReviewArtifact tool for the independent read-only pass; do not ask the artifact's author to grade their own work.

Review for correctness, regressions, security, and missing verification. Report blocker, warning, and nit findings with concrete file/line evidence. Separate verified findings from unverified concerns, and do not claim a clean review when inspection or tests were not run. Run focused verification for findings when possible and report exactly what was and was not executed.

User request:
`

export function registerHunterSkill(): void {
  registerBundledSkill({
    name: 'hunter',
    description: 'Independently review an artifact for evidence-backed issues',
    whenToUse:
      'When the user asks to hunt down bugs, review an implementation or generated artifact, or verify that a change actually meets its requirements.',
    userInvocable: true,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: `${HUNTER_PROMPT}${args}` }]
    },
  })
}
