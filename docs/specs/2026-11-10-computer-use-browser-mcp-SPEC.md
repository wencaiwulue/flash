---
commit: d925b128abfd8ecd0cc36a26364b497083fd305e
title: 开放 Computer Use 与 Playwright Browser 后端设计
date: 2026-11-10
retrospective: true
---

# 开放 Computer Use 与 Playwright Browser 后端设计

## In-memory MCP 组合

两个后端都在进程内创建真实 MCP server/client，并通过 InMemoryTransport linked pair 连接：Zavora `createComputerUseServer({profile:'desktop'})` 和 Playwright `createConnection(browserConfig())`。

client Promise 在首次调用时创建，连接失败清空以便重试；close 先取 pending 再清全局引用并关闭，避免测试和后续会话复用失效 client。工具目录直接来自 listTools，不再手写不存在的内部工具 schema。

## Computer Use 权限与调用

`bindSessionContext()` 对 MUTATING_TOOLS 检查 grant flags 和 allowedApps：clipboardRead/Write 与 systemKeyCombos 按工具映射，缺 flag 或无允许应用时先请求权限。denied 非空、granted 为空或所需 flag 仍未授予都拒绝调用；获准后同步 apps/flags，再执行 client.callTool。

`targetImageSize()` 同时受 maxWidth/maxHeight/maxPixels 约束，scale 不超过 1，非法尺寸抛 RangeError。

## Playwright Browser

browserConfig 使用 isolated、headless Chromium；`PLAYWRIGHT_MCP_ALLOWED_ORIGINS` 可显式限制来源。`getBrowserTools()` 缓存真实目录并在失败时清空。

WebBrowserTool 的 prompt 动态列出 Playwright actions，call 直接传 action/arguments，只有 MCP 返回内容才进入 tool result，不能把未执行的导航、点击或 screenshot 描述为已发生。

构建新增 `CHICAGO_MCP` 和 `WEB_BROWSER_TOOL`，Chrome/computer-use setup 复用这些开放后端。

## 验收标准

1. 两个 client 单例、失败重试、目录 schema 和 close 生命周期正确。
2. Computer Use 权限拒绝、缺 flag、无 allowedApps 和获准后的 flags 同步正确。
3. Browser isolated/headless 配置、origin allowlist、action 调用和结果透传正确。
4. `openBackends.test.ts` 验证真实 Zavora 工具目录、权限拒绝，以及本地页面的 browser_navigate/snapshot/close。
