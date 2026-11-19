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
  managedDir: string            // 新增：源码形态 managed 注入目录
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
  // 禁用非必要流量（GrowthBook 动态配置/遥测走真实 api.anthropic.com，不走 ANTHROPIC_BASE_URL）
  // — 关闭后 assertMinVersion 的 tengu_version_config 落回默认 minVersion=0.0.0，版本门禁不再触发
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return env
}

export async function createSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), 'flash-it-home-'))
  const project = opts.projectDir ?? join(home, 'project')
  const managedDir = join(home, 'managed-settings')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(join(project, '.claude'), { recursive: true })
  await mkdir(managedDir, { recursive: true })

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
    managedDir,
    env: baseEnv(home),
    async cleanup() {
      await rm(home, { recursive: true, force: true })
    },
  }
}
