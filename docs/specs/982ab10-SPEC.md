---
commit: 982ab108e16a0919269629256555d7ef9efea707
title: "Enable Buddy and Fork Subagent"
date: 2026-11-10T22:28:04+08:00
status: implemented
---

# Enable Buddy and Fork Subagent

## Background and requirements

启用 Buddy 与 Fork，补 companion soul/reaction 和真实 /fork prompt。

## Actual scope

- Changed files: 10
- Diff statistics: 10 files changed, 332 insertions(+), 29 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
scripts/build.ts
src/buddy/companionObserver.ts
src/commands/buddy/index.ts
src/commands/fork/index.ts
src/screens/REPL.tsx
tests/buddyFork.test.ts
tests/enabledFeatures.test.ts
tests/fixtures/verify-enabled-features.ts
```

## Protocol, dependencies, and security

deterministic bones 与模型 soul 分离，禁止递归 fork。

## Acceptance and verification

companion 持久化、reaction、fork cache placeholder 和 worktree notice。

## Remaining / unimplemented boundaries

模型生成的 companion 个性未在该提交单独做 live 验收。
