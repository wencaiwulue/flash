---
commit: d925b128abfd8ecd0cc36a26364b497083fd305e
title: "Integrate open computer use and browser MCP"
date: 2026-11-10T23:43:33+08:00
status: implemented
kind: component
---

# Integrate open computer use and browser MCP

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的外部 computer-use 与 Chrome 适配器仍以私有包不可用为边界：Computer Use 的工具目录为空、server 和 bindSessionContext 直接抛错，浏览器 BROWSER_TOOLS 也是空数组，因而不存在可供模型调用的真实 schema 或动作分发。构建未启用 CHICAGO_MCP/WEB_BROWSER_TOOL，setup 同步读取这些空目录。已有 in-process MCP、Computer Use 权限 UI 和 Chrome 配置可以复用，但缺少开放后端来兑现这些接口。

需要把 Zavora Computer Use 与 Playwright MCP 接入现有工具注册和权限链，使 ListTools 来自真实 MCP server 而不是手工伪造的宽松 schema，同时保留 Computer Use 的 app/flag 拒绝路径。浏览器应运行于隔离、headless 的 Chromium profile，并通过真实 WebBrowser 调用导航和 snapshot，而不是宣称接管用户现有 Chrome。验证必须分开陈述：真实 MCP 元数据与权限拒绝、真实本地浏览器页面是已覆盖范围，授权原生桌面鼠标键盘及完整 app allowlist 实机链路仍未执行。

## 目标与非目标

### 目标

- 引入固定版本的 Zavora 与 Playwright MCP，替换空的私有包 stub 并启用外部构建特性。
- 以 in-memory MCP client 获取真实 Computer Use 工具名称、描述和 inputSchema，并用于 setup 与 ListTools。
- 在真实 Zavora callTool 前保留 mutating-tool 权限请求、必要 flag 检查、空 app allowlist 和拒绝短路。
- 以 isolated/headless 配置建立 Playwright server/client，提供真实 WebBrowser action 分发及可选 origin 限制。
- 把异步目录和 server 创建贯穿 Chrome/CU setup、in-process/stdio MCP、skill 和 main 启动链。
- 用真实 Zavora schema/拒绝测试和真实本地 Chromium 导航/snapshot/close 测试固定能力边界。

### 非目标

- 不宣称已经控制用户当前 Chrome tab、继承其登录态或接通旧 extension socket 权限协议。
- 不把 Zavora 工具目录和权限拒绝测试解释为原生桌面点击、键盘、剪贴板或 TCC 已实机通过。
- 不声称新 dispatcher 已按 target_app 对授权 bundle ID 做逐项匹配；当前检查的是 app allowlist 是否为空及所需 flags。
- 不为 WebBrowser 添加默认站点白名单；只有配置 PLAYWRIGHT_MCP_ALLOWED_ORIGINS 时才传 allowedOrigins。
- 不把同步 buildComputerUseTools 的兼容宽松 schema 当作真实 setup/ListTools 数据来源。

## 方案架构与数据流

package.json 固定 @zavora-ai/computer-use-mcp 7.8.0 与 @playwright/mcp 0.0.85；bun.lock 将项目直接使用的 @modelcontextprotocol/sdk 锁为 1.29.0，将 Zavora 的 MCP client/core/node/server 依赖锁为 2.0.0，并锁定 Playwright 和各平台原生可选包。build.ts 与特性夹具开启 CHICAGO_MCP、WEB_BROWSER_TOOL，main 仍在 macOS、交互式及 getChicagoEnabled 门槛下初始化 Computer Use，浏览器则由 WebBrowser 注册进入基础工具池。

computer-use-mcp.ts 的 connectClient 创建 profile=desktop 的真实 Zavora server，以 InMemoryTransport linked pair 连接 MCP Client。clientPromise 缓存连接，失败时清空以便重试；listOpenComputerUseTools 直接映射服务端 name、description、inputSchema。setupComputerUseMCP 和 createComputerUseMcpServerForCli 都改用这份真实目录，后者在 adapter disabled 时仍返回空工具，避免 advertise 不可用动作。

bindSessionContext 返回真实异步 dispatcher，仅对 MUTATING_TOOLS 做本地权限包装。read_clipboard、write_clipboard、key/hold_key 分别映射 clipboardRead、clipboardWrite、systemKeyCombos；缺 flag 或 allowedApps 为空时调用既有 onPermissionRequest。denied 非空、granted 为空或响应仍缺必要 flag 都会在 Zavora callTool 前抛错，成功才 onAllowedAppsChanged。当前实现没有按 target_app 逐项核验已授权 app，也没有使用传入 adapter/coordinateMode 重建旧原生执行链。

真实 Computer Use 调用沿用现有 wrapper override 和 session context，dispatcher 将 arguments 传给 client.callTool 并保留 content/isError。MCP allowedTools 继续绕过普通权限弹窗，由上述专用权限层负责 mutating 动作。同步 buildComputerUseTools 仅为兼容旧调用保留 MUTATING_TOOLS 的宽松目录，实际异步 setup 和 ListTools 不依赖它。

claude-for-chrome-mcp.ts 的 browserConfig 固定 isolated=true 与 headless=true，可选解析 PLAYWRIGHT_MCP_ALLOWED_ORIGINS。createConnection 返回真实 Playwright server，getOpenBrowserClient 以另一组 in-memory transport 建立单例 client，失败清空 Promise，closeOpenBrowserClient 提供测试和生命周期清理。旧 ClaudeForChromeContext 不再是该 backend 的执行边界，隔离 profile 也不共享用户 Chrome 登录状态。

WebBrowserTool 以非空 action 和默认为空对象的 arguments record 作为统一输入，prompt 动态列出真实 Playwright 动作并要求未返回结果不得声称成功。call 直接 client.callTool，仅保留 result.content、丢弃 result.isError，再将 content 序列化进普通 tool_result；工具标记非只读、非并发安全，checkPermissions 固定 allow，因此站点约束主要来自可选 origin 配置和 MCP server，而不是另一层交互授权。

browserTools.ts 将静态 BROWSER_TOOLS 改为 Promise 目录缓存，失败可重试；Chrome setup、availability、skill prompt 与 allowedTools 全部异步读取。services/mcp/client.ts 和 stdio mcpServer 对 createConnection 使用 await，main 对 Chrome/CU setup 同步调整为异步等待。bundled skill 改由 WEB_BROWSER_TOOL 注册，文案明确 isolated Playwright Chromium 与 accessibility tree，不再宣称现有 Chrome tab。

测试分两层：Zavora 测试读取真实 schema 并在空 allowlist/全 false flags 下证明 click 被拒绝，Playwright 测试启动 127.0.0.1 随机端口 HTTP server，经 WebBrowser 依次执行 browser_navigate、browser_snapshot、browser_close，核对标题和正文。enabledFeatures 再验证编译产物有 42 个非空工具且包含 WebBrowser，三种证据各自回答不同问题。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `bun.lock`，符号 `@zavora-ai/computer-use-mcp@7.8.0` | 锁定开放 MCP、Playwright 和平台原生可选依赖，保证后端版本可复现。 |
| 变更 | `docs/RELEASE.md`，符号 `## Open Computer Use and Browser backends` | 记录真实目录/权限/本地浏览器验证和原生桌面未实跑边界。 |
| 变更 | `docs/STATUS.md`，符号 `Computer Use via Zavora MCP` | 分别标记 Computer Use 的 metadata/permissions 与 Browser 的 real isolated browser，更新 142/611。 |
| 变更 | `package.json`，符号 `"@playwright/mcp": "0.0.85"` | 声明 Playwright MCP 0.0.85 和 Zavora 7.8.0 两个开放后端依赖。 |
| 变更 | `scripts/build.ts`，符号 `CHICAGO_MCP` | 在外部构建启用 Computer Use 与 WebBrowser 条件实现。 |
| 变更 | `src/external-stubs/claude-for-chrome-mcp.ts`，符号 `getOpenBrowserClient` | 以真实 Playwright createConnection、隔离配置和单例 client 替换空私有 Chrome stub。 |
| 变更 | `src/external-stubs/computer-use-mcp.ts`，符号 `bindSessionContext` | 实现真实 Zavora server/catalog、mutating 权限包装和 callTool 分发。 |
| 变更 | `src/main.tsx`，符号 `await setupComputerUseMCP()` | 等待异步 Chrome/CU 目录和 setup，保留平台、交互和 gate 条件。 |
| 变更 | `src/services/mcp/client.ts`，符号 `await createClaudeForChromeMcpServer(context)` | 在既有 in-process Chrome MCP 分支等待异步 Playwright server 创建。 |
| 变更 | `src/skills/bundled/claudeInChrome.ts`，符号 `registerClaudeInChromeSkill` | 将 skill 语义改为 isolated Playwright Chromium，并动态列出真实 MCP 动作。 |
| 变更 | `src/skills/bundled/index.ts`，符号 `feature('WEB_BROWSER_TOOL')` | 按开放浏览器编译特性注册 skill，不再依赖私有 Chrome 自动启用判断。 |
| 变更 | `src/tools/WebBrowserTool/WebBrowserTool.ts`，符号 `WebBrowserTool` | 新增真实 Playwright action 工具，动态展示目录并返回 MCP content。 |
| 变更 | `src/utils/claudeInChrome/browserTools.ts`，符号 `getBrowserTools` | 将空静态目录替换为可失败重试的异步真实目录缓存。 |
| 变更 | `src/utils/claudeInChrome/mcpServer.ts`，符号 `await createClaudeForChromeMcpServer(context)` | 使 stdio browser server 适配异步 Playwright 初始化。 |
| 变更 | `src/utils/claudeInChrome/setup.ts`，符号 `setupClaudeInChrome` | 异步检查真实可用性并生成 MCP allowedTools，保留原有动态配置入口。 |
| 变更 | `src/utils/computerUse/mcpServer.ts`，符号 `createComputerUseMcpServerForCli` | 以真实 Zavora ListTools 替换手工目录，并在 adapter disabled 时返回空列表。 |
| 变更 | `src/utils/computerUse/setup.ts`，符号 `setupComputerUseMCP` | 异步读取真实 Zavora 工具名并映射为 mcp__computer-use__ allowedTools。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.toolCount` | 固定 42 个非空工具并检查 WebBrowser 进入实际构建产物。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `CHICAGO_MCP` | 让独立特性构建启用与正式构建一致的开放后端 flags。 |
| 变更 | `tests/openBackends.test.ts`，符号 `describe('open Computer Use and Browser backends'` | 覆盖真实 Zavora schema/拒绝和真实本地 Chromium 导航/snapshot/close。 |
| 复用 | `src/services/mcp/InProcessTransport.ts`，符号 `createLinkedTransportPair` | 复用 CLI 的进程内 MCP transport 连接开放 server 与客户端。 |
| 复用 | `src/utils/computerUse/wrapper.tsx`，符号 `getComputerUseMCPToolOverrides` | 复用 Computer Use 工具 override、session context 和权限对话连接点。 |
| 复用 | `src/utils/computerUse/gates.ts`，符号 `getChicagoEnabled` | 复用 Computer Use 的平台/订阅/功能开关和 coordinate mode 入口。 |
| 复用 | `src/Tool.ts`，符号 `buildTool` | 复用统一工具定义、schema、调用和 tool_result 映射框架。 |
| 复用 | `src/services/mcp/mcpStringUtils.ts`，符号 `buildMcpToolName` | 复用 MCP 工具命名规则生成 allowedTools。 |

## 关键决策与工程取舍

- 以真实 MCP ListTools 作为目录唯一来源，而不是为开放后端手写近似 schema；这样模型看到的字段由实际 server 提供。
- 复用现有 Computer Use session 权限上下文和 wrapper override，把开放调用限制在既有 mutating-tool 审批边界之后。
- 浏览器明确选择隔离 headless profile，避免把旧 Chrome extension 的当前 tab、认证和登录态假设带进新 backend。
- 两个开放 client 都缓存 Promise 且在失败时清除，避免并发重复连接，同时允许暂时初始化失败后重试。
- 将 Chrome/CU 初始化改为异步，而不是同步返回空目录或阻塞 fake schema，保证启动链等待真实目录就绪。
- 以本地 HTTP 页面验证真实浏览器，而不是只 mock client.callTool；原生桌面则保持单独的授权环境验收。

### 备选方案与回溯分析

- 回溯性比较：可以继续保留空目录并等待私有包，但外部构建永远没有可调用能力；实际引入公开版本化 MCP 包，承担新依赖和异步初始化成本。
- 回溯性比较：可以手工复制 Zavora/Playwright schema，短期免去 client 连接，却容易与 server 漂移；实际通过 in-memory MCP 直接查询目录。
- 回溯性比较：可以复用用户默认 Chrome profile 获得登录态，但会混淆权限与数据边界；实际选择 isolated headless Chromium，并明确不继承现有会话。
- 回溯性比较：可以用完全模拟的 browser client 做快速单元测试，但无法证明导航和 accessibility snapshot；实际运行本地 HTTP 与真实 Chromium，同时不把它外推为桌面控制证据。

## 安全与协议边界

- Computer Use 的 MCP allowedTools 不是无审批通道，mutating 调用仍经过 session 权限请求、必要 flag 与拒绝短路。
- 权限拒绝、无 granted app 或缺少必要 flag 时不会调用 Zavora，测试直接固定 click 的 denied-action 行为。
- 当前 app 检查只判断 allowlist 非空，并未证明 target_app 与授权项逐项匹配；实机授权链路必须另行验收。
- Playwright 默认隔离且不继承 Chrome 凭据，可用 allowedOrigins 环境变量限制站点；WebBrowser 自身固定 allow，不能宣称默认存在站点白名单。
- 开放 client 失败会清除缓存并抛错，不以空 schema 或成功内容掩盖初始化失败；browser prompt 禁止无结果的成功声明。
- 锁文件固定平台原生依赖版本，实际桌面二进制行为仍需在对应授权 OS/桌面环境验证。

## 验收标准

- Zavora ListTools 返回非空真实目录，包含 screenshot，工具描述和 inputSchema 来自 MCP server。
- Computer Use 在空 app allowlist 和权限全 false 时请求审批，用户拒绝后 click 抛错且不进入真实 callTool。
- setup 与 CLI ListTools 使用真实目录，adapter disabled 时不向模型暴露 Computer Use 工具。
- Playwright client 以 isolated/headless 配置启动，WebBrowser 能把 action/arguments 分发给真实 MCP。
- 真实本地 Chromium 能导航到随机端口页面，返回 Flash Browser Test，并在 snapshot 中返回 Local content，随后正常 close。
- 异步 setup、in-process/stdio server、skill 与 main 启动链接口一致，目录连接失败可清理后重试。
- 外部特性档包含 42 个非空工具及 WebBrowser，提交内记录 142 tests/611 assertions 和构建结果。
- 原生桌面控制、真实 app 逐项授权、现有 Chrome tab 和远程网站登录态没有被本地浏览器证据替代。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | 该 revision 直接创建 Zavora desktop server 并通过 MCP listTools 映射真实 schema，bindSessionContext 在 callTool 前处理权限拒绝。 | `src/external-stubs/computer-use-mcp.ts`，符号 `listOpenComputerUseTools`，revision `commit` |
| test-added | 新增 Zavora 测试读取真实工具 schema，并以空 allowlist、全 false flags 和 user_denied 验证 click 被阻止；此项不是原生桌面点击成功测试。 | `tests/openBackends.test.ts`，符号 `enumerates real Zavora tool schemas and blocks denied actions`，revision `commit` |
| test-added | 新增浏览器测试启动真实本地 HTTP server，通过 WebBrowser 执行 navigate、snapshot、close，并核对标题与正文；这是 isolated Chromium 的本地证据。 | `tests/openBackends.test.ts`，符号 `navigates a real isolated browser to a local page`，revision `commit` |
| test-added | 特性档回归将工具数从 41 更新为 42，并新增 WebBrowser 非空注册断言。 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.toolCount`，revision `commit` |
| recorded-command-pass | 提交内 STATUS 记录 bun test 已通过 142 个测试、611 个断言；这是 at-commit 历史记录，不是本次文档编写重新执行的结果。 | `docs/STATUS.md`，符号 ``bun test``，revision `commit` |
| recorded-command-pass | 提交内 STATUS 记录 bun run typecheck 零错误，bun run build 完成 CLI、SDK 与声明构建。 | `docs/STATUS.md`，符号 ``bun run typecheck``，revision `commit` |
| recorded-command-pass | 提交内 RELEASE 的 Open Computer Use and Browser backends 段记录 142/611、typecheck、build、declarations、42-tool profile 及真实本地浏览器导航通过，同时明确 native desktop 仍需授权会话。 | `docs/RELEASE.md`，符号 `## Open Computer Use and Browser backends`，revision `commit` |
| not-recorded | 没有授权原生桌面点击、键盘、剪贴板、macOS TCC 或 target_app 逐项授权的实机证据，也没有现有 Chrome 登录态和远程网站的验证记录。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- Zavora 的原生桌面动作、平台二进制、TCC 和真实权限 UI 到 app grant 的完整链路仍需授权交互桌面/VM 验证。
- bindSessionContext 只要求 allowedApps 非空，没有按 target_app 精确匹配，且未使用旧 adapter/coordinateMode 的完整原生行为。
- WebBrowser 固定 allow 且默认没有 origin allowlist；生产使用时需要评估 PLAYWRIGHT_MCP_ALLOWED_ORIGINS 与页面副作用。
- WebBrowser 丢弃 MCP 工具级 isError，失败内容可能被包装成普通 tool_result，新增测试只覆盖成功导航、snapshot 和 close。
- 真实浏览器覆盖仅限 headless 本地页面，未验证 headed 浏览器、远程网站、现有 Chrome tab 或登录态。
- at-commit STATUS 的 Next implementation order 第 1、2 项重复为 changed-file、cron 和 LSP lifecycle regressions，顺序记录尚未清理。
