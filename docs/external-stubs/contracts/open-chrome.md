# Open Chrome 连接契约

日期：2026-11-11。状态：目标设计，尚未实现；不表示与私有 Claude Chrome 扩展协议兼容。

## 1. 现状与入口

本仓库目前有两条名称相近但后端相同的浏览器路径：

1. `/Users/fengcaiwen/GolandProjects/claude-code/src/tools/WebBrowserTool/WebBrowserTool.ts` 通过 `getOpenBrowserClient()` 暴露 `{action, arguments}`，适合隔离开发浏览器。
2. `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/claudeInChrome/mcpServer.ts` 构造包含 native socket、bridge、配对与权限信息的 `ClaudeForChromeContext`，经 `/src/services/mcp/client.ts` 调 `createClaudeForChromeMcpServer(context)`，用户入口为 `--chrome` 与 `/chrome`。

`/Users/fengcaiwen/GolandProjects/claude-code/src/external-stubs/claude-for-chrome-mcp.ts` 的两个入口都调用 Playwright MCP `createConnection()`，但统一配置为 `isolated:true + headless:true`，且 `createClaudeForChromeMcpServer(_context)` 完全忽略 context。因此：

- WebBrowser 的真实 isolated Chromium 测试有价值，但不能证明真实 Chrome/现有会话可用。
- `claude-in-chrome` 实际并未连接现有 Chrome、已有标签、cookie 或登录态；skill/prompt 与 `/chrome` 的扩展文案超出当前实现。
- 私有 `socketPath/getSocketPaths/onExtensionPaired/bridgeConfig` 字段被类型保留却没有协议实现，不能据此声称扩展兼容。

已安装 `@playwright/mcp` 的真实 `createConnection(config)` 支持 `browser.cdpEndpoint`、`allowedOrigins` 和现有 `BrowserContext`；这是可实现的开放路径。

## 2. 目标与非目标

### 目标

1. **保留 WebBrowser**：独立、默认 headless 的 Playwright Chromium，继续服务开发/CI，不读取用户 Chrome profile。
2. **真实 Chrome**：选择显式 CDP 连接到一个用户同意启动的、使用专用持久 profile 的 Google Chrome 实例；复用其默认 context、已有 tabs、cookies 与登录态。
3. `createClaudeForChromeMcpServer(context)` 消费开放的 logger、CDP endpoint、权限/origin 配置、断线回调与 telemetry，不再忽略 context。
4. 断开/重连 MCP 不隐式清空用户 tabs 或关闭真实 Chrome；失败时不偷偷回退 isolated browser。
5. UI、skill、工具说明和验证状态准确区分 isolated Chromium 与真实 Chrome CDP。

### 非目标

- 不实现或模拟私有 native messaging、`claudeusercontent.com` bridge、设备配对、lightning_turn 或私有扩展工具协议。
- 不声称与 Playwright 浏览器扩展或 Claude 私有扩展任一方 wire-compatible；本方案只使用公开 CDP/Playwright MCP。
- 不承诺接管一个未开启 remote debugging 的既有默认 Chrome 进程。现代 Chrome 还限制默认 data dir 的 CDP，故选择明确的专用 profile。
- 不把日常默认 Chrome profile 复制到临时目录后宣称“同一浏览器会话”，也不在 profile 被锁定时并发启动第二个实例。
- 不将 CDP 端口暴露到局域网/公网，不自动绕过站点权限或用户登录。

## 3. 开放连接设计与 API

### 3.1 两种配置严格分离

```ts
type IsolatedBrowserOptions = {
  kind: 'isolated'
  headless: boolean
  allowedOrigins?: string[]
}

type OpenChromeContext = {
  kind: 'chrome-cdp'
  serverName: string
  logger: Logger
  cdpEndpoint: string             // 默认 http://127.0.0.1:9222，显式开启
  cdpTimeoutMs: number
  allowedOrigins?: string[]
  initialPermissionMode: 'ask' | 'skip_all_permission_checks' | 'follow_a_plan'
  onToolCallDisconnected(): string
  trackEvent(name: string, metadata?: Record<string, unknown>): void
}
```

- WebBrowser 保持 `createConnection({browser:{isolated:true, launchOptions:{headless:true}}, network:{allowedOrigins}})`；其 singleton 只服务 WebBrowser。
- 真实 Chrome 使用 `createConnection({browser:{browserName:'chromium', isolated:false, cdpEndpoint, cdpTimeout}, network:{allowedOrigins}, timeouts:{idle:0}})`。Playwright 在 `isolated:false` 时选择 `browser.contexts()[0]`，因此使用现有默认 context，而不是新建隔离 context。
- 不设置 `userDataDir` 给 Playwright launch，因为本方案是 attach，不是 launchPersistentContext。profile 由 Chrome 启动命令拥有；CDP attach 后不得创建 fresh context 来代替默认 context。
- `getOpenBrowserClient/listBrowserTools/closeOpenBrowserClient` 仅指 isolated client；真实 Chrome 使用独立 singleton/promise 和 `closeOpenChromeClient`，禁止共享 `browserClient`，避免 `browser_close` 或测试清理串掉另一后端。

### 3.2 启动与恢复语义

推荐由 `/chrome` 给出并征得用户确认的启动方式（路径按平台检测）：

```sh
google-chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.claude/chrome/open-cdp-profile"
```

macOS 使用已安装 Google Chrome 的实际 executable path，不依赖 Playwright 下载的 Chromium。首次启动后用户自行登录；以后重启**这个专用实例**会恢复同一 profile 的会话，CDP attach 读取当前 tabs。

- CLI 可以提供“启动/重新连接”动作，但启动前必须检查 endpoint 和 profile lock，不能 kill 已运行 Chrome，不能未经确认关闭其他实例。
- endpoint 只允许 loopback `127.0.0.1`/`[::1]` 的 http(s) 或经严格验证的 loopback websocket URL；拒绝非 loopback、URL userinfo、任意 header token 和 `0.0.0.0`。
- 连接前可用 `/json/version` 验证 Chrome/Chromium 与 webSocketDebuggerUrl，随后交由 Playwright 建连。失败要提示“启动专用 Chrome 并开启 loopback CDP”，不能回退 isolated 后显示成功。
- “现有标签/会话”明确指这个受管专用 Chrome 实例及其持久 profile；未开启 CDP 的日常默认浏览器不在兼容承诺内。

### 3.3 工具与权限

真实 Chrome 工具 schema 来自同一个 `listTools()`，但使用 open Chrome client。工具名可保留 `mcp__claude-in-chrome__*` 作为本地命名空间以减少迁移，description 必须写“real Chrome over public CDP”，不能写私有扩展。

- 初始上下文先执行 tabs list/snapshot，选择已有 tab；只有用户任务需要新页面时才 `browser_tabs(new)`。不得在 connect 时导航 `about:blank` 覆盖当前 tab。
- `initialPermissionMode='ask'` 时，导航、点击、输入、下载、执行 JS 等 mutating/open-world 操作走 MCP client 权限确认；`follow_a_plan` 只允许 plan 中的操作；`skip_all_permission_checks` 仍受 loopback、allowedOrigins 和 OS 边界约束。
- `allowedOrigins` 放入 Playwright `network.allowedOrigins`，不是 UI 装饰；未配置时 UI 必须明确显示可访问所有站点。
- `browser_close` 对真实 Chrome 不沿用 isolated 的“销毁 context”语义：应从真实 Chrome 工具列表中隐藏，提供明确的 `disconnect` 生命周期动作；关闭单个 tab 只能由用户显式选择 `browser_tabs(close)`。
- `WebBrowser.call()` 继续透传 isolated action；真实 Chrome call 必须返回 Playwright 的真实 `content/isError`，不得把工具异常吞成成功文本。

### 3.4 context 字段处理

`createChromeContext()` 改为生成上述开放 context：logger 用于连接/断开日志，endpoint/timeout/origins 用于 Playwright config，permission mode 用于工具权限，disconnect callback 生成用户可见错误，trackEvent 只发送 allowlisted 状态字段。

旧私有字段不再进入开放 context。若为源码兼容暂时保留 deprecated 字段，传入 `bridgeConfig`、socket/pairing 回调时必须显式报“open CDP 不支持该配置”，不能静默忽略后宣称配对成功。`onAuthenticationError/onExtensionPaired` 在 CDP 中没有对应事件，不得伪造调用。

## 4. 状态机

```text
disabled
  → user enables --chrome or /chrome
  → endpoint/profile preflight
       ├─ invalid/non-loopback/no Chrome → failed（无浏览器回退）
       └─ valid → connecting CDP
            → attached/default-context-restored
            → list existing tabs → ready
            → tool call active ⇄ ready
            → CDP disconnected → disconnected（保留 profile/tabs）
                 → 用户 reconnect → connecting
            → MCP close/disconnect → detached（不销毁默认 context）
```

isolated WebBrowser 有独立状态 `unstarted → launching → ready → closed`；其 `browser_close` 可以销毁 isolated context。两个状态机、client cache 和关闭函数不得共享。

连接 Promise 失败时清空对应 cache 以允许重试；旧 client 的 late resolve/reject 不能覆盖新 generation。并发工具调用在真实 Chrome 上串行化，避免 tabs 当前选择互相覆盖。

## 5. 安全与失败语义

- CDP 能读取登录态并控制页面，等同于高权限本地能力；只绑定 loopback，不对外监听，不把 remote debugging port 当身份认证。
- 不读取/复制默认 profile，不自动接受 cookie、下载、文件选择、OAuth、支付或系统对话框。高风险动作继续由 MCP/客户端权限层处理。
- 页面内容、console、snapshot 均不可信；它们不能改变客户端权限模式或伪造工具成功。
- attach、schema enumeration、tool call 和 disconnect 错误必须原样分类传播；`isError:true` 保持为工具错误。严禁连接失败后启动 isolated browser并返回“Chrome 已连接”。
- detached/disconnected 只释放 MCP/Playwright 连接。实现需针对当前 Playwright disposal 行为做保护，不能在 `server.close()` 中默认 close 默认 BrowserContext；真实 tabs 是否仍存在是验收项。
- 日志不含页面正文、cookies、URL query secrets、CDP headers；telemetry 仅状态、工具名、耗时和错误类别。

## 6. 关键文件与复用点

- 重构 `/Users/fengcaiwen/GolandProjects/claude-code/src/external-stubs/claude-for-chrome-mcp.ts`：分离 isolated 与 chrome-cdp config/client/cache，复用真实 `@playwright/mcp.createConnection`。
- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/claudeInChrome/mcpServer.ts`：构造开放 CDP context，删除私有 bridge/native 配置作为开放成功路径。
- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/claudeInChrome/browserTools.ts` 与 `/src/services/mcp/client.ts`：按后端取对应工具列表/client，保留 MCP wrapper 权限与渲染复用点。
- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/commands/chrome/chrome.tsx`：显示 CDP 专用 Chrome 的启动、连接、重连和限制，不再以检测到私有扩展目录作为连接证明。
- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/skills/bundled/claudeInChrome.ts`、`prompt.ts`：先读已有 tabs；真实 Chrome 与 WebBrowser 分工保持清晰。
- 复用 `/Users/fengcaiwen/GolandProjects/claude-code/src/tools/WebBrowserTool/WebBrowserTool.ts` 的 action/schema 透传模式，但不让它接入用户 profile。
- 扩充 `/Users/fengcaiwen/GolandProjects/claude-code/tests/openBackends.test.ts`，保留现有 isolated local-page 测试并新增真实 Chrome attach 测试。

## 7. 测试矩阵

| 层 | 用例 | 必须断言 |
|---|---|---|
| config 单元 | isolated 与 chrome-cdp | 前者 isolated/headless；后者 cdpEndpoint/isolated:false/idle:0；无交叉配置 |
| context 单元 | logger、timeout、origins、permission、telemetry | 均被实际消费；私有配置显式拒绝，不是静默忽略 |
| endpoint | loopback、非 loopback、userinfo、坏 URL、无服务 | 仅合法 loopback 可连接；失败不回退 isolated |
| client 生命周期 | 并发首连、首连失败重试、旧 Promise 迟到、分别 close | 各后端 singleton 独立，无 cross-close/cache 污染 |
| fake Chrome CDP | 默认 context 已有两个 tabs/cookie | attach 后 tabs/cookie 保留；不新建隔离 context、不自动导航 |
| 工具 | tabs list/new/select/close、navigate、snapshot、screenshot、console | 对真实 tab 生效并返回真实结果；错误保持 isError |
| close/disconnect | MCP shutdown、断线、reconnect | 不批量关闭 tabs/默认 context/Chrome；重连看到同一 profile 状态 |
| 权限 | ask/plan/skip、origin deny、高风险页面动作 | 权限决策真实执行；origin 拦截不是仅文案 |
| WebBrowser 回归 | 本地页面 navigate/snapshot/close | isolated 测试继续通过，且不接触 Chrome CDP profile |
| UI/skill | `/chrome`、工具 description、首次动作 | 不声称私有扩展兼容；先列 tabs；状态与后端一致 |

## 8. dist 与 live 验收

1. 先跑 isolated 与 fake-CDP 测试、`bun run typecheck`、`bun run build`，确认 `bun dist/main.js --help` 和 `--version` 可执行。
2. 用 dist 的 WebBrowser 对本地 HTTP fixture 完成 navigate/snapshot/close，证明 isolated 路径未回归；再用 dist 的 `--chrome` 入口连接 fake/real CDP，不能只调用 source `createConnection()`。
3. live 在 macOS 或 Linux 启动**专用持久 profile 的真实 Google Chrome**，预先打开两个可识别 tabs 并登录一个测试站点。连接后断言两个 tabs 和登录态存在，snapshot 来自当前 tab，不自动打开隔离浏览器。
4. 在该 tab 完成一次低风险导航/表单/截图，断开 MCP 后确认 Chrome、tabs、cookie 仍在；重新 attach 后恢复到同一 tab/context。关闭 dist 进程也不能清空 profile。
5. 验证未启动 CDP、错误端口、非 loopback endpoint 均明确失败且没有 isolated 成功假象；验证 `/chrome` 不再要求私有扩展配对。
6. 本验收只标记 `Open CDP / real Chrome verified`。未安装/运行私有扩展时不得声称其协议兼容；未执行真实 Chrome 时 live 必须标记 skipped。
