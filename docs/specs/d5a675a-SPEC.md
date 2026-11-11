---
commit: d5a675a4df66ff620d7577aaf167bb5749cc08a2
title: "Implement open KAIROS functionality"
date: 2026-11-10T23:23:22+08:00
status: implemented
---

# Implement open KAIROS functionality

## Background and requirements

实现开放 KAIROS assistant/team/session、文件上传、通知、PR 订阅和 dream。

## Actual scope

- Changed files: 18
- Diff statistics: 18 files changed, 828 insertions(+), 36 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
scripts/build.ts
src/assistant/AssistantSessionChooser.tsx
src/assistant/gate.ts
src/assistant/index.ts
src/assistant/sessionDiscovery.ts
src/commands/assistant/assistant.tsx
src/commands/assistant/index.ts
src/commands/subscribe-pr.ts
src/services/prSubscriptions.ts
src/skills/bundled/dream.ts
src/tools/PushNotificationTool/PushNotificationTool.ts
src/tools/SendUserFileTool/SendUserFileTool.ts
src/tools/SubscribePRTool/SubscribePRTool.ts
tests/enabledFeatures.test.ts
tests/fixtures/verify-enabled-features.ts
tests/kairos.test.ts
```

## Protocol, dependencies, and security

复用 OAuth 与 GitHub REST，首次轮询只建立基线。

## Acceptance and verification

隔离 team 初始化、通知适配器、PR 去重和组合构建。

## Remaining / unimplemented boundaries

真实 Cloud/notification/GitHub 往返未在该提交验收。
