---
id: agent-sdk-integration-testing
batch: 0
title: Agent SDK 集成测试子项目 3 设计
date: 2026-11-28
status: draft
---

# Agent SDK 集成测试子项目 3 设计

本文细化[集成测试总体架构 §5.3](./2026-11-18-integration-testing-architecture-design.md)的 `tests/integration/sdk/`：以真实 `dist/sdk.mjs`、进程内 mock MCP 和本地 mock Anthropic API 验证 classic `query()`。本文同时登记红测将驱动的产品契约缺口；截至本文提交只完成设计与证据收集，未实现测试或产品修复，也未运行后续实施命令。

## 1. 问题与约束

### 1.1 现状与缺口

总体架构要求 SDK 套件覆盖 query 消息流、`canUseTool`、中断与错误、SDK hooks、进程内 MCP 发现/调用/断连恢复、resume/fork/abort、dist 导入和 token-count 迁移。当前仓库已有单测与 CLI/config 集成设施，但没有 `tests/integration/sdk/`。

源码核对得到以下可复现缺口；它们是后续红测的候选目标，不预先宣称测试已经失败：

| 范围 | 当前事实 | 目标证据边界 |
|---|---|---|
| dist 新鲜度 | `tests/integration/support/dist-fixture.ts:58-60` 的 `distSdkPath()` 以默认 `dist/main.js` 判断新鲜度，再返回 `sdk.mjs` | SDK 自身必须作为 marker；构建脚本 `scripts/build.ts:45-46` 确认产物名 |
| query 基础行为 | `src/utils/sdkQuery.ts` 已连接消息 channel、`canUseTool` 和 `ask()`，但公开契约缺少 dist 级端到端验证 | 先保留已通过行为，只对失败断言做最小修复 |
| 环境变量 | `sdkQuery.ts:387-392` 将 `options.env` 写入进程，清理没有恢复 | 进程内实现必须避免测试及后续 query 污染环境 |
| 中断与终端错误 | 同一 `AbortController` 被所有轮次复用（`sdkQuery.ts:335,581,633-635`）；错误 result 仅透传 | 上游区分按轮 `interrupt()` 与 query 级外部 abort，并规定末次错误 result 后抛出 |
| SDK hooks | `Options.hooks` 已声明，但 `createSdkQuery()` 未消费；`src/bootstrap/state.ts:1423-1448` 只有全局追加和全量清空 | 注册必须生效，清理必须按注册身份释放且幂等，不能误删其他所有者 |
| 进程内 MCP | `sdkQuery.ts:189-245` 创建 linked in-memory transport，可发现工具；未注册 elicitation 回调 | 覆盖发现、调用和受控替换恢复；form elicitation 走 hooks → callback → 默认 decline |
| classic sessions | `Options` 已声明 `continue`、`resume`、`forkSession`、`resumeSessionAt`，但 `createSdkQuery()` 未消费这些字段 | 本轮只实现 continue/resume/forkSession；复用现有 loader/storage，不以 v2 替代 |
| token-count | `fixtures/token-count-*.json` 共 16 个，逐一读取均只有 `{ "tokenCount": null }`；文件名引用搜索未发现消费者 | 改用真实 `getContextUsage()` 和 mock `/v1/messages/count_tokens`，不重录空 fixture |
| config 联动 | `tests/integration/config-acceptance/fixtures/hooks.yaml` 的 Elicitation/ElicitationResult 均为 `blocked-by-prereq:mcp-elicit-server` | mock MCP form elicitation 及真实场景断言完成后改 active |

### 1.2 约束

1. 所有常规用例离线、无真实凭据；`ANTHROPIC_BASE_URL` 只指向本地 mock，API key 使用公开假值，证据不得包含本机凭据。
2. 以 dist 公开入口验证真实发布形态；需要内部状态的修复仍由公开消息、回调、请求录制和沙箱文件观察。
3. 本轮目标是 classic `query()` 的 options。现有 v2 导出与本任务无关，不删除、不用它规避 classic 缺口。
4. 新缺口不能用 `test.skip` 隐藏。只有 config-acceptance 已有的显式 prerequisite 机制可在条件未满足时保留；条件完成后必须点亮。
5. 集成 runner 继续逐文件独立进程、顺序执行，以退出码和 `Failed test files` 判定；不修改 unit runner、CI 或 release smoke。
6. 新 spec 属测试基建工程文档，不新增 manifest 条目。产品行为主责 spec 仍是 `sdk-query-sessions`；`src/bootstrap/state.ts` 的唯一 coverage 主责仍是 `app-state`。
7. 不引入真实网络/进程 MCP、URL elicitation、额外并发隔离或旧 v2 清理；不在本轮删除 fixtures 或改产品代码，那些属于后续 plan 的实施步骤。

## 2. 设计理由与备选方案

### 2.1 三层证据与决策表

证据采集于 2026-11-28。官方文档描述当前上游契约；本机上游二进制版本为 2.1.212，只提取目标符号附近文本，不提交二进制；仓库源码与既有 spec 以 base `1df6b07` 为准，fixture 盘点另含当前工作区 3 个未跟踪文件，这些文件不纳入本提交。二进制证据与较新文档有版本差时明确保留差异，不把字符串存在夸大为完整行为证明。

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| dist 先行 | `distSdkPath()` 用 `dist/sdk.mjs` 做新鲜度 marker；所有 SDK 用例动态导入该产物 | 同时验证构建产物存在性、导出和运行时接线，避免 src 与 dist 漂移 | 直接导入 src：不能验证发布形态；沿用 main.js marker：SDK 缺失或陈旧时误报新鲜 | 支撑测试需要构造 SDK 缺失/陈旧场景 | 官方 [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) 以包导出为公开边界；仓库 `dist-fixture.ts:26-60`、`scripts/build.ts:45-46` |
| classic query 消息与权限 | 剧本化 init/assistant/tool_use/tool_result/result；权限用未提前 allow 的工具触发 `canUseTool`，断言 allow/deny/updatedInput | 覆盖真实 agent loop，而非 mock `ask()`；权限顺序决定 callback 并非每次工具都调用 | 直接单测 callback 适配器：不能发现工具池/权限串联；用 allowedTools 预批：会绕过 callback | mock 必须生成协议正确的流式响应 | 官方 [agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop) 与 [permissions](https://code.claude.com/docs/en/agent-sdk/permissions)；二进制含 result schema 和 `error_*` 枚举；仓库 `sdkQuery.ts:478-530` |
| 末次错误抛出，按轮中断可恢复 | 错误 result 先 yield；single-shot 或输入已耗尽的末轮随后抛出。每轮创建子 AbortController，`interrupt()` 只 abort 当前轮；`options.abortController`/`close()` 是 query 级终止 | 与上游可恢复 streaming input 语义一致，解决 controller 永久 aborted 导致后续轮次无法运行 | 所有错误只 yield：调用方收不到末次异常；interrupt 复用全局 controller：第二轮立即失败；所有 abort 都按轮重置：外部 abort 失去终止语义 | 需要 channel 可判断“关闭且排空”，并区分当前轮与外部 signal | 官方 [streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) 明确末次 error result 后 throw、interrupt 产生 `error_during_execution` 且保留后续消息；二进制片段含每轮 `new AbortController`、链接父 signal、`error_max_turns`/`error_during_execution`；仓库 `sdkQuery.ts:335,532-595,632-635` |
| SDK hooks 有 owner lease | 初始化注册 `options.hooks`；`registerHookCallbacks` 返回捕获实际 matcher 身份的幂等 release；query 清理只删除本次追加项 | 全局 registry 是现状，但全量 clear 会误删其他 query/plugin；按对象身份释放是最小兼容改动 | 不清理：后续用例重复触发；clearRegisteredHooks：误删兄弟；按事件清空：同事件其他 owner 被误删 | 需要覆盖 setup 失败、正常结束、重复 return 和兄弟注册保留 | 官方 [hooks](https://code.claude.com/docs/en/agent-sdk/hooks) 证明 `options.hooks`、matcher、阻断/修改语义；二进制含 `registerHookCallbacks` 与 hook callback 执行路径，但未证明 unregister 契约；仓库 `state.ts:1423-1469`、`sdkQuery.ts` 未消费 hooks |
| 进程内 MCP 与 form elicitation | `createSdkMcpServer` + linked transport 验证 `mcp__server__tool` 发现和调用；`setMcpServers` 受控断开并替换恢复。client 声明 elicitation capability，顺序为 Elicitation hooks → `onElicitation` → 默认 decline，再运行 ElicitationResult hooks | 无网络/子进程即可覆盖公开链路；与上游 hook 优先及未处理自动 decline 对齐 | 真实 stdio/HTTP MCP：引入环境不稳定；URL elicitation：协议与 UI 分支不同，超出本轮；只测工具 handler：不验证 MCP 协议 | 需要 mock server 在工具内发起 form elicitation，并补齐公开类型 | 官方 [custom-tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)、[MCP](https://code.claude.com/docs/en/agent-sdk/mcp)、[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)（`onElicitation` 和默认 decline）；二进制 `setMcpServers` 分离 SDK instance 并增删、`onElicitation` 出现在 query 参数；仓库 `sdkQuery.ts:189-245,699-738`、`services/mcp/elicitationHandler.ts:68-170` |
| classic continue/resume/fork | 新 `src/utils/sdkQuerySession.ts` 解析 options，复用 `listSdkSessions`、`resolveSessionFilePath`、`loadSdkSessionTranscript`、`forkSdkSession`；将 session 与 initialMessages 交给现有 query | 避免第二套 transcript 格式；fork 新 ID 且源不变可由公开访问器验证 | v2 session wrapper：不是本任务 API；另写 JSONL parser：DAG/compact 恢复漂移；只断言调用成功：不能证明历史恢复 | continue 需要可重复的“当前目录最近会话”夹具；fork 涉及文件复制 | 官方 [sessions](https://code.claude.com/docs/en/agent-sdk/sessions) 定义 continue/resume/fork 及 result/init session ID；二进制将 `forkSession` 映射 `--fork-session`、`resumeSessionAt` 映射对应 flag，含 UUID 校验和 transcript 复制；仓库 `sdkSessions.ts:253-330`、`sdkSessionConversation.ts:124-138` 已有可复用加载路径 |
| token-count 改真实调用 | query 产生真实上下文后调用 `getContextUsage()`；mock 记录并回答 `/v1/messages/count_tokens`，断言请求体及数值进入分类/汇总；删除 16 个 null fixtures，不重录 | 验证生产调用链而不是空录制；离线且确定 | 保留 VCR：当前数据无有效 token 值且无消费者；本地估算法替代 API：不能证明真实请求；真实 API：违反无凭据约束 | 多分类可能发多次 count 请求，断言聚合而非假定恰好一次 | 官方 TypeScript reference 说明 full usage 会发 token-count 请求且不进消息流；仓库 `sdkControl.ts:26-46` → `collectContextData` → `analyzeContextUsage`，`mock-anthropic.ts:52-54` 已有路由，16 个 fixture 均只含 null |

### 2.2 证据差异与不作出的假设

| 议题 | 已证实内容 | 本轮处理 |
|---|---|---|
| v2 生命周期 | 当前官方 sessions 文档称实验 v2 session API 已在 TypeScript Agent SDK 0.3.142 移除；本仓库仍导出 `unstable_v2_*` | 记录快照差异；不删除旧导出，不用 v2 实现 classic options |
| hook unregister | 官方文档和所取二进制片段没有给出按身份 unregister 的完整契约 | lease 是本仓库为全局 registry 所有权提出的最小修复，由后续红测验证，不声称上游逐字实现 |
| env | 上游 `options.env` 描述子进程环境替换；本仓库 classic query 直接在当前进程运行 | 保留现有进程内模型，只恢复本次触碰的键；不声称实现子进程隔离 |
| MCP 恢复 | 官方自动重连细节主要针对 remote server；本仓库 in-process `setMcpServers` 是显式替换 | 本轮“恢复”是受控断开后的重新配置和再次调用，不宣称自动 backoff/reconnect |
| resumeSessionAt | 官方为包含目标 UUID 的截断恢复；二进制显示找不到 UUID 报错、找到后 inclusive slice | 作为后续候选，不纳入本轮已批准 classic 三选项实现，不在测试中伪造支持 |
| elicitation 类型细节 | 官方给出 `onElicitation(request,{signal})` 和默认 decline；form 字段由本仓库 MCP SDK 类型与 handler 佐证 | 只做 form accept/decline/cancel 及 hooks；URL 模式明确非目标 |

## 3. 目标与非目标

### 3.1 目标

1. 建立 `tests/integration/support/sdk.ts` 和六个 SDK 测试文件：dist-import、query-lifecycle、hooks、mcp、sessions、token-count。
2. 通过公开 dist API 验证消息顺序、权限决策、环境恢复、错误/中断、hooks 注册与释放、MCP 和 classic session。
3. 以红测定位并最小修复 `sdkQuery.ts`、`bootstrap/state.ts`、公开类型及 classic session helper，不重写 query engine。
4. 将 config-acceptance 的两个 elicitation 条目从 prerequisite-blocked 点亮为真实 active 场景。
5. 用 mock count_tokens 替代 16 个空 fixture，并完成 integration、unit、typecheck、build、design-docs 门禁。

### 3.2 非目标

- 不删除或迁移旧 v2 导出；不实现 URL elicitation、真实网络或真实进程 MCP。
- 不做额外并发隔离，不重构 QueryEngine，不修改 unit runner、CI、release smoke。
- 不用 `test.skip` 隐藏本轮 SDK 缺口，不重录 token-count fixtures。
- 不把字符串证据当作运行通过证据；mock/offline 结果也不冒充 live 上游互操作结果。

## 4. 架构、模块与数据流

### 架构与资源边界图

```text
scripts/test-integration.ts（逐文件独立 Bun 进程，顺序执行）
  └─ tests/integration/sdk/*.test.ts
       ├─ support/sdk.ts
       │    ├─ dist-fixture.distSdkPath ──> dist/sdk.mjs（公开 API）
       │    ├─ sandbox：临时 HOME / project / CLAUDE_CONFIG_DIR
       │    └─ mock-anthropic：本地 /v1/messages、count_tokens、gated response
       │
       └─ classic query({ prompt, options })
            ├─ sdkQuerySession.ts：continue/resume/fork -> loader/storage
            ├─ sdkQuery.ts
            │    ├─ UserMessageChannel -> 每轮 AbortController -> QueryEngine.ask
            │    ├─ canUseTool / options.hooks / onElicitation
            │    └─ cleanup：MCP + hook lease + env + persistence lease
            ├─ bootstrap/state.ts：按身份注册/释放 callback hooks
            └─ in-process MCP Client <-> InMemoryTransport <-> mock McpServer

外部边界：无真实 API、OAuth、网络 MCP、子进程 MCP；临时目录和本地服务均须清理。
```

### 关键流程与失败路径

1. **消息流**：mock 文本/工具剧本 → init/assistant/user(tool result)/result → 断言顺序和第二次模型请求。result 不是强行 break 点，支撑收集器允许观察其后的抛出或尾部系统消息。
2. **权限**：不预批目标工具 → callback 记录 toolUseID/signal → allow 可修改 input，deny 返回消息；断言工具副作用和模型收到的结果，而非只看 callback 被调用。
3. **中断**：gated response 确认请求已挂起 → `interrupt()` → 当前轮 `error_during_execution` → streaming input 第二轮成功。外部 controller abort 必须贯穿后续轮次并执行一次清理。
4. **终端错误**：maxTurns 或执行错误先产生带 session_id/errors 的 result；末轮随后 throw。若 streaming input 仍有后续消息，较早轮错误不提前终止整个 query。
5. **hooks**：注册只发生一次；matcher 过滤；callback 能阻断/修改；release 重复调用无副作用，释放 A 不影响 B 或 plugin 注册。
6. **MCP**：初始连接和 list tools → 模型调用 `mcp__mock__echo` → handler 结果回传；`setMcpServers({})` 断开，再设置新 server → 状态/工具恢复并再次调用。form elicitation 先经 hooks，未处理才调用 callback，最终 result hooks 可观察/修改。
7. **classic session**：第一次 query 从 init/result 捕获 ID 并落盘；resume/continue 后第二次 mock 请求包含历史 marker；fork 返回不同 ID，源 transcript 内容不变；abort 后可凭 ID resume。
8. **token-count**：真实 query 建立 messages/tools → `getContextUsage()` → 一次或多次 mock count_tokens → 分类与总计为有限非负数，且请求包含当前模型/消息信息。

### 核心对象生命周期七列表

| 对象 | 创建/获取 | 运行/读写 | 恢复/分叉 | 中断/关闭 | 清理 | 失败语义 |
|---|---|---|---|---|---|---|
| dist SDK module | `distSdkPath()` 校验 sdk marker 后动态 import | 调用公开 query/tool/createSdkMcpServer | 不适用 | 模块本身无关闭 | 构建和临时 fixture 由 runner/测试管理 | 缺失或陈旧必须重建，不能回退 src |
| SDK test harness | 每用例创建 sandbox/mock，加载 dist | 提供 env、消息构造、请求记录和 bounded wait | 临时 HOME 中读取 transcript | 先 close query，再 stop mock/sandbox | cleanup 幂等，超时仍执行 | 清理异常聚合报告，不覆盖首个业务断言 |
| Query/channel | `query()` 创建，字符串 prompt 自动关闭，AsyncIterable 保持打开 | FIFO 输入，逐轮 ask/yield | options 提供 initialMessages/session | interrupt 当前轮；外部 abort/close 终止 query | finally + return 共用 cleanupPromise | channel 输入错误和末次错误 result 均向调用方传播 |
| 每轮 AbortController | 每轮开始创建并链接外部 signal | 传给模型、权限、hooks、MCP | 下一轮重新创建 | interrupt 只 abort 当前 controller | 移除外部 signal listener | 外部已 aborted 时当前轮立即终止，不能复活 |
| hook registration lease | 初始化追加实际 matcher 对象并返回 release | registry 供事件执行 | 不适用 | query 清理或 setup 失败触发 release | 按身份删除且仅一次 | 回调异常按 hook 契约传播/降级；释放不抛覆业务错误 |
| MCP connection/elicitation | client/server 经 linked transport 连接并列工具 | 工具调用；form 请求走 hooks/callback | setMcpServers 替换为新实例恢复 | close 两端，abort 取消待答 elicitation | 清理所有连接和待处理 handler | 连接失败进入状态/errors；未处理 form 默认 decline；handler 错误作为工具错误结果 |
| classic session | 新 query 或从当前目录/ID loader 加载 | initialMessages 进入 mutableMessages，transcript 追加 | resume 保持 ID；fork 先复制为新 ID | abort 后已写内容仍可 resume | flush storage 后释放 persistence lease | 不存在/空历史/非法 ID 明确失败；fork 不改源文件 |
| token usage | 在已有上下文上调用 getContextUsage | count_tokens 请求与分类聚合 | resume 后以恢复上下文重新统计 | 随 query 清理 | 无独立持久资源 | mock 错误必须可见；不得用 null fixture 伪装成功 |

### 测试文件与模块职责

| 文件 | 核心断言 | 允许的产品修复 |
|---|---|---|
| `tests/integration/sdk/dist-import.test.ts` | 导出存在；sdk.mjs 独立新鲜度；简单 query 可运行 | dist-fixture marker，必要时构建接线 |
| `query-lifecycle.test.ts` | 消息顺序、canUseTool、env 恢复、错误、interrupt/abort | sdkQuery 生命周期与清理 |
| `hooks.test.ts` | options.hooks 触发、matcher、修改/阻断、owner 清理 | state 身份 lease + sdkQuery 接线 |
| `mcp.test.ts` | 发现/调用/受控断连恢复、form elicitation | sdkQuery MCP client 和公开 onElicitation 类型 |
| `sessions.test.ts` | continue/resume/fork、abort 后 resume、源 transcript 不变 | 新 sdkQuerySession + 最小调用接线 |
| `token-count.test.ts` | 真实 getContextUsage 与 count_tokens 请求/数值 | 仅红测证明的 usage 接线缺口 |

`tests/integration/support/sdk.ts` 只提供稳定测试原语：`loadDistSdk()`、`createSdkHarness()`、`userMessage()`、有界 `waitFor()` 和同时保留 messages/error 的收集器。它不得吞掉异常、自动跳测或把内部 src 实现替换成另一套 fake query。

## 5. 失败语义与工程取舍

| 场景 | 可观察目标 | 清理要求 |
|---|---|---|
| single-shot `error_max_turns` | yield 错误 result，errors 含 turn limit，随后 throw | MCP/hooks/env/persistence 均释放 |
| streaming 较早轮错误 | yield 该轮错误 result，不阻止已排队下一轮 | query 仍持有资源，末轮后才清 |
| 末轮 `error_during_execution` | result 后 throw；session_id 已可捕获 | 同上 |
| `interrupt()` | 当前轮结束为 error_during_execution；后续轮使用新 controller | 不执行全 query 清理，直到输入结束/close |
| 外部 abort | 当前及后续操作看到同一终止语义 | 清理一次；重复 close/return 安全 |
| hook setup 后失败 | 错误传给调用方 | 仅本次注册被移除，兄弟保留 |
| MCP 初始连接失败 | mcpServerStatus/setMcpServers errors 可见，不伪报工具存在 | 失败 client/server 可清理 |
| elicitation 无 callback/hook | 自动 decline，ElicitationResult 可观察 | abort/close 能解除 pending |
| resume 不存在或 continue 无历史 | 明确错误，不静默开新会话 | 不写伪 transcript |
| fork | 新 session ID；源文件字节/消息不变；新文件含复制历史 | 后续 query 只写 fork 文件 |
| mock gate 未释放 | abort 或测试超时可解除，不能留下挂起 fetch | stop/harness 清理兜底 |

工程上优先复用现有 `UserMessageChannel`、persistence lease、session loader、MCP SDK 和 mock 路由。只有在公开断言证明现状不满足时才改产品；不得为了测试便利新增生产调试端点或凭据旁路。

## 6. 现状验收标准

当前状态是“设计完成、实施未开始”。后续完成必须同时满足：

1. `bun run test:integration --suite=sdk` 退出 0，六个测试文件全部被发现，无新增 `test.skip`。
2. dist-import 在 sdk.mjs 缺失或陈旧时触发重建；其余测试只消费 dist 公开入口。
3. query 测试分别证明消息流、allow/deny/updatedInput、env 恢复原值/删除语义、末次错误 result+throw、按轮 interrupt 与 query 级 abort。
4. hooks 测试证明 options.hooks 生效和按身份幂等释放；既有 `headlessHooks`/plugin 相关回归不破坏。
5. MCP 测试证明工具发现、调用、受控断连恢复及 form elicitation；config-acceptance 两个事件改 active 后真实运行并有标记/结果断言。
6. sessions 测试只使用 classic options，证明 continue/resume 历史、fork 新 ID 与源不变、abort 后 resume。
7. token-count 测试存在真实 count_tokens 请求且 usage 数值一致；16 个 null fixtures 在重新确认无消费者后删除。
8. `bun run test:integration`、`bun run test`、`bun run typecheck`、`bun run build` 均以退出码 0 完成；若有环境性失败，单列，不能写成通过。
9. `bun scripts/check-design-docs.ts` 为 0 errors；新增文件在落地时获得唯一 coverage 主责，warnings 与基线分开报告。

## 7. 代码与测试证据

### 7.1 本次实际收集的三层证据

**官方文档**（读取内容，不代表运行 live）：

- sessions：continue 当前目录最近会话、resume 指定 ID、`resume + forkSession` 新 ID 且源不变；single-shot 错误 result 后抛出。
- streaming-vs-single-mode：每个响应有 result；interrupt 当前响应为 error_during_execution，未读消息保留；末次错误 result 后抛出。
- agent-loop：init → assistant/tool → user result → result；`error_max_turns`/`error_during_execution` 及 session_id。
- hooks/user-input/permissions：options.hooks、matcher 和权限顺序；auto-approved 工具不到 canUseTool。
- typescript/MCP/custom-tools：classic options、setMcpServers、getContextUsage full count_tokens、onElicitation 默认 decline、进程内工具命名。

**本机上游二进制**：

```text
which claude -> /opt/homebrew/bin/claude
claude --version -> 2.1.212
strings <binary>，仅筛选 registerHookCallbacks、forkSession、resumeSessionAt、
setMcpServers、error_max_turns、error_during_execution 等目标片段
```

筛选结果包括：`forkSession` UUID/upToMessageId 校验；`forkSession` 到 `--fork-session`、`resumeSessionAt` 到 `--resume-session-at` 的参数映射；inclusive resume 截断与找不到消息错误；`setMcpServers` 对 SDK instance 增删及 added/removed/errors schema；每轮 AbortController 链接父 signal；两种错误 subtype 和 max-turns 文案。`registerHookCallbacks` 只证明符号及 hook 执行路径，未从中推断 lease。

**仓库契约**：`src/utils/sdkQuery.ts`、`src/bootstrap/state.ts`、`src/entrypoints/agentSdkTypes.ts`、`src/entrypoints/sdk/runtimeTypes.ts`、`src/utils/sdkSessions.ts`、`src/services/mcp/elicitationHandler.ts`、现有 sdk-query-sessions spec/coverage、integration architecture 和 config fixtures。fixture 检查逐一得到 16/16 `{tokenCount:null}`；排除 fixtures 本身后，文件名搜索未发现消费者，`src/services/vcr.ts` 只有通用 tokenCount 形状，不构成对这些文件的引用。

### 7.2 现有测试与后续证据分界

- 现有 `sdkQueryLifecycle.test.ts`、`sdkSessions.test.ts`、`sdkControls.test.ts`、`sdkRewind.test.ts`、`sdkMcp.test.ts` 是单元/模块证据，不替代 dist 集成。
- 本次文档任务没有创建或运行上述新 SDK 测试，也没有运行产品修复后的 test/typecheck/build；这些结果必须来自后续实际命令。
- 后续每个阶段记录红测失败断言、最小修复、绿测命令和退出码。mock/offline 与 live 证据分栏；本计划没有 live 验收要求。

## 8. 文件覆盖与相关子系统

本工程 spec 不登记 manifest。功能契约由[已注册 sdk-query-sessions spec](./2026-11-12-sdk-query-sessions-design.md)及[coverage](../../architecture/coverage/sdk-query-sessions.yaml)承接。

| 文件/范围 | 主责或联动 | 落地规则 |
|---|---|---|
| `src/utils/sdkQuery.ts`、未来 `src/utils/sdkQuerySession.ts`、公开 SDK 类型 | sdk-query-sessions | 新文件创建后加入唯一 coverage group；不得用未来路径制造 GHOST_COVERAGE |
| `src/bootstrap/state.ts` | app-state 主责；sdk-query-sessions 相邻契约 | 不重复登记；在本 spec 和 app-state 相关边界说明身份 lease |
| MCP client/elicitation | mcp 主责；sdk-query-sessions 联动 | 只复用现有 form/hook 语义，URL 分支不变 |
| `tests/integration/sdk/**` 与 support | sdk-query-sessions 的集成测试归属 | 文件实际创建后登记；runner 自动发现，不改 manifest 新 spec |
| config fixtures/scenarios | upstream-configuration-alignment/config 验收 | 只在真实场景可用后 active，保留历史 blocked 注释证据 |
| `fixtures/token-count-*.json` | 测试数据清理 | 删除前再次跑文件名和内容消费者搜索 |

关联子系统：query-core、session-persistence、hooks-system、mcp、permissions、build/test-validation。新增文件的所有权在实际变更提交时沿这些真实调用关系复核，不为本工程 spec 另建 manifest 条目。

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 当前无 `tests/integration/sdk/`，且 options.hooks/classic session options 在类型中存在但 createSdkQuery 未消费 | 按配套 plan 以 dist 红测分阶段落地，先支撑和生命周期，再 hooks/MCP/sessions | 中 —— 全局 hooks/env/abort 生命周期影响相邻调用方 | 六文件及全套件实际运行；每阶段记录退出码，不用 skip | L | 待运行验证 |
| P2 | 官方和 binary 均定义 resumeSessionAt inclusive cutoff，但本轮只批准 continue/resume/forkSession | 后续单独补 resumeSessionAt 红测和 loader cutoff，含未知 UUID 错误 | 中 —— 截断 transcript 可能破坏 DAG/tool pairing | 指定 UUID 前后历史、未知 UUID、fork 组合测试 | M | 已证实 |
| P2 | 本设计只验证 in-process MCP 的显式恢复；官方 remote 自动重连不属于本环境 | 另设 offline transport 故障注入或 live 层验证自动重连，不与本轮混报 | 中 —— 网络时序和重试容易抖动 | 区分 controlled replacement 与 automatic reconnect 的结果记录 | M | 设计推断 |
| P3 | 当前官方文档已移除 v2，而仓库仍保留 unstable_v2 导出 | 在独立弃用设计中评估兼容成本和删除窗口 | 高 —— 可能影响现有调用方 | 先盘点消费者和版本政策，不在本子项目直接删除 | M | 已证实 |
