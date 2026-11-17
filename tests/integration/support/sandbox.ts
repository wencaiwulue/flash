import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { realpathSync } from 'fs'

export interface SandboxOptions {
  globalConfig?: Record<string, unknown>
  userSettings?: Record<string, unknown>
  projectSettings?: Record<string, unknown>
  localSettings?: Record<string, unknown>
  projectDir?: string
}

export interface Sandbox {
  home: string
  project: string
  env: Record<string, string>
  cleanup(): Promise<void>
}

async function writeJsonIfPresent(path: string, value: Record<string, unknown> | undefined): Promise<void> {
  if (value === undefined) return
  await writeFile(path, JSON.stringify(value))
}

export function baseEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) continue
    env[key] = value
  }
  env.HOME = home
  env.USERPROFILE = home
  return env
}

export async function createSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), 'flash-it-home-'))
  const project = opts.projectDir ?? join(home, 'project')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(join(project, '.claude'), { recursive: true })

  const realProject = realpathSync(project)
  const globalConfig = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: {
      [project]: { hasTrustDialogAccepted: true },
      [realProject]: { hasTrustDialogAccepted: true },
    },
    ...opts.globalConfig,
  }
  await writeJsonIfPresent(join(home, '.claude.json'), globalConfig)
  await writeJsonIfPresent(join(home, '.claude', 'settings.json'), opts.userSettings)
  await writeJsonIfPresent(join(project, '.claude', 'settings.json'), opts.projectSettings)
  await writeJsonIfPresent(join(project, '.claude', 'settings.local.json'), opts.localSettings)

  return {
    home,
    project,
    env: baseEnv(home),
    async cleanup() {
      await rm(home, { recursive: true, force: true })
    },
  }
}
