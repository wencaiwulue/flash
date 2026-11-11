---
commit: ab30aec7490292b93198d53c8436081dd8b06cdf
title: "Integrate SkillHub remote skills"
date: 2026-11-10T23:05:51+08:00
status: implemented
---

# Integrate SkillHub remote skills

## Background and requirements

用 SkillHub REST 实现 canonical skill 搜索、state、resolve、下载和版本缓存。

## Actual scope

- Changed files: 10
- Diff statistics: 10 files changed, 666 insertions(+), 24 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
src/services/skillSearch/prefetch.ts
src/services/skillSearch/remoteSearch.ts
src/services/skillSearch/remoteSkillLoader.ts
src/services/skillSearch/remoteSkillState.ts
src/services/skillSearch/skillhubClient.ts
src/services/skillSearch/telemetry.ts
src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts
tests/remoteSkills.test.ts
```

## Protocol, dependencies, and security

限制 zip 大小/文件数，拒绝路径逃逸与 symlink，不伪造 remote telemetry。

## Acceptance and verification

本地真实 HTTP registry、缓存版本变化及恶意 zip 测试。

## Remaining / unimplemented boundaries

公开/自托管 registry live 验收后续执行。
