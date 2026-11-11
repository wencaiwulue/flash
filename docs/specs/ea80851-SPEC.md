---
commit: ea8085139c013577cad3130c35a21fc53a3d8bee
title: "Implement declarative workflow execution"
date: 2026-11-10T20:30:36+08:00
status: implemented
---

# Implement declarative workflow execution

## Background and requirements

实现严格 workflow schema、项目发现、DAG 并发、依赖恢复和本地任务状态。

## Actual scope

- Changed files: 17
- Diff statistics: 17 files changed, 1043 insertions(+), 68 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
scripts/build.ts
src/commands/workflows/index.ts
src/components/tasks/WorkflowDetailDialog.tsx
src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts
src/tools/WorkflowTool/WorkflowPermissionRequest.ts
src/tools/WorkflowTool/WorkflowTool.ts
src/tools/WorkflowTool/bundled/index.ts
src/tools/WorkflowTool/createWorkflowCommand.ts
src/tools/WorkflowTool/discovery.ts
src/tools/WorkflowTool/executor.ts
src/tools/WorkflowTool/runner.ts
src/tools/WorkflowTool/schema.ts
tests/enabledFeatures.test.ts
tests/fixtures/verify-enabled-features.ts
tests/workflow.test.ts
```

## Protocol, dependencies, and security

步骤通过现有 agent runner 与工具权限执行，不绕过权限。

## Acceptance and verification

DAG、skip/retry/kill、依赖失败、任务输出和组合构建。

## Remaining / unimplemented boundaries

真实模型 agent workflow 当时未执行，后续已单独验证。
