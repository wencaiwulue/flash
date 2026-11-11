---
commit: adaa8fffa7c7c536d782616f8f7e187de637a582
title: "Implement env-less perpetual continuity"
date: 2026-11-11T00:40:35+08:00
status: implemented
---

# Implement env-less perpetual continuity

## Background and requirements

实现 env-less perpetual 的 cse/SSE 复用、401 重建和 pointer 保留/归档。

## Actual scope

- Changed files: 10
- Diff statistics: 10 files changed, 358 insertions(+), 58 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
src/bridge/envLessBridgePointer.ts
src/bridge/initReplBridge.ts
src/bridge/remoteBridgeCore.ts
src/bridge/replBridge.ts
src/tools/WorkflowTool/createWorkflowCommand.ts
tests/envLessPerpetual.test.ts
tests/fixtures/env-less-perpetual-check.ts
tests/perpetualBridge.test.ts
```

## Protocol, dependencies, and security

临时 teardown 保留 session，仅显式 archive 清理 pointer；不重放重复事件。

## Acceptance and verification

独立进程验证同 ID、seq 恢复、401 重建与归档清理。

## Remaining / unimplemented boundaries

真实 OAuth 服务端 perpetual round trip 未在该提交执行。
