---
commit: e92caa6639daf982d3299a485dfc6c0b5ff7f1e7
title: "Implement local skill discovery"
date: 2026-11-10T19:47:22+08:00
status: implemented
---

# Implement local skill discovery

## Background and requirements

实现本地 skill 索引、Fuse 搜索、自然语言回退、去重及多信号 prefetch。

## Actual scope

- Changed files: 11
- Diff statistics: 11 files changed, 564 insertions(+), 17 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
scripts/build.ts
src/services/skillSearch/featureCheck.ts
src/services/skillSearch/localSearch.ts
src/services/skillSearch/prefetch.ts
src/tools.ts
src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts
tests/enabledFeatures.test.ts
tests/fixtures/verify-enabled-features.ts
tests/skillSearch.test.ts
```

## Protocol, dependencies, and security

仅使用本地命令元数据，不调用未知远程协议。

## Acceptance and verification

排名、过滤、turn-zero/write-pivot/subagent prefetch 与缓存失效测试。

## Remaining / unimplemented boundaries

远程 canonical skill 后端当时仍未实现。
