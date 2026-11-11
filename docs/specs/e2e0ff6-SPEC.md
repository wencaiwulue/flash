---
commit: e2e0ff6e0897141823d361204e81aef79922f33b
title: "Make feature profile test CI-independent"
date: 2026-11-10T19:33:02+08:00
status: implemented
---

# Make feature profile test CI-independent

## Background and requirements

使 feature-profile 测试在本地和 CI 的 ToolSearch 配置下确定性通过。

## Actual scope

- Changed files: 3
- Diff statistics: 3 files changed, 6 insertions(+), 3 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
tests/enabledFeatures.test.ts
```

## Protocol, dependencies, and security

固定测试 endpoint 与 ToolSearch，不读取真实凭据。

## Acceptance and verification

独立 Bun 子进程组合构建及 CI。

## Remaining / unimplemented boundaries

无该提交范围内的未实现项。
