---
commit: 02bc3c2efcd3f3d7978da33b2683e9d392f3220c
title: "Unblock remote control and Cloud persistence"
date: 2026-11-10T15:53:19+08:00
status: implemented
---

# Unblock remote control and Cloud persistence

## Background and requirements

实现 env-less remote-control handle、FIFO 队列、权限响应和 Cloud Files 路径映射。

## Actual scope

- Changed files: 15
- Diff statistics: 15 files changed, 1932 insertions(+), 36 deletions(-)

```text
README.md
docs/RELEASE.md
docs/STATUS.md
src/assistant/daemonBridge.ts
src/bridge/initReplBridge.ts
src/bridge/remoteBridgeCore.ts
src/entrypoints/agentSdkTypes.ts
src/services/api/filesApi.ts
src/utils/filePersistence/filePersistence.ts
src/utils/sdkQuery.ts
src/utils/sdkRemoteControl.ts
tests/cloudPersistence.test.ts
tests/daemonBridge.test.ts
tests/perpetualBridge.test.ts
tests/sdkRemoteControl.test.ts
```

## Protocol, dependencies, and security

不猜 xattr 名称或伪造成功 handle，Cloud 使用 Files API。

## Acceptance and verification

fake transport、Cloud pagination/ambiguity/abort 测试及 CI。

## Remaining / unimplemented boundaries

真实 OAuth Cloud/remote-control round trip 未在该提交验证。
