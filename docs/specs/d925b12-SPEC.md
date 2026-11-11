---
commit: d925b128abfd8ecd0cc36a26364b497083fd305e
title: "Integrate open computer use and browser MCP"
date: 2026-11-10T23:43:33+08:00
status: implemented
---

# Integrate open computer use and browser MCP

## Background and requirements

接入 Zavora Computer Use 与 Playwright MCP，提供真实 WebBrowser。

## Actual scope

- Changed files: 20
- Diff statistics: 20 files changed, 401 insertions(+), 140 deletions(-)

```text
bun.lock
docs/RELEASE.md
docs/STATUS.md
package.json
scripts/build.ts
src/external-stubs/claude-for-chrome-mcp.ts
src/external-stubs/computer-use-mcp.ts
src/main.tsx
src/services/mcp/client.ts
src/skills/bundled/claudeInChrome.ts
src/skills/bundled/index.ts
src/tools/WebBrowserTool/WebBrowserTool.ts
src/utils/claudeInChrome/browserTools.ts
src/utils/claudeInChrome/mcpServer.ts
src/utils/claudeInChrome/setup.ts
src/utils/computerUse/mcpServer.ts
src/utils/computerUse/setup.ts
tests/enabledFeatures.test.ts
tests/fixtures/verify-enabled-features.ts
tests/openBackends.test.ts
```

## Protocol, dependencies, and security

保留 allowlist/权限拒绝，浏览器使用 isolated profile。

## Acceptance and verification

真实工具目录、权限拒绝及本地浏览器导航与 snapshot。

## Remaining / unimplemented boundaries

原生桌面控制仍需授权交互桌面，当时未执行。
