---
commit: d925b128abfd8ecd0cc36a26364b497083fd305e
title: Computer Use 与 Browser 后端的实施顺序
date: 2026-11-10
retrospective: true
---

# Computer Use 与 Browser 后端的实施顺序

## 1. 建立两个 in-memory MCP client

**文件：** `src/external-stubs/computer-use-mcp.ts`、`claude-for-chrome-mcp.ts`。

分别创建 Zavora desktop server 和 Playwright server，使用 InMemoryTransport.createLinkedPair 连接。clientPromise 采用 `??=`，catch 清空；close 清引用后 await close。listTools 直接映射真实 description/inputSchema。

Playwright browserConfig 固定 isolated:true、headless:true，并把逗号分隔的 allowed origins 转为数组。

## 2. 实现 Computer Use 权限调度

`bindSessionContext()` 对 MUTATING_TOOLS 计算 requiredFlags；缺 flag 或 allowedApps 为空时调用 onPermissionRequest。denied 非空、granted 为空或 flags 仍缺失时抛错，获准后调用 onAllowedAppsChanged，再执行 callTool。

targetImageSize 取三个约束的最小 scale，并验证有限正数尺寸。

**验收：** `tests/openBackends.test.ts` 先枚举 screenshot 等真实工具，再用 denied permission 验证 click 不会执行。

## 3. 实现 WebBrowserTool 与目录缓存

`src/utils/claudeInChrome/browserTools.ts` 缓存 listBrowserTools Promise，失败清空。WebBrowserTool.prompt 动态列出 actions；call 仅执行传入 action/arguments，并返回 result.content。

**验收：** 启动仅监听 127.0.0.1 随机端口的 HTTP server，执行：

```bash
bun test tests/openBackends.test.ts
```

测试必须验证 browser_navigate 的标题、snapshot 的正文，并在 afterEach 关闭 browser/computer-use client 和 HTTP server。

## 4. 接入 feature 与回归

构建只添加 `CHICAGO_MCP`、`WEB_BROWSER_TOOL`，setup 和 bundled 技能复用开放后端，不再指向不存在的内部包。

```bash
bun test tests/openBackends.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除 WebBrowser 与 feature，再回滚两个 client；不得用静态假 schema、共享非 isolated profile，或忽略权限拒绝来通过检查。
