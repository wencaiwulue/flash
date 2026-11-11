---
commit: 6b7bf48b0b4f0af740073eddbc5584f0c598c539
title: "Complete secure storage, marketplace, and SDK controls"
date: 2026-11-10T12:41:48+08:00
status: implemented
---

# Complete secure storage, marketplace, and SDK controls

## Background and requirements

实现 Linux libsecret、npm marketplace 和 SDK 控制接口。

## Actual scope

- Changed files: 30
- Diff statistics: 30 files changed, 2211 insertions(+), 132 deletions(-)

```text
README.md
docs/RELEASE.md
docs/STATUS.md
fixtures/token-count-047328c10822.json
fixtures/token-count-16ee01d18e69.json
fixtures/token-count-29928380af6c.json
fixtures/token-count-2ba1fa95ae15.json
fixtures/token-count-3055987871a6.json
fixtures/token-count-5aa3253b9cf6.json
fixtures/token-count-7c3665664622.json
fixtures/token-count-7e8c7129b3cf.json
fixtures/token-count-927c20722aa4.json
fixtures/token-count-cab7bb453d64.json
fixtures/token-count-efe6c543032e.json
src/cli/print.ts
src/utils/fileCheckpointing.ts
src/utils/fileHistory.ts
src/utils/hooks.ts
src/utils/plugins/marketplaceManager.ts
src/utils/sdkControl.ts
src/utils/sdkQuery.ts
src/utils/secureStorage/index.ts
src/utils/secureStorage/linuxSecretStorage.ts
src/utils/ultraplan/ccrSession.ts
tests/headlessHooks.test.ts
tests/linuxSecretStorage.test.ts
tests/npmMarketplace.test.ts
tests/sdkControls.test.ts
tests/sdkRewind.test.ts
tests/ultraplanPoll.test.ts
```

## Protocol, dependencies, and security

secret JSON 仅经 stdin 传递，npm 禁止生命周期脚本。

## Acceptance and verification

mock secret-tool、npm runner 和 SDK control 回归测试。

## Remaining / unimplemented boundaries

真实 secret-tool/npm/Cloud 环境未在该提交单独验收。
