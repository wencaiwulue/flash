---
commit: 301a3e7fb8da14c45f1bac77ead288302b7f2466
title: "Implement monitoring and simple internal tools"
date: 2026-11-10T19:13:06+08:00
status: implemented
---

# Implement monitoring and simple internal tools

## Background and requirements

实现 Monitor 行事件、OverflowTest、TerminalCapture、Sleep 与 CtxInspect。

## Actual scope

- Changed files: 14
- Diff statistics: 14 files changed, 706 insertions(+), 42 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
scripts/build.ts
src/components/permissions/MonitorPermissionRequest/MonitorPermissionRequest.tsx
src/tools/CtxInspectTool/CtxInspectTool.ts
src/tools/MonitorTool/MonitorTool.ts
src/tools/OverflowTestTool/OverflowTestTool.ts
src/tools/SleepTool/SleepTool.ts
src/tools/TerminalCaptureTool/TerminalCaptureTool.ts
src/utils/terminalPanel.ts
tests/enabledFeatures.test.ts
tests/fixtures/verify-enabled-features.ts
tests/internalTools.test.ts
tests/monitorToolIntegration.test.ts
```

## Protocol, dependencies, and security

Monitor 复用 Bash 权限和沙箱；TerminalCapture 仅读现有 tmux pane。

## Acceptance and verification

真实 shell 行事件、tmux mock runner、工具 schema 与组合构建。

## Remaining / unimplemented boundaries

Sleep/CtxInspect 的依赖功能组当时尚未启用。
