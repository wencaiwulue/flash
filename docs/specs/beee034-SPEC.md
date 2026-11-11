---
commit: beee034523510ac0425461bb4ffce3250514d693
title: "Support settings-based bearer authentication"
date: 2026-11-11T10:06:54+08:00
status: implemented
---

# Support settings-based bearer authentication

## Background and requirements

支持 settings.json 的 ANTHROPIC_AUTH_TOKEN，保持 Bearer 与 API key 认证互斥。

## Actual scope

- Changed files: 5
- Diff statistics: 5 files changed, 19 insertions(+), 6 deletions(-)

```text
.github/workflows/live-checks.yml
docs/RELEASE.md
docs/STATUS.md
scripts/live-model-validation.ts
src/utils/auth.ts
```

## Protocol, dependencies, and security

不把 token 映射为 Claude OAuth 或 x-api-key，不输出 token。

## Acceptance and verification

本地 settings-based 四项模型验证及 CI 全部通过。

## Remaining / unimplemented boundaries

Claude OAuth 和原生桌面验收仍需独立环境。
