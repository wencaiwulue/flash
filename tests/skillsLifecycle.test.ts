import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdir, writeFile, rm, realpath } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { skillCacheKey, trackSkillDir, handleDirectoryDeletion, getTrackedDirs, untrackSkillDir } from '../src/skills/skillLifecycle'
import { addSkillDirectories, getDynamicSkills, activateConditionalSkillsForPaths, clearDynamicSkills, removeDynamicSkill, deactivateConditionalSkill, emitSkillsLoaded } from '../src/skills/loadSkillsDir'
import { skillChangeDetector } from '../src/utils/skills/skillChangeDetector'
import { loadRemoteSkill, releaseCachedSkill } from '../src/services/skillSearch/remoteSkillLoader'
import { getAdditionalDirectoriesForClaudeMd } from '../src/bootstrap/state'

describe('skillsLifecycle', () => {
  describe('skillCacheKey', () => {
    it('generates different keys for different directories', () => {
      const key1 = skillCacheKey({ cwd: '/repo', additionalDirs: [], remote: false })
      const key2 = skillCacheKey({ cwd: '/repo', additionalDirs: ['/team'], remote: false })
      expect(key1).not.toBe(key2)
    })

    it('generates different keys for remote vs local', () => {
      const key1 = skillCacheKey({ cwd: '/repo', additionalDirs: [], remote: false })
      const key2 = skillCacheKey({ cwd: '/repo', additionalDirs: [], remote: true })
      expect(key1).not.toBe(key2)
    })

    it('generates same key for same options regardless of dir order', () => {
      const key1 = skillCacheKey({ cwd: '/repo', additionalDirs: ['/a', '/b'], remote: false })
      const key2 = skillCacheKey({ cwd: '/repo', additionalDirs: ['/b', '/a'], remote: false })
      expect(key1).toBe(key2)
    })
  })

  describe('trackSkillDir', () => {
    it('tracks directories and can retrieve them', () => {
      const testSkill = {
        type: 'prompt' as const,
        name: 'test-skill',
        description: 'Test',
        hasUserSpecifiedDescription: true,
        allowedTools: [],
        source: 'projectSettings',
        skillRoot: '/test/dir',
        loadedFrom: 'skills',
        contentLength: 100,
        isHidden: false,
        progressMessage: 'running',
        userFacingName: () => 'test-skill',
        getPromptForCommand: async () => [{ type: 'text', text: 'test' }],
      }
      trackSkillDir('/test/dir', [testSkill])
      expect(getTrackedDirs()).toContain('/test/dir')
      untrackSkillDir('/test/dir')
    })

    it('untracks directories correctly', () => {
      const testSkill = {
        type: 'prompt' as const,
        name: 'test-skill',
        description: 'Test',
        hasUserSpecifiedDescription: true,
        allowedTools: [],
        source: 'projectSettings',
        skillRoot: '/test/dir',
        loadedFrom: 'skills',
        contentLength: 100,
        isHidden: false,
        progressMessage: 'running',
        userFacingName: () => 'test-skill',
        getPromptForCommand: async () => [{ type: 'text', text: 'test' }],
      }
      trackSkillDir('/test/dir', [testSkill])
      expect(getTrackedDirs()).toContain('/test/dir')
      untrackSkillDir('/test/dir')
      expect(getTrackedDirs()).not.toContain('/test/dir')
    })
  })

  describe('handleDirectoryDeletion', () => {
    it('can be called without throwing', () => {
      expect(() => handleDirectoryDeletion('/nonexistent/dir')).not.toThrow()
    })
  })

  describe('loadSkillsDir lifecycle functions', () => {
    beforeEach(() => {
      clearDynamicSkills()
    })

    it('removeDynamicSkill can be called safely', () => {
      expect(removeDynamicSkill('nonexistent-skill')).toBe(false)
    })

    it('deactivateConditionalSkill can be called safely', () => {
      expect(deactivateConditionalSkill('nonexistent-skill')).toBe(false)
    })

    it('emitSkillsLoaded can be called safely', () => {
      expect(() => emitSkillsLoaded()).not.toThrow()
    })
  })

  describe('skillChangeDetector idempotency', () => {
    it('dispose is idempotent', async () => {
      // Calling dispose multiple times shouldn't throw
      await skillChangeDetector.dispose()
      await skillChangeDetector.dispose()
      expect(true).toBe(true)
    })

    it('resetForTesting can be called multiple times', async () => {
      await skillChangeDetector.resetForTesting()
      await skillChangeDetector.resetForTesting()
      expect(true).toBe(true)
    })
  })

  describe('remoteSkillLoader lifecycle', () => {
    it('releaseCachedSkill can be called safely', () => {
      expect(() => releaseCachedSkill('/nonexistent/path')).not.toThrow()
    })
  })
})
