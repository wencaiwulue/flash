---
commit: 2bf435a5d3aca3c375da1387f1e33d3ce13db683
title: "Implement history snipping"
date: 2026-11-10T22:42:16+08:00
status: implemented
---

# Implement history snipping

## Background and requirements

实现 snip marker、边界投影、SnipTool 和 force-snip。

## Actual scope

- Changed files: 13
- Diff statistics: 13 files changed, 479 insertions(+), 27 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
scripts/build.ts
src/commands.ts
src/commands/force-snip.ts
src/services/compact/snipCompact.ts
src/services/compact/snipProjection.ts
src/tools/SnipTool/SnipTool.ts
src/tools/SnipTool/prompt.ts
src/types/message.ts
tests/enabledFeatures.test.ts
tests/fixtures/verify-enabled-features.ts
tests/snip.test.ts
```

## Protocol, dependencies, and security

保护最近消息与 tool pair，不改写磁盘 transcript。

## Acceptance and verification

marker 幂等、双向 tool-pair、nudge、REPL/SDK 与命令测试。

## Remaining / unimplemented boundaries

真实长会话裁剪效果未在该提交做 live 验收。
