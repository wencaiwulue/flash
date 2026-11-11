---
commit: 9cd4c63193ded6eb916bf734f65a427da193faf0
title: "Add live validation workflows and registry compatibility"
date: 2026-11-11T09:15:44+08:00
status: implemented
---

# Add live validation workflows and registry compatibility

## Background and requirements

加入 live validation workflow 与脚本，兼容 SkillHub global namespace 和响应字段。

## Actual scope

- Changed files: 8
- Diff statistics: 8 files changed, 315 insertions(+), 9 deletions(-)

```text
.github/workflows/live-validation.yml
docs/RELEASE.md
docs/STATUS.md
scripts/live-cloud-validation.ts
scripts/live-desktop-validation.ts
scripts/live-model-validation.ts
scripts/live-skillhub-validation.ts
src/services/skillSearch/skillhubClient.ts
```

## Protocol, dependencies, and security

隔离配置目录，不把 settings/token 写入日志或 artifact。

## Acceptance and verification

真实模型四项与真实 SkillHub registry 返回所有 LIVE_OK。

## Remaining / unimplemented boundaries

Cloud/桌面 job 的环境配置仍需单独提供。
