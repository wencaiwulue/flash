import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import { formatAgentId } from '../utils/agentId.js'
import { getDefaultMainLoopModel } from '../utils/model/model.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { setCliTeammateModeOverride } from '../utils/swarm/backends/teammateModeSnapshot.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import {
  getTeamFilePath,
  registerTeamForSessionCleanup,
  sanitizeName,
  writeTeamFileAsync,
} from '../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../utils/swarm/teammateLayoutManager.js'
import { ensureTasksDir, resetTaskList, setLeaderTeamName } from '../utils/tasks.js'

let forced = false

export function isAssistantMode(): boolean {
  return forced || isEnvTruthy(process.env.CLAUDE_CODE_ASSISTANT) || getInitialSettings().assistant === true
}

export function isAssistantForced(): boolean {
  return forced
}

export function markAssistantForced(): boolean {
  if (forced) return false
  forced = true
  return true
}

export function getAssistantActivationPath(): string | undefined {
  if (forced) return 'forced'
  if (isEnvTruthy(process.env.CLAUDE_CODE_ASSISTANT)) return 'env'
  return getInitialSettings().assistant === true ? 'settings' : undefined
}

export function getAssistantSystemPromptAddendum(): string {
  return `You are leading an in-process assistant team. Delegate useful independent work to teammates with complete self-contained instructions, then synthesize their results. Use the existing task, workflow, file-upload, and notification tools when they help the user. Do not claim teammate work or uploads that have not completed.`
}

export async function initializeAssistantTeam() {
  const teamName = sanitizeName(`assistant-${getSessionId().slice(0, 8)}`)
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
  const teamFilePath = getTeamFilePath(teamName)
  await writeTeamFileAsync(teamName, {
    name: teamName,
    description: 'Assistant team',
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: getSessionId(),
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: TEAM_LEAD_NAME,
        model: getDefaultMainLoopModel(),
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: getCwd(),
        subscriptions: [],
      },
    ],
  })
  registerTeamForSessionCleanup(teamName)
  await resetTaskList(teamName)
  await ensureTasksDir(teamName)
  setLeaderTeamName(teamName)
  setCliTeammateModeOverride('in-process')
  return {
    teamName,
    teamFilePath,
    leadAgentId,
    teammates: {
      [leadAgentId]: {
        name: TEAM_LEAD_NAME,
        agentType: TEAM_LEAD_NAME,
        color: assignTeammateColor(leadAgentId),
        tmuxSessionName: '',
        tmuxPaneId: '',
        cwd: getCwd(),
        spawnedAt: Date.now(),
      },
    },
  }
}

export function isKairosRuntimeEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_KAIROS)
}
