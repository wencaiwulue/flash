# External Stub 恢复验证记录

日期：2026-11-11。

本文件只记录实际执行过的命令、环境和结果。文档中的目标测试不等于已经执行；后续每波完成后追加证据，不重写历史结果。

## 前置基线

环境：macOS Darwin 24.6.0，Bun 1.3.14，工作目录 `/Users/fengcaiwen/GolandProjects/claude-code`。开始时有既存未跟踪路径 `.claude/` 和 `docs/superpowers/plans/`，本次不将其作为实现内容。

| 命令 | 结果 | 证据与限制 |
|---|---|---|
| `bun run typecheck` | Passed | 退出码 0。 |
| `bun run build` | Passed | 退出码 0；只证明构建成功。 |
| `bun test` | **Failed：166 passed，2 failed** | 666 assertions，168 tests across 36 files。前置失败见下表。 |

### 前置失败

| 测试 | 实际失败 | 本次处理要求 |
|---|---|---|
| `tests/cronLifecycle.test.ts:94` — recurring task reschedule | 第一次触发后读取任务，`lastFiredAt` 仍为 `undefined`。 | 作为基线失败保留；最终回归并单独报告，不能用其他测试通过掩盖。 |
| `tests/lspLifecycle.test.ts:77` — graceful shutdown timeout | `LSPClient.stop()` 发送 shutdown 时抛出 `Connection is closed`。 | 作为基线失败保留；最终回归并单独报告。 |

基线阶段未执行真实 Cloud、Remote Control、Chrome 扩展、交互桌面、SSH 主机或外部 runner live 验证，未据此声明任何新功能可用。

## 文档阶段门禁

| 检查 | 结果 | 范围与限制 |
|---|---|---|
| `bun run typecheck` | Passed | 新 self、c69c271 与 4909c0f 记录写入后再次执行，退出码 0。 |
| `git diff --check` | Passed | 文档与记录无 whitespace 错误。 |
| `bun run docs:generate -- --next` | Passed | 生成 192 份 commit SPEC/PLAN 与索引；迁移上一 self，并补齐 4909c0f 设计记录。 |
| `bun run docs:check -- --next` | Passed | 192 份文档通过结构、引用、证据和重复检查；技术语义另由人工审阅，不把结构通过当作功能验证。 |
| External stub 审计 | Completed | 82 项：81 项 NI/P 待实现/补齐，1 项支持实现；15 份模块契约、README、协议门禁和验证文档已建立。 |

文档阶段首次生成暴露了 c69c271 迁移记录的批量文件覆盖缺口和 4909c0f 缺记录；已按真实 diff 增加 changeGroups、索引/测试引用及独立设计记录，再次生成检查通过。该失败与修复过程不作为产品功能测试证据。

## 分波验证

### Wave 1 — 入站与 renderer

实现后由主代理复跑：

```text
bun test tests/inboundEnvelope.test.ts tests/messageRenderers.test.ts tests/udsMessaging.test.ts tests/peerSessions.test.ts
26 pass
0 fail
136 expect() calls
```

覆盖严格 envelope、普通消息/webhook 分流、伪造标签、三个 renderer、cross-session 可逆转义、UDS 回归和 bridge peer 目标投递。初次合并发现 renderer 测试的全局 Ink mock 污染其他文件，已改为使用真实 Ink exports 后通过。peer 与 renderer 已统一到 `src/bridge/crossSessionMessages.ts`，避免两套不兼容的 entity 编码。

当前 Sessions transport 尚无已验证的可信 webhook `source` 部署证据；生产路径不会信任客户端自报来源，提供并测试了 transport-attested 注入边界。普通远程消息恢复入队是 offline 实现结果；真实可信 webhook producer 和 dist/live 仍未验证，不能据此声称 GitHub webhook 已上线。

### Wave 2 — 状态、归因、权限与 MCP monitor

Bash prompt rules 与 jobs classifier 已由主代理复跑：

```text
bun --feature=BASH_CLASSIFIER --feature=TEMPLATES test tests/bashClassifier.test.ts tests/bashPermissionsClassifier.test.ts tests/jobClassifier.test.ts
52 pass
0 fail
184 expect() calls
```

覆盖规则限制、强制结构化输出、非法响应、超时/abort、deny/ask/allow 优先级、缓存隔离、原子写、generation 防迟到覆盖及确定性进程终态。测试使用 mock sideQuery；真实模型与 dist feature profile 尚未验证。Snapshot、attribution 与 MCP monitor 仍在实施/审查，不能将上述局部结果写成整个 Wave 2 完成。

MCP monitor 采用 `@modelcontextprotocol/sdk` 1.32.2 的公开 Tasks schema；1.32.0 之前的 Tasks 会话绑定安全问题不作为实现基础。主代理复跑 20 项任务/UI 测试时，输出异步读取用例出现一次固定 30ms 等待竞态，已改为有界条件等待；完整组合复跑结果为 **20 pass、0 fail、176 assertions**。真实 MCP server live 未执行。

Snapshot 与 attribution 由主代理复跑：

```text
bun test tests/agentMemorySnapshot.test.ts tests/snapshotUpdateDialog.test.tsx tests/commitAttributionWave2.test.ts
22 pass
0 fail
127 expect() calls
```

覆盖三种 snapshot 选择、merge 成功状态、事务化替换、临时 git 仓库 hook 安装与保留、缓存边界、公开 trailer，以及 HEAD 变化后只推进一次 commit baseline。归因代理最后因 TPM 中断，但主代理已包含其最终新增 HEAD 用例并复验通过。上述结果加上分类器与 MCP 后，当前全仓 `bun run typecheck` 已恢复为退出码 0。

### Wave 3 — Peer、Chrome 与 Computer Use

- Peer：包含在 Wave 1 的 26 项组合测试中，验证目标 compat session、XML 转义、自身/非法目标、断连、拒绝与异常不重试；真实双 session live 未执行。
- Chrome：`bun test tests/openBackends.test.ts` 由主代理复跑，**10 pass、1 skip、73 assertions**。覆盖 isolated 与 chrome-cdp 配置、endpoint、双后端生命周期、fake CDP tabs/cookies/context、origin deny 和 isError。代理另完成 dist fake-CDP 冒烟。真实 Google Chrome 登录态 live 为 **skipped**，未操作用户日常浏览器。
- Chrome 的 Bun CDP WebSocket 握手兼容问题由 Node stdio sidecar 承载真实 `@playwright/mcp` CDP 连接，不是 isolated fallback；该运行时前置条件需在发布文档保留。
- Computer Use：公开 Swift helper 已编译并进行 malformed protocol/EOF/linkage 验证；TypeScript 双后端集成和桌面 live 尚未完成，Zavora 结果不能回填为开放 native adapter 或私有 Swift 证据。

### Wave 4 — Direct Connect 与后台会话

主代理复跑：

```text
bun test tests/directConnect.test.ts tests/backgroundSessions.test.ts
23 pass
0 fail
105 expect() calls
```

覆盖 loopback HTTP/WS、Bearer、workspace/dangerous 双重授权、NDJSON/control、resume/idle/maxSessions、Unix socket/lockfile、三种 headless 输出、真实 tmux 的 launch/list/logs/identity/kill 和失败逆序清理。常规 backend 显式使用 `--permission-mode default`。`DIRECT_CONNECT` 与 `BG_SESSIONS` 已加入统一 external profile，CLI/SDK/声明构建通过，`server --help` 正常。

dist `ps` 初次暴露 development React DevTools 被 bundler 折叠后连接 `ws://localhost:8097/` 的退出错误，已改为运行时 NODE_ENV 判断并新增 `tests/backgroundSessionsDist.test.ts`。最终主代理组合复跑 **26 pass、0 fail、125 assertions**，覆盖 dist `ps`、`ps --json`、`ps --help`、Direct Connect、后台会话和 UDS。真实 TTY attach/detach 与真实模型 live 未执行。

### Wave 5 — SSH、Template Jobs 与 Open Runner

Template Jobs 与 Open Runner 由主代理复跑：

```text
bun test tests/templateJobs.test.ts tests/jobClassifier.test.ts tests/openRunnerProtocol.test.ts tests/openRunnerWorker.test.ts
39 pass
0 fail
157 expect() calls
```

覆盖模板发现/schema、new/list/reply、锁与恢复、真实 child transcript、结构化分类、reference server 的 register/poll/lease/claim/complete/fail/cancel/reconnect/drain。并行负载曾让测试的 1 秒 lease 过期，已调整测试 lease，并让 best-effort 脱敏日志在临时目录清理时不再影响权威状态。两个 runner 使用新的 `OPEN_RUNNER` 入口；没有连接或声称兼容私有 BYOC/WorkerService。SSH 仍在收尾，整个 Wave 5 尚未完成。

### Wave 6 — 公开命令与剩余占位

W6-34～38 已由主代理复跑：

```text
bun test tests/exitPlanModePrompt.test.ts tests/orgWarningNotification.test.ts tests/protectedNamespace.test.ts tests/antModelOverrides.test.ts tests/inkDevtools.test.ts
21 pass
0 fail
63 expect() calls
```

覆盖 allowedPrompts 指南、公开组织警告、namespace fail-safe、模型 catalog/alias overrides 与 development React DevTools。其余 slash、维护、Tungsten/MoreRight/ccshare 等仍在实施，完整 Wave 6 尚未完成。

18 个 slash command 的实现测试由主代理复跑：

- Workflow 九项（share/summary/teleport/onboarding/bughunter/oauth-refresh/good-claude/issue/autofix-pr）：**37 pass、0 fail、150 assertions**。
- 诊断九项（mock-limits/ant-trace/backfill-sessions/break-cache/ctx_viz/debug-tool-call/env/perf-issue/reset-limits）：**33 pass、0 fail、247 assertions**。

Workflow 测试初次组合暴露 partial `mock.module` 污染其他文件，已改为在 overrides 上展开 `?actual` exports，复跑通过。18 项均已移出 `INTERNAL_ONLY_COMMANDS` 并加入 external `COMMANDS`；真实 bundle profile 检查通过，同时断言 commit/commit-push-pr/agents-platform 未被误开放。真实 OAuth、上传、issue、checkout、PR 写操作均 skipped。

## 最终门禁

| 命令/检查 | 实际结果 |
|---|---|
| `bun run test` | **Passed：87 files，483 pass，0 fail，1 skip，2415 assertions**。标准入口按文件启动独立 Bun 进程并使用统一 external profile，避免跨文件 mock/gate/cwd 污染。 |
| `bun run typecheck` | Passed，退出码 0。 |
| `bun run build` | Passed，生成 CLI、SDK 与 declarations。 |
| `bun dist/main.js --version` | 输出 `1.0.0 (Claude Code)`。 |
| `bun dist/main.js --help` | 正常退出。 |
| `bun dist/main.js server --help` | Direct Connect 帮助正常，默认 loopback 与 dangerous 双重授权选项可见。 |
| `bun test tests/backgroundSessionsDist.test.ts` | 包含在最终全量套件中；dist `ps`、`ps --json`、`ps --help` 均通过。 |
| `bun dist/main.js new --help` | 模板 new/list/reply 用法正常。 |
| `bun dist/main.js open-runner --help` | Open Runner worker/server 用法正常。 |
| `bun dist/main.js environment-runner --help`、`self-hosted-runner --help` | 两个公开 alias 均正常。 |
| `bun dist/main.js ssh --help` | SSH 与 `--local` 真实入口正常。 |
| `bun dist/main.js up/rollback/log/error/export/task/completion --help` | 维护命令均已在 external dist 注册。 |
| `bun test tests/enabledFeatures.test.ts` | external bundle 通过：43 个非空工具（含 Tungsten）、18 个恢复命令及真实 internal-only 负向断言。 |
| `git diff --check` | Passed，无 whitespace/conflict marker。 |
| Stub marker 扫描 | `name: 'stub'`、`unavailable in this build`、固定 `isEnabled: () => false` 和 `Stub for external builds` 均无匹配；未使用的 `external-stubs/unavailable.ts` 已删除。 |

早期非隔离全量运行曾出现跨文件 mock/gate/cwd 污染和时序失败；改为独立进程后，又分别修复 SDK/BriefTool ESM 初始化、compat ID 断言、classifier-unavailable 测试、LSP 关闭竞态、cron 异步持久化等待和 Direct Connect 过短 idle 测试超时。最终通过结果覆盖这些回归。

真实 OAuth、可信 webhook producer、Google Chrome 登录态、交互桌面输入/截图/Escape、授权 Linux SSH、真实模型和外部 runner live 均为 **skipped**。Open CDP、Open Runner、公开 macOS helper 和其他新公开实现不声称私有扩展、WorkerService、Swift/Enigo ABI 或内部协议兼容。

最终 `bun run docs:generate -- --next` 生成 192 份 commit SPEC/PLAN 与索引，`bun run docs:check -- --next` 全部通过结构、引用、证据和重复检查。一次生成后的 self 引用更新导致 expected outdated，重新生成后通过；语义审查仍与自动结构检查分开。
