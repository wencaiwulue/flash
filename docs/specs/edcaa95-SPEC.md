---
commit: edcaa957458d924bc9c1cfe42b7af59eb9c2db11
title: "Implement proactive state and coordinator workers"
date: 2026-11-10T19:29:50+08:00
status: implemented
---

# Implement proactive state and coordinator workers

## Background and requirements

实现 proactive 状态、idle 调度、Sleep 激活和 Coordinator worker 定义。

## Actual scope

- Changed files: 21
- Diff statistics: 21 files changed, 499 insertions(+), 71 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
scripts/build.ts
src/commands/proactive.ts
src/constants/asyncAgentTools.ts
src/constants/tools.ts
src/coordinator/workerAgent.ts
src/proactive/index.ts
src/proactive/useProactive.ts
src/screens/REPL.tsx
src/tools/FileReadTool/constants.ts
src/tools/FileReadTool/prompt.ts
src/tools/FileWriteTool/constants.ts
src/tools/FileWriteTool/prompt.ts
src/tools/SleepTool/SleepTool.ts
src/tools/SyntheticOutputTool/SyntheticOutputTool.ts
src/tools/SyntheticOutputTool/constants.ts
tests/enabledFeatures.test.ts
tests/fixtures/feature-check.ts
tests/fixtures/verify-enabled-features.ts
tests/proactiveCoordinator.test.ts
```

## Protocol, dependencies, and security

不依赖全局 USER_TYPE=ant，worker 不可递归嵌套 Agent。

## Acceptance and verification

状态转换、调度、worker 工具集与组合构建。

## Remaining / unimplemented boundaries

真实 proactive/multi-worker 模型编排未在该提交验收。
