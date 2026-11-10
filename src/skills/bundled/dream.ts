import { getAutoMemPath } from '../../memdir/paths.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { getCwd } from '../../utils/cwd.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerDreamSkill(): void {
  registerBundledSkill({
    name: 'dream',
    description: 'Consolidate recent session signals into durable memories',
    whenToUse:
      'When the user explicitly asks to dream, reflect on recent sessions, or consolidate learned project context into memory.',
    userInvocable: true,
    async getPromptForCommand(args) {
      return [
        {
          type: 'text',
          text: buildConsolidationPrompt(getAutoMemPath(), getProjectDir(getCwd()), args),
        },
      ]
    },
  })
}
