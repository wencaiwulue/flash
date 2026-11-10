import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

/** Runtime kill switch; compilation is controlled by EXPERIMENTAL_SKILL_SEARCH. */
export function isSkillSearchEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_CODE_SKILL_SEARCH)
}
