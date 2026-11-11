---
commit: 97b13fd5279b917c69462da929db00bba942de6a
title: "Move live validation gating into scripts"
date: 2026-11-11T09:33:58+08:00
status: implemented
---

# Move live validation gating into scripts

## Background and requirements

Move live validation gating into scripts。保持现有 CLI/SDK 接口、feature gating 与权限边界，完成该提交对应的实现、修复或文档工作。

## Actual scope

- Changed files: 3
- Diff statistics: 3 files changed, 12 insertions(+), 8 deletions(-)

```text
.github/workflows/live-checks.yml
scripts/live-cloud-validation.ts
scripts/live-model-validation.ts
```

## Protocol, dependencies, and security

不引入新的凭据、私有协议或绕过现有权限的行为。

## Acceptance and verification

bun test、bun run typecheck、bun run build 及对应 CI 检查。

## Remaining / unimplemented boundaries

无该提交范围内的未实现项。
