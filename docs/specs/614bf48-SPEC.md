---
commit: 614bf48f749df56f79562e4c64f765875f8fd880
title: "Enable external features and recover SDK parallel branches"
date: 2026-11-10T18:48:33+08:00
status: implemented
---

# Enable external features and recover SDK parallel branches

## Background and requirements

启用已有外部功能，并在两个 SDK 会话读取路径恢复并行 assistant/tool-result DAG。

## Actual scope

- Changed files: 14
- Diff statistics: 14 files changed, 442 insertions(+), 123 deletions(-)

```text
bun.lock
docs/RELEASE.md
docs/STATUS.md
package.json
scripts/build.ts
src/commands.ts
src/commands/ultraplan.tsx
src/utils/sdkSessions.ts
src/utils/sessionChainRecovery.ts
src/utils/sessionStorage.ts
tests/enabledFeatures.test.ts
tests/fixtures/feature-check.ts
tests/fixtures/verify-enabled-features.ts
tests/sdkSessions.test.ts
```

## Protocol, dependencies, and security

保持 external USER_TYPE，不启用缺失内部工具。

## Acceptance and verification

组合构建、27 工具、SDK 并行分支与分页测试。

## Remaining / unimplemented boundaries

真实 Cloud/remote 服务验证仍未执行。
