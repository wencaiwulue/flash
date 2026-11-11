---
commit: d2fafcde7d75171be093fd40ec8d954c0f326d21
title: "Implement daemon and remote control server lifecycle"
date: 2026-11-10T20:11:39+08:00
status: implemented
---

# Implement daemon and remote control server lifecycle

## Background and requirements

实现 daemon supervisor、worker registry 和 SDK Remote Control server 生命周期。

## Actual scope

- Changed files: 11
- Diff statistics: 11 files changed, 555 insertions(+), 6 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
scripts/build.ts
src/commands/remoteControlServer/index.ts
src/commands/remoteControlServer/server.ts
src/daemon/main.ts
src/daemon/supervisor.ts
src/daemon/workerRegistry.ts
tests/daemon.test.ts
tests/enabledFeatures.test.ts
tests/fixtures/verify-enabled-features.ts
```

## Protocol, dependencies, and security

复用现有 remote-control 协议，不伪造 Cloud 连接。

## Acceptance and verification

重试、停止、PID 清理、enable/disable 和组合构建。

## Remaining / unimplemented boundaries

真实 Cloud session 未在该提交验收。
