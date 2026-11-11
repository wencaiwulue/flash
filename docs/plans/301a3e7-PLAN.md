---
commit: 301a3e7fb8da14c45f1bac77ead288302b7f2466
title: "Implement monitoring and simple internal tools"
date: 2026-11-10T19:13:06+08:00
status: implemented
---

# Implementation plan: Implement monitoring and simple internal tools

## Objective

实现 Monitor 行事件、OverflowTest、TerminalCapture、Sleep 与 CtxInspect。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

Monitor 复用 Bash 权限和沙箱；TerminalCapture 仅读现有 tmux pane。

## Verification sequence

真实 shell 行事件、tmux mock runner、工具 schema 与组合构建。

## Completion status and remaining work

- Status: **implemented**
- Remaining: Sleep/CtxInspect 的依赖功能组当时尚未启用。
