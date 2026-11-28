import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'team-lifecycle-config-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

const { TeamCreateTool } = await import('../src/tools/TeamCreateTool/TeamCreateTool.ts')
const { TeamDeleteTool } = await import('../src/tools/TeamDeleteTool/TeamDeleteTool.ts')
const { getDefaultAppState } = await import('../src/state/AppStateStore.ts')
const {
  cleanupTeamDirectories,
  getTeamFilePath,
  readTeamFile,
  unregisterTeamForSessionCleanup,
  writeTeamFileAsync,
} = await import('../src/utils/swarm/teamHelpers.ts')
const {
  clearLeaderTeamName,
  getTaskListId,
  getTasksDir,
} = await import('../src/utils/tasks.ts')
const { clearTeammateColors } = await import(
  '../src/utils/swarm/teammateLayoutManager.ts'
)

import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'

let tempRoot = ''
const createdTeams = new Set<string>()

function harness(initialState?: AppState) {
  let state = initialState ?? getDefaultAppState()
  const setAppState = (update: (previous: AppState) => AppState) => {
    state = update(state)
  }
  const context = {
    getAppState: () => state,
    setAppState,
    setAppStateForTasks: setAppState,
    toolUseId: 'tool-team-lifecycle',
  } as unknown as ToolUseContext
  return { context, state: () => state }
}

async function createTeam(name: string, context?: ToolUseContext) {
  const target = context ?? harness().context
  const result = await TeamCreateTool.call(
    { team_name: name, description: 'offline lifecycle', agent_type: 'research-lead' },
    target,
  )
  createdTeams.add(result.data.team_name)
  return result
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'team-lifecycle-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
  createdTeams.clear()
})

afterEach(async () => {
  for (const name of createdTeams) {
    await cleanupTeamDirectories(name)
    unregisterTeamForSessionCleanup(name)
  }
  createdTeams.clear()
  clearLeaderTeamName()
  clearTeammateColors()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(moduleIsolationRoot, { recursive: true, force: true })
})

describe('TeamCreateTool real lifecycle', () => {
  test('writes the lead config and fresh task list, updates AppState, and rejects a second led team', async () => {
    const app = harness()
    const result = await createTeam('team-alpha', app.context)

    expect(result.data.team_name).toBe('team-alpha')
    expect(result.data.lead_agent_id).toBe('team-lead@team-alpha')
    expect(result.data.team_file_path).toBe(getTeamFilePath('team-alpha'))
    const team = readTeamFile('team-alpha')
    expect(team).toMatchObject({
      name: 'team-alpha',
      description: 'offline lifecycle',
      leadAgentId: 'team-lead@team-alpha',
      members: [
        {
          name: 'team-lead',
          agentType: 'research-lead',
          agentId: 'team-lead@team-alpha',
          subscriptions: [],
        },
      ],
    })
    expect(existsSync(getTasksDir('team-alpha'))).toBe(true)
    expect(getTaskListId()).toBe('team-alpha')
    expect(app.state().teamContext).toMatchObject({
      teamName: 'team-alpha',
      teamFilePath: getTeamFilePath('team-alpha'),
      leadAgentId: 'team-lead@team-alpha',
    })

    await expect(createTeam('team-beta', app.context)).rejects.toThrow(
      'Already leading team "team-alpha"',
    )
    expect(readTeamFile('team-beta')).toBeNull()
  })

  test('generates a different name on collision without overwriting the original team', async () => {
    const first = await createTeam('team-alpha')
    const original = readFileSync(first.data.team_file_path, 'utf8')
    const second = await createTeam('team-alpha')

    expect(second.data.team_name).not.toBe('team-alpha')
    expect(second.data.team_name.length).toBeGreaterThan(0)
    expect(readFileSync(first.data.team_file_path, 'utf8')).toBe(original)
    expect(readTeamFile(second.data.team_name)?.name).toBe(second.data.team_name)
    expect(second.data.team_file_path).not.toBe(first.data.team_file_path)
  })
})

describe('TeamDeleteTool real lifecycle', () => {
  test('refuses cleanup with an active non-lead member and preserves state until it becomes inactive', async () => {
    const app = harness()
    await createTeam('team-alpha', app.context)
    const team = readTeamFile('team-alpha')!
    team.members.push({
      agentId: 'worker@team-alpha',
      name: 'worker',
      agentType: 'general-purpose',
      joinedAt: Date.now(),
      tmuxPaneId: '',
      cwd: tempRoot,
      subscriptions: [],
      isActive: true,
    })
    await writeTeamFileAsync('team-alpha', team)

    const refused = await TeamDeleteTool.call({}, app.context)
    expect(refused.data).toEqual({
      success: false,
      message: 'Cannot cleanup team with 1 active member(s): worker. Use requestShutdown to gracefully terminate teammates first.',
      team_name: 'team-alpha',
    })
    expect(existsSync(getTeamFilePath('team-alpha'))).toBe(true)
    expect(app.state().teamContext?.teamName).toBe('team-alpha')

    team.members[1]!.isActive = false
    await writeTeamFileAsync('team-alpha', team)
    const cleaned = await TeamDeleteTool.call({}, app.context)
    expect(cleaned.data.success).toBe(true)
    expect(existsSync(getTeamFilePath('team-alpha'))).toBe(false)
    expect(app.state().teamContext).toBeUndefined()
  })

  test('cleans directories and inbox for inactive members, then handles no team idempotently', async () => {
    const app = harness()
    await createTeam('team-alpha', app.context)
    const team = readTeamFile('team-alpha')!
    team.members.push({
      agentId: 'worker@team-alpha',
      name: 'worker',
      agentType: 'general-purpose',
      joinedAt: Date.now(),
      tmuxPaneId: '',
      cwd: tempRoot,
      subscriptions: [],
      isActive: false,
    })
    await writeTeamFileAsync('team-alpha', team)

    const result = await TeamDeleteTool.call({}, app.context)
    expect(result.data).toEqual({
      success: true,
      message: 'Cleaned up directories and worktrees for team "team-alpha"',
      team_name: 'team-alpha',
    })
    expect(existsSync(getTeamFilePath('team-alpha'))).toBe(false)
    expect(existsSync(getTasksDir('team-alpha'))).toBe(false)
    expect(app.state().teamContext).toBeUndefined()
    expect(app.state().inbox.messages).toEqual([])

    const noop = await TeamDeleteTool.call({}, app.context)
    expect(noop.data).toEqual({
      success: true,
      message: 'No team name found, nothing to clean up',
      team_name: undefined,
    })
  })
})
