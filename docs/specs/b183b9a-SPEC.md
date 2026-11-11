---
commit: b183b9a76948750cf396dd36c62ad06a62221b60
title: "Gate live validation jobs on available environments"
date: 2026-11-11T09:28:02+08:00
status: implemented
---

# Gate live validation jobs on available environments

## Background and requirements

Gate live validation jobs on available environments。保持现有 CLI/SDK 接口、feature gating 与权限边界，完成该提交对应的实现、修复或文档工作。

## Actual scope

- Changed files: 1
- Diff statistics: 1 file changed, 33 insertions(+)

```text
.github/workflows/live-checks.yml
```

## Protocol, dependencies, and security

不引入新的凭据、私有协议或绕过现有权限的行为。

## Acceptance and verification

bun test、bun run typecheck、bun run build 及对应 CI 检查。

## Remaining / unimplemented boundaries

无该提交范围内的未实现项。
