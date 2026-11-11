---
commit: d925b128abfd8ecd0cc36a26364b497083fd305e
title: "Integrate open computer use and browser MCP"
date: 2026-11-10T23:43:33+08:00
status: implemented
---

# Implementation plan: Integrate open computer use and browser MCP

## Objective

接入 Zavora Computer Use 与 Playwright MCP，提供真实 WebBrowser。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

保留 allowlist/权限拒绝，浏览器使用 isolated profile。

## Verification sequence

真实工具目录、权限拒绝及本地浏览器导航与 snapshot。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 原生桌面控制仍需授权交互桌面，当时未执行。
