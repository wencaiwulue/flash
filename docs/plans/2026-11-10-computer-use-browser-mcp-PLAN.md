---
commit: d925b128abfd8ecd0cc36a26364b497083fd305e
title: "Integrate open computer use and browser MCP"
date: 2026-11-10T23:43:33+08:00
status: implemented
kind: component
---

# 实施计划：Integrate open computer use and browser MCP

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把 Zavora Computer Use 与 Playwright MCP 接入现有工具注册和权限链，使 ListTools 来自真实 MCP server 而不是手工伪造的宽松 schema，同时保留 Computer Use 的 app/flag 拒绝路径。浏览器应运行于隔离、headless 的 Chromium profile，并通过真实 WebBrowser 调用导航和 snapshot，而不是宣称接管用户现有 Chrome。验证必须分开陈述：真实 MCP 元数据与权限拒绝、真实本地浏览器页面是已覆盖范围，授权原生桌面鼠标键盘及完整 app allowlist 实机链路仍未执行。

- 确认父提交的两个 external-stub 不提供真实目录或调用，现有 wrapper、权限上下文和 MCP in-process 入口可以复用。
- 确认开放包版本支持目标 MCP 接口和平台原生依赖，锁文件必须与 package 声明同步。
- 将真实本地浏览器验证与原生桌面验收分开，测试页面只监听随机本地端口且不依赖用户 Chrome。
- 确认 Computer Use 的专用权限层仍是 mutating 动作的必要边界，不能因 allowedTools 而省略。

## 复用与兼容处理

### 复用现有实现

- 复用 MCP Client/InMemoryTransport 和项目 InProcessTransport，避免另写 server 协议。
- 复用 Computer Use wrapper、session grant flags、onPermissionRequest 和 onAllowedAppsChanged。
- 复用 buildTool、buildMcpToolName、getAllBaseTools 和 bundled skill 注册框架。
- 复用 Chrome/CU 动态 MCP config、stdio server 和 main 启动门槛，只将目录与创建过程改为异步。
- 复用 Bun 特性夹具和干净子进程验证编译后的实际工具池。

### 兼容、迁移与生命周期

- 保留 mcp__computer-use__ 与 mcp__claude-in-chrome__ 命名和动态 MCP config，已有 wrapper 与工具 override 继续工作。
- createComputerUseMcpServer 与 createClaudeForChromeMcpServer 的原调用位置保留，只将必要初始化和 setup 改为 await。
- 同步 buildComputerUseTools 作为兼容 API 保留，但真实异步 setup/ListTools 不依赖其宽松 schema。
- WebBrowser 是新增基础工具，隔离 profile 不改变用户现有 Chrome 配置或登录状态。
- 未开启 CHICAGO_MCP 或不满足 macOS/交互/gate 的环境不会初始化 Computer Use，adapter disabled 仍返回空目录。

## 文件级实施步骤

### 1. 固定开放依赖并启用构建特性

在 package.json 声明 Zavora 7.8.0 和 Playwright MCP 0.0.85，更新 bun.lock 的平台与传递依赖。随后在 build.ts 和特性夹具中加入 CHICAGO_MCP、WEB_BROWSER_TOOL，让后续真实适配器进入外部产物。

涉及位置：`package.json`、`bun.lock`、`scripts/build.ts`、`tests/fixtures/verify-enabled-features.ts`

### 2. 建立 Zavora 真实目录与权限分发

在 computer-use-mcp.ts 创建 desktop server 和单例 MCP client，直接查询真实 ListTools，并实现失败重试与关闭。bindSessionContext 对 mutating 工具检查 grant flags 和 app 状态，拒绝时短路，允许后才 callTool。setup.ts 与 mcpServer.ts 再统一改用真实目录，保留 disabled 时空目录。

涉及位置：`src/external-stubs/computer-use-mcp.ts`、`src/utils/computerUse/setup.ts`、`src/utils/computerUse/mcpServer.ts`

### 3. 建立隔离 Playwright backend 和异步目录

在 claude-for-chrome-mcp.ts 固定 isolated/headless 和可选 origin 配置，创建真实 server/client 及目录缓存。browserTools.ts 提供失败可重试的异步查询，setup.ts、mcpServer.ts、services/mcp/client.ts 和 main.tsx 全部等待真实初始化，不返回伪造的同步工具列表。

涉及位置：`src/external-stubs/claude-for-chrome-mcp.ts`、`src/utils/claudeInChrome/browserTools.ts`、`src/utils/claudeInChrome/setup.ts`、`src/utils/claudeInChrome/mcpServer.ts`、`src/services/mcp/client.ts`、`src/main.tsx`

### 4. 暴露 WebBrowser 与开放 skill 语义

新增 WebBrowserTool，以 action/arguments 调用真实 Playwright client 并序列化 content，prompt 动态列举动作且禁止虚假成功。claudeInChrome skill 改为隔离 Chromium 和 accessibility-tree 说明，bundled index 按 WEB_BROWSER_TOOL 注册，不再假设当前 Chrome tab。

涉及位置：`src/tools/WebBrowserTool/WebBrowserTool.ts`、`src/skills/bundled/claudeInChrome.ts`、`src/skills/bundled/index.ts`

### 5. 补真实后端和特性档回归

在 openBackends.test.ts 读取真实 Zavora schema，构造拒绝权限证明 click 不执行；再启动本地 HTTP server，以真实 WebBrowser 导航、读取 snapshot 并关闭。enabledFeatures.test.ts 固定 42 个非空工具和 WebBrowser，测试后关闭两个 client 与 HTTP server。

涉及位置：`tests/openBackends.test.ts`、`tests/enabledFeatures.test.ts`

### 6. 记录浏览器证据与桌面限制

STATUS 将 Zavora 标为 metadata/permissions，将 Playwright 标为 real isolated browser，并记录 142/611 和构建结果。RELEASE 明确真实本地导航的验收条件，但原生桌面仍需授权会话；不把测试新增、构建结果或本地浏览器扩大为桌面/Chrome 在线证明。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 手工目录与真实 server 可能漂移；所有实际 setup/ListTools 必须来自 listOpenComputerUseTools/listBrowserTools。
- MCP allowedTools 可能绕过普通权限提示；Computer Use 专用 mutating 权限层必须在 callTool 前执行。
- 当前 allowlist 只检查非空，不能替代 target_app 逐项匹配或真实 UI grant 验证。
- WebBrowser 自身固定 allow，缺少默认 origin 限制时页面动作可能产生副作用，部署需显式评估；MCP 工具级 isError 被丢弃也会削弱模型对失败动作的识别。
- 异步 client Promise 若在失败后继续缓存会永久不可用；实现必须清空拒绝 Promise 并提供 close。
- 本地 Chromium 成功不能覆盖原生桌面、现有 Chrome 登录态或远程网站，证据标签必须保持区分。

## 验收顺序

1. 运行开放后端定向测试，确认 Zavora 目录非空、包含 screenshot 且首项具有真实 inputSchema。
2. 在空 app/全 false flags 下拒绝 click，确认抛出 permission denied 且不会到达 Zavora callTool。
3. 启动随机本地端口页面，执行 browser_navigate、browser_snapshot、browser_close，核对标题和 Local content。
4. 在干净 Bun 子进程构建特性档，确认 42 个非空工具及 WebBrowser 注册。
5. 依据 at-commit STATUS 引用 142/611、typecheck、build/declarations，不把本记录静态校验写成历史测试。
6. 在授权桌面/VM 分别验证原生点击、键盘、剪贴板、TCC 和 target_app 授权；在另列环境中验证远程网页与所需登录态。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 开放依赖、锁文件和两个外部构建特性已经加入。
- Zavora 真实目录、mutating 权限拒绝和 callTool 分发已替换空 stub。
- Playwright isolated/headless client、真实目录和异步 Chrome 初始化链已经接通。
- WebBrowser 与开放 browser skill 已注册，外部特性档固定为 42 个非空工具。
- 真实本地 Chromium 导航/snapshot/close 测试已加入，at-commit 文档记录 142/611 和构建。

### 未完成或后续工作

- 授权原生桌面动作和完整 app/target_app 权限链尚未实机验证。
- 现有 Chrome tab、extension 权限协议、登录态和远程网页行为不在本地隔离浏览器验证范围。
- WebBrowser 默认 origin 约束、MCP isError 传播和更细粒度权限策略仍需修正并按部署环境评估。
