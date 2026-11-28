import { createHash } from 'crypto'
import type { Command } from '../types/command.js'
import { getAdditionalDirectoriesForClaudeMd } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { isBareMode, isEnvTruthy } from '../utils/envUtils.js'
import * as loadSkillsDir from './loadSkillsDir.js'

// Types
export interface SkillCacheKeyOptions {
  cwd: string
  additionalDirs: string[]
  remote: boolean
}

export interface BoundedSkillCacheOptions {
  ttlMs: number
  maxEntries: number
}

// Cache key implementation
export function skillCacheKey(options: SkillCacheKeyOptions): string {
  const { cwd, additionalDirs, remote } = options
  const keyString = JSON.stringify({
    cwd,
    additionalDirs: [...additionalDirs].sort(),
    remote,
    bare: isBareMode(),
    disablePolicySkills: isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS),
  })
  return createHash('sha256').update(keyString).digest('hex')
}

// Track dynamically discovered directories and their skills
interface TrackedSkillDir {
  dir: string
  skills: string[] // skill names from this dir
}

const trackedDirs = new Map<string, TrackedSkillDir>()

/**
 * Register a dynamically discovered skill directory for tracking
 * Called when addSkillDirectories is invoked
 */
export function trackSkillDir(dir: string, skills: Command[]): void {
  const skillNames = skills.map((s) => s.name)
  trackedDirs.set(dir, { dir, skills: skillNames })
}

/**
 * Handle directory deletion - removes any skills from the deleted directory
 * Called by skillChangeDetector when unlinkDir is detected
 */
export function handleDirectoryDeletion(dirPath: string): void {
  logForDebugging(`[skills] Handling directory deletion: ${dirPath}`)

  // Find all tracked dirs that are under the deleted path
  const deletedDirs: string[] = []
  for (const [dir] of trackedDirs) {
    if (dir === dirPath || dir.startsWith(dirPath + '/')) {
      deletedDirs.push(dir)
    }
  }

  for (const deletedDir of deletedDirs) {
    const tracked = trackedDirs.get(deletedDir)
    if (!tracked) continue

    // Remove skills from dynamicSkills
    for (const skillName of tracked.skills) {
      const removed = loadSkillsDir.removeDynamicSkill(skillName)
      if (removed) {
        logForDebugging(`[skills] Removed dynamic skill ${skillName} from deleted dir ${deletedDir}`)
      }
      // Also remove from activated conditional skills
      loadSkillsDir.deactivateConditionalSkill(skillName)
    }
    trackedDirs.delete(deletedDir)
  }

  // If any skills were removed, emit the signal
  if (deletedDirs.length > 0) {
    loadSkillsDir.emitSkillsLoaded()
  }
}

/**
 * Unregister a skill directory when it's removed
 */
export function untrackSkillDir(dir: string): void {
  trackedDirs.delete(dir)
}

/**
 * Check if a directory is tracked
 */
export function isTrackedDir(dir: string): boolean {
  return trackedDirs.has(dir)
}

/**
 * Get all tracked directories
 */
export function getTrackedDirs(): string[] {
  return [...trackedDirs.keys()]
}
