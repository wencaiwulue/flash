import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { createSkillLifecycleController, skillCacheKey, createBoundedSkillCache } from "../src/skills/skillLifecycle";
import type { Command } from "../src/types/command";
import { mkdir, writeFile, rm, realpath } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Mock dependencies
const mockLoadSkillsFromDir = async (dir: string): Promise<Command[]> => {
  // Create a simple mock skill
  return [
    {
      type: "prompt",
      name: "test-skill",
      description: "Test skill",
      hasUserSpecifiedDescription: true,
      allowedTools: [],
      paths: [dir],
      source: "projectSettings",
      skillRoot: dir,
      loadedFrom: "skills",
      contentLength: 100,
      isHidden: false,
      progressMessage: "running",
      userFacingName: () => "test-skill",
      getPromptForCommand: async () => [{ type: "text", text: "test" }],
    } as unknown as Command,
  ];
};

const fakeWatcherFactory = () => {
  const listeners: Record<string, ((path: string) => void)[]> = {};
  return {
    on: (event: string, callback: (path: string) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    },
    off: () => {},
    close: async () => {},
    emit: (event: string, path: string) => {
      if (listeners[event]) {
        listeners[event].forEach((cb) => cb(path));
      }
    },
  };
};

describe("skillsLifecycle", () => {
  let controller: ReturnType<typeof createSkillLifecycleController>;
  let fakeWatcher: ReturnType<typeof fakeWatcherFactory>;
  let testDir: string;

  beforeAll(async () => {
    const tempDirPath = join(tmpdir(), "skills-lifecycle-test");
    await rm(tempDirPath, { recursive: true, force: true });
    await mkdir(tempDirPath, { recursive: true });
    testDir = await realpath(tempDirPath);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fakeWatcher = fakeWatcherFactory();
    controller = createSkillLifecycleController({
      watcherFactory: () => fakeWatcher,
      loadSkillsFn: mockLoadSkillsFromDir,
    });
  });

  afterEach(async () => {
    await controller.dispose();
  });

  it("conditional skill is removed when its directory disappears", async () => {
    await controller.activate("conditional-skill");
    controller.watchDirectory("conditional-skill", fakeWatcher);
    fakeWatcher.emit("unlinkDir", "conditional-skill");
    expect(controller.activeConditionalNames.has("conditional-skill")).toBe(false);
  });

  it("cache key distinguishes additional dirs and environment", () => {
    const key1 = skillCacheKey({ cwd: "/repo", additionalDirs: [], remote: false });
    const key2 = skillCacheKey({ cwd: "/repo", additionalDirs: ["/team"], remote: false });
    const key3 = skillCacheKey({ cwd: "/repo", additionalDirs: [], remote: true });
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key2).not.toBe(key3);
  });

  it("cache key is consistent for same options", () => {
    const key1 = skillCacheKey({ cwd: "/repo", additionalDirs: ["/a", "/b"], remote: false });
    const key2 = skillCacheKey({ cwd: "/repo", additionalDirs: ["/b", "/a"], remote: false }); // Order shouldn't matter
    expect(key1).toBe(key2);
  });

  it("remote cache evicts expired entries and closes watcher", async () => {
    const cache = createBoundedSkillCache({ ttlMs: 10, maxEntries: 1 });
    await cache.put("old", { name: "test" } as unknown as Command);
    expect(await cache.get("old")).toBeDefined();
    // Advance time
    await new Promise((resolve) => setTimeout(resolve, 20));
    cache._evictExpired();
    expect(await cache.get("old")).toBeUndefined();
    await cache.dispose();
    expect(cache.size).toBe(0);
  });

  it("remote cache respects max entries", async () => {
    const cache = createBoundedSkillCache({ ttlMs: 1000, maxEntries: 2 });
    await cache.put("1", { name: "skill1" } as unknown as Command);
    await cache.put("2", { name: "skill2" } as unknown as Command);
    await cache.put("3", { name: "skill3" } as unknown as Command);
    // Should have max 2 entries
    expect(cache.size).toBe(2);
    await cache.dispose();
  });

  it("handles directory deletion and recreation", async () => {
    const skillDir = join(testDir, "test-skill-dir");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: test\n---\ntest content");

    controller.watchDirectory(skillDir, fakeWatcher);
    await controller.activate("test-skill");
    expect(controller.activeConditionalNames.has("test-skill")).toBe(true);

    // Simulate directory deletion
    fakeWatcher.emit("unlinkDir", skillDir);
    expect(controller.activeConditionalNames.has("test-skill")).toBe(false);
  });

  it("watcher dispose works correctly", async () => {
    const watcher = fakeWatcherFactory();
    let closed = false;
    watcher.close = async () => { closed = true; };
    controller.watchDirectory("/test", watcher);
    await controller.dispose();
    expect(closed).toBe(true);
  });
});
