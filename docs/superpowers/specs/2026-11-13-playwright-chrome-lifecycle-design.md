---
title: Playwright Chrome 生命周期与进程回收设计
date: 2026-11-13
status: draft
---

# Playwright Chrome 生命周期与进程回收设计

## 1. 问题与约束

WebBrowser 工具通过 `@playwright/mcp` 创建隔离 Chromium，但现有 `closeOpenBrowserClient()` 只关闭 MCP client/server。当前 `@playwright/mcp@0.0.85` 的 `createConnection()` 没有把 browser disposer 传给 `BrowserBackend`，所以 transport 关闭和 `browser_close` 都不会必然终止由 MCP 启动的 Chrome。自动化测试结束后仍可能存在带临时 Playwright profile 的孤立浏览器。

问题不能只在测试钩子中处理：生产工具的直接 `client.close()`、应用退出、浏览器崩溃重试、初始化失败、idle 超时和并发关闭都经过同一资源所有权边界。只补一个测试 `kill()` 会继续留下生产泄漏。

设计必须同时满足以下约束：

- isolated Chrome 由当前连接创建并持有，必须在连接终止时关闭。
- 真实 CDP Chrome 是用户启动的附加资源，只能 detach，不能关闭进程、默认 context、标签页或 cookie。
- 只能使用 Playwright 与 MCP 的公共接口，不能依赖 `BrowserBackend` 私有字段或进程名模糊匹配。
- 浏览器启动失败、context 创建失败、重复关闭和 transport 自发关闭都不能绕过回收。
- 新连接不能被上一代连接的迟到 close 误关；关闭失败必须保留可重试路径。
- 不能通过 `pkill`、`killall` 或按 Playwright profile 模式终止机器上的既有进程。

## 2. 设计理由与备选方案

### 2.1 为什么把 browser 所有权移到连接管理层

MCP transport 与 browser 是两个生命周期不同的资源。只关闭 transport 无法表达“谁拥有浏览器”。连接管理层必须显式创建并持有 isolated `Browser`，让 MCP 消费一个已经明确的 `BrowserContext`，再把 browser disposer 纳入统一的 `ManagedConnection.close()`。

`createConnection(config, contextGetter)` 是当前 MCP 提供的公共扩展点。内部传入 `isolated: false`，使 MCP 使用 getter 提供的 context，而不再尝试从 `SimpleBrowser` 创建另一个 context。外部 `createIsolatedBrowserConfig()` 的契约保持不变，避免影响配置测试和其他调用方。

每个 isolated generation 独立维护 browser 集合、pending context、idle timer 和 closing 状态。这样旧 generation 的异步清理不会碰到新 generation，崩溃后的 backend recreation 也能获取新的 context，而不是复用已关闭对象。

### 2.2 为什么关闭要幂等、可等待且可重试

关闭可能同时来自工具、直接 transport close、测试 teardown 和应用 shutdown。若全局引用在 close 完成前被删除，后来的调用者会误以为没有资源可清理，shutdown 因而可能提前结束。

使用按 connection Promise 索引的 close 注册表可以：

- 让相同连接的并发 close 共享同一个 Promise；
- 让无参数 `closeOpenBrowserClient()` 等待所有仍在关闭的 generation；
- 在 close 失败后保留连接清理入口，下一次调用重新执行 disposal，而不是永久缓存失败；
- 在初始化 Promise 已拒绝时把其视为已完成的失败清理，避免永远等待一个不可能成功的初始化。

资源关闭按 client、server、owned browser 的顺序执行，并设置 deadline。即使前一步失败或超时，后续步骤仍会尝试，最终聚合并报告错误。browser disposer 先关闭已启动的 browser 以中断卡住的 context 创建，再等待 pending launch/context 收尾；closing 标志保证迟到完成的 launch 会立即关闭自己。

### 2.3 为什么 `browser_close` 必须按 client 定向关闭

`browser_close` 的调用期间可能发生外部 reset 和新连接创建。无条件关闭当时的全局连接会误伤新 generation。`closeOpenBrowserClient(expectedClient)` 只清理实际执行该 action 的 client；等待期间还会重新确认全局 connection 身份，避免 stale continuation 清除 replacement。

工具异常与清理异常都可能有诊断价值。原始 action 失败时，若清理也失败，使用 `AggregateError` 同时保留两者；不能只用后一个 close 错误覆盖根因。

### 2.4 为什么保留 idle 与崩溃恢复语义

自定义 context getter 绕过了 MCP 默认 browser factory，因此必须显式保留原有的资源行为：

- 使用系统 `chrome` channel，避免干净环境额外依赖 Playwright 下载的 Chromium；
- 保持 Chromium sandbox 和 automation-control 启动参数；
- 每个 browser 都有 idle timer，实际工具调用会刷新它；
- browser 断连后，下一次 backend recreation 重新 launch，而不是复用死 context；
- idle、断连和正常 close 都清除对应 timer，避免计时器继续引用已释放资源。

### 2.5 备选方案与不采用原因

| 备选方案 | 不采用原因 |
|---|---|
| 只在 `afterEach` 杀死测试 Chrome | 无法修复生产工具、直接 transport close 和应用退出路径 |
| 升级 `@playwright/mcp` 期待自动 disposer | 扩大依赖与行为变更范围，仍需验证目标版本是否提供相同语义 |
| 读取 `BrowserBackend` 私有字段或修改 `node_modules` | 私有结构脆弱，打包和升级后容易失效，且不可维护 |
| 按进程名/profile 模式批量 kill | 可能误杀真实 CDP、其他测试或用户进程，不表达资源所有权 |
| 永久缓存一个 context Promise | 启动失败会永久中毒，崩溃后也无法重新创建 browser |
| 关闭全局单例而不记录 in-flight close | 并发 close 和 shutdown 会提前返回，失败清理也无法重试 |
| 为隔离浏览器直接启用 Playwright 下载通道 | 改变原有系统 Chrome 解析行为，增加干净 CI 环境的不确定性 |

## 3. 目标与非目标

### 目标

- 所有 isolated browser 终止入口都能等待实际 browser 清理完成。
- 正常操作、工具失败、启动失败、崩溃恢复、直接 transport close、并发 close 和 idle 都不产生新的孤立浏览器。
- 真实 CDP Chrome 在 detach、拒绝 `browser_close` 和重连后保持可用状态。
- Fake Chrome 测试在成功、失败和中断路径上回收其拥有的进程树，并在退出后删除临时 profile。
- 回归测试使用精确 PID/profile 身份验证，而不是机器级进程总数。

### 非目标

- 不清理或批量终止用户已有浏览器进程。
- 不升级 Playwright/MCP，不改变 CLI 对外工具 schema。
- 不把真实 CDP Chrome 纳入 isolated browser 的强制关闭逻辑。
- 不承诺 opt-in live Chrome、Windows 进程树或所有桌面环境的实机验证。
- 不记录历史测试、CI 或本机进程检查结果作为设计验收证据。

## 4. 架构、模块与数据流

### 4.1 模块职责

- `src/external-stubs/claude-for-chrome-mcp.ts`
  - 创建 isolated browser/context；
  - 跟踪每代 browser、pending context、idle timer 和 close；
  - 提供幂等、可重试、可全局等待的连接清理；
  - 对真实 CDP 只执行 upstream detach，并等待 sidecar/server 关闭。
- `src/tools/WebBrowserTool/WebBrowserTool.ts`
  - 调用实际 client；
  - 在 `browser_close` 后按 client 清理；
  - 保留 action 与 cleanup 的错误因果。
- `src/utils/cleanupRegistry.ts`
  - 复用现有 shutdown registry，在首次创建 isolated connection 时注册统一关闭入口。
- `tests/openBackends.test.ts`
  - 使用真实 Chrome 和 PID/profile 快照验证进程回收；
  - 管理 Fake Chrome 进程组、中断兜底、超时升级和临时 profile。
- `package.json` / `bun.lock`
  - 将与 MCP 已安装版本一致的 Playwright 声明为直接依赖，不引入升级。

### 4.2 创建与使用流程

```text
getOpenBrowserClient()
        │
        ├─ 等待/重试上一代未完成的 close
        │
        ├─ 创建 connection generation
        │       │
        │       └─ MCP 请求 context
        │              │
        │              ├─ chromium.launch()
        │              ├─ 登记 browser 与 idle timer
        │              └─ browser.newContext()
        │
        └─ 返回 MCP Client
                  │
                  ├─ 普通 action：复用 browser，刷新 idle
                  ├─ browser_close：按 client 定向清理
                  └─ 崩溃：下次 backend recreation 创建新 browser
```

### 4.3 关闭流程

```text
工具 / client.onclose / afterEach / shutdown
                    │
                    ▼
       closeOpenBrowserClient(expectedClient?)
                    │
          按 connection 注册 close Promise
                    │
          client.close → server.close → browser.close
                    │
          等待所有 generation；失败保留重试入口
```

真实 CDP 流程不进入 browser disposer：它只等待 upstream client/server 和 Node sidecar 完成 detach。

## 5. 失败语义与工程取舍

| 场景 | 预期语义 |
|---|---|
| launch/newContext 失败 | 关闭已启动 browser；初始化错误可重试，不形成永久缓存 |
| close 期间 launch 才完成 | closing 标志使其立即关闭并退出，不登记为可用 browser |
| newContext 卡住 | 先关闭 browser 以中断创建，再等待 pending 收尾 |
| transport 自发关闭 | 纳入全局 close 注册表；后台异常有消费者，shutdown 可等待 |
| 并发/重复 close | 同 connection 共享关闭；全局 close 等待全部 generation |
| browser.close 失败 | 保留失败状态，后续 close/get 先重试，不直接启动另一批资源 |
| 工具与清理同时失败 | 聚合两个错误，保留原始 action 失败原因 |
| idle 或 browser 崩溃 | 清理 timer；后续工具调用按 MCP 重试语义创建新 browser |
| 真实 CDP detach/upstream 失败 | 等待并报告清理结果，允许重试；绝不杀死附加 Chrome |
| Fake Chrome TERM 无响应 | 对拥有的进程树升级 KILL，确认退出后才删除 profile |
| 测试进程退出 | 对仍登记的 POSIX Fake Chrome 进程组执行最后兜底 |

工程上选择显式生命周期代码换取可验证的资源所有权，而不是把复杂度隐藏到依赖私有实现中。每项异步清理都有边界和错误传播，但进程被强杀或宿主断电仍不属于可保证回收的场景。

## 6. 验收标准

### isolated browser

- 正常导航后调用 `closeOpenBrowserClient()`，返回时本测试新增的 browser root 已退出。
- `browser_close`、直接 `client.close()`、重复/并发 close 和应用 cleanup 都满足同一回收条件。
- 工具失败后仍能清理；重新打开获得新 generation，旧 close 不影响新 browser。
- 启动失败、断连恢复和 idle 路径不会复用已关闭 context，也不会留下迟到启动的 browser。
- 空 Playwright 浏览器缓存下仍使用预期的系统 Chrome，不要求隐式下载浏览器。

### 真实 CDP 与测试 fixture

- 真实 CDP 在 detach、拒绝 `browser_close` 和重连后保持原 PID、默认 context、标签页和 cookie。
- upstream close 完成后才返回，失败可重试。
- Fake Chrome 在启动失败、断言失败、TERM 无响应和测试进程退出时都只终止其拥有的进程树。
- 任一清理步骤失败不会阻止其他清理步骤执行；profile 只在进程退出后删除。

### 工程验收

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test tests/openBackends.test.ts
bun run test
git diff --check
```

验收还应比较多轮测试前后的精确 PID/profile 集合：不得出现本测试新增且仍存活的 isolated/Fake Chrome root，同时不能把其他既有进程计入失败或纳入清理。
