import { createHash } from "crypto";
import type { Command } from "../types/command";
import { getAdditionalDirectoriesForClaudeMd } from "../bootstrap/state";
import { logForDebugging } from "../utils/debug";
import { isBareMode, isEnvTruthy } from "../utils/envUtils";

// Types
export interface SkillCacheKeyOptions {
  cwd: string;
  additionalDirs: string[];
  remote: boolean;
}

export interface BoundedSkillCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface SkillLifecycleControllerOptions {
  watcherFactory?: () => SkillWatcher;
  loadSkillsFn?: (dir: string) => Promise<Command[]>;
}

export interface SkillWatcher {
  on: (event: string, callback: (path: string) => void) => void;
  off: (event: string, callback: (path: string) => void) => void;
  close: () => void | Promise<void>;
  emit?: (event: string, path: string) => void; // For testing
}

interface CacheEntry {
  skill: Command;
  timestamp: number;
}

// Cache key implementation
export function skillCacheKey(options: SkillCacheKeyOptions): string {
  const { cwd, additionalDirs, remote } = options;
  // Create a stable string representation
  const keyString = JSON.stringify({
    cwd,
    additionalDirs: [...additionalDirs].sort(),
    remote,
    bare: isBareMode(),
    disablePolicySkills: isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS),
  });
  // Hash for stable and concise key
  return createHash("sha256").update(keyString).digest("hex");
}

// Bounded skill cache with TTL
export function createBoundedSkillCache(options: BoundedSkillCacheOptions) {
  const { ttlMs, maxEntries } = options;
  const cache = new Map<string, CacheEntry>();

  const evictExpired = () => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (now - entry.timestamp > ttlMs) {
        cache.delete(key);
      }
    }
  };

  const evictOverflow = () => {
    while (cache.size > maxEntries) {
      // Remove oldest entry
      const oldestKey = cache.keys().next().value;
      if (oldestKey) {
        cache.delete(oldestKey);
      } else {
        break;
      }
    }
  };

  return {
    async put(key: string, skill: Command) {
      evictExpired();
      cache.set(key, { skill, timestamp: Date.now() });
      evictOverflow();
    },
    async get(key: string): Promise<Command | undefined> {
      evictExpired();
      const entry = cache.get(key);
      return entry?.skill;
    },
    async delete(key: string): Promise<boolean> {
      return cache.delete(key);
    },
    async dispose() {
      cache.clear();
    },
    get size() {
      return cache.size;
    },
    // For testing
    _evictExpired: evictExpired,
    _cache: cache,
  };
}

// Skill lifecycle controller
export function createSkillLifecycleController(options: SkillLifecycleControllerOptions = {}) {
  const { watcherFactory, loadSkillsFn } = options;

  // Active conditional skills
  const activeConditionalNames = new Set<string>();
  // Track directories and their watchers
  const watchedDirs = new Map<string, SkillWatcher>();
  // Cache for loaded skills
  const loadedSkills = new Map<string, Command[]>();

  const activate = async (name: string) => {
    activeConditionalNames.add(name);
  };

  const deactivate = async (name: string) => {
    activeConditionalNames.delete(name);
  };

  const watchDirectory = (dir: string, watcher: SkillWatcher) => {
    if (watchedDirs.has(dir)) {
      return; // Already watching
    }

    watchedDirs.set(dir, watcher);

    watcher.on("unlinkDir", (path: string) => {
      if (path === dir || path.startsWith(dir + "/")) {
        // Directory removed - invalidate skills from this directory
        logForDebugging(`Skill directory removed: ${path}`);
        // Remove any skills that came from this directory
        for (const [key, skills] of loadedSkills.entries()) {
          const filteredSkills = skills.filter((skill) => {
            return !skill.skillRoot?.startsWith(path);
          });
          if (filteredSkills.length !== skills.length) {
            if (filteredSkills.length > 0) {
              loadedSkills.set(key, filteredSkills);
            } else {
              loadedSkills.delete(key);
            }
          }
        }
        // Deactivate any conditional skills associated with this path
        for (const name of activeConditionalNames) {
          if (name.includes(path) || path.includes(name)) {
            deactivate(name);
          }
        }
      }
    });
  };

  const unwatchDirectory = async (dir: string) => {
    const watcher = watchedDirs.get(dir);
    if (watcher) {
      await watcher.close();
      watchedDirs.delete(dir);
    }
  };

  const dispose = async () => {
    // Close all watchers
    for (const watcher of watchedDirs.values()) {
      await watcher.close();
    }
    watchedDirs.clear();
    activeConditionalNames.clear();
    loadedSkills.clear();
  };

  return {
    activate,
    deactivate,
    watchDirectory,
    unwatchDirectory,
    dispose,
    activeConditionalNames,
    // Expose for testing
    _watchedDirs: watchedDirs,
    _loadedSkills: loadedSkills,
  };
}
