---
commit: 6ef3352651472a951a3779f7b9f906fbc5ca86ca
title: "Allow live jobs without precreated environment"
date: 2026-11-11T09:18:52+08:00
status: implemented
---

# Allow live jobs without precreated environment

## Background and requirements

Allow live jobs without precreated environment。保持现有 CLI/SDK 接口、feature gating 与权限边界，完成该提交对应的实现、修复或文档工作。

## Actual scope

- Changed files: 1
- Diff statistics: 1 file changed, 3 deletions(-)

```text
.github/workflows/live-validation.yml
```

## Protocol, dependencies, and security

不引入新的凭据、私有协议或绕过现有权限的行为。

## Acceptance and verification

bun test、bun run typecheck、bun run build 及对应 CI 检查。

## Remaining / unimplemented boundaries

无该提交范围内的未实现项。
