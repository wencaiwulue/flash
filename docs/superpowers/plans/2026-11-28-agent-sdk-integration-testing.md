---
id: agent-sdk-integration-testing-plan
batch: 0
title: Agent SDK 集成测试子项目 3 实施计划
date: 2026-11-28
status: draft
---

# Agent SDK 集成测试子项目 3 实施计划

> 实施者按任务顺序执行 TDD：先写公开行为断言并记录真实失败，再做最小修复，最后运行该阶段和累计门禁。不得把设计中的目标写成已验证结果。

**目标：** 交付离线 `tests/integration/sdk/` 六文件套件和 SDK 专用支撑，覆盖 classic query 生命周期、hooks、进程内 MCP/elicitation、classic continue/resume/fork/abort、dist 导入和 token-count。

**架构：** 所有用例导入 `dist/sdk.mjs`；`tests/integration/support/sdk.ts` 组合 sandbox、mock API 与有界等待。产品修复集中在 `sdkQuery.ts`、hook 身份 lease、公开类型和复用现有 session storage 的 `sdkQuerySession.ts`。

**技术栈：** Bun/TypeScript、`bun:test`、现有 `Bun.serve` mock、MCP SDK `InMemoryTransport`、真实 dist 构建。

**设计：** `docs/superpowers/specs/2026-11-28-agent-sdk-integration-testing-design.md`；功能主责 spec 为 `docs/superpowers/specs/2026-11-12-sdk-query-sessions-design.md`。

## 阶段决策表

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 支撑/dist 最先 | 先修 sdk marker、gated response 和 harness，再写行为测试 | 后续中断、错误、MCP 都依赖同一可确定性原语 | 每个测试自建服务/沙箱：清理和超时分叉；直接 src：失去发布形态证据 | 首阶段无大量产品断言 | 设计 §2.1 dist 行；`dist-fixture.ts`、`mock-anthropic.ts` 当前实现 |
| 既有 query 行为先于复杂缺口 | 消息流、canUseTool、env 先于 abort/hooks/MCP/session | 先建立最小可运行路径，失败可归因到当前阶段 | 一次写全部测试：构建/协议问题与产品缺陷混在一起 | 需要反复运行累计套件 | 设计 §4 消息流与权限；官方 agent-loop/user-input |
| 错误/中断先于全局所有权 | 每轮 abort 与末次错误语义稳定后再清 hooks/env/MCP | 清理必须覆盖所有终止路径，先定义终止路径可减少返工 | 先修 registry：错误路径仍绕过清理，产生假绿 | gate 需要可靠 abort | 官方 streaming-vs-single-mode；binary 每轮 controller 片段；`sdkQuery.ts` finally |
| hooks 后接 MCP/elicitation | 先证明身份 lease，再让 elicitation hooks 复用 registry | elicitation 同时依赖 MCP 和 hooks，过早点亮 config 会掩盖注册问题 | 只改 fixture active：没有真实触发证据 | config 场景需要真实 form 请求 | 官方 hooks/typescript onElicitation；`elicitationHandler.ts` hook 顺序 |
| classic sessions 后于基础生命周期 | 最后接 continue/resume/fork，复用 loader/storage | 持久化、flush、abort 已稳定后才能判断恢复是否正确 | v2 替代：偏离目标；重写 JSONL：DAG/compact 漂移 | 需要跨 query 的磁盘断言 | 官方 sessions；`sdkSessions.ts`/`sdkSessionConversation.ts` |
| token 和全量门禁收尾 | 真实 usage/count_tokens，确认无消费者后删 null fixtures，再跑全部门禁 | token 依赖 messages/tools 已可用；删除必须最后复核 | 重录 null 数据：无行为价值；先删文件：丢失差异审计 | 全量测试耗时增加 | 设计 §2.1 token 行；16/16 null 检查结果 |

## 全局约束

- 工作分支为 `integration-testing-cli-e2e`；不 merge、不 push。提交结尾使用 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 所有网络只到本地 mock；使用 `MOCK_API_KEY`，不得读取或打印真实凭据。`createSandbox().env` 已剥离 `ANTHROPIC_*`/`CLAUDE_*` 并禁用非必要流量。
- 新 SDK 测试不得有 `test.skip`。失败时保留断言并修复最小产品缺口；不修改 unit runner、CI、release smoke。
- classic `query()` 是唯一 session 目标；不调用 `unstable_v2_*`。不删除旧导出，不做 URL elicitation、真实网络/进程 MCP、额外并发隔离。
- 集成 runner 以每文件退出码判定。每个 Task 至少运行新增/相邻测试；最终运行全量 test、typecheck、build 和 design-docs。
- 新文件实际创建后同步 `docs/architecture/coverage/sdk-query-sessions.yaml`；不得提前登记不存在的文件。`src/bootstrap/state.ts` 仍由 app-state 唯一主责。
- 每个阶段的 commit 只包含该阶段文件；设计阶段的既有未跟踪 fixtures 和其他文档不得顺带提交。

## 文件总表

- 新建支撑：`tests/integration/support/sdk.ts`。
- 修改支撑：`tests/integration/support/dist-fixture.ts`、`dist-fixture.test.ts`、`mock-anthropic.ts`、`mock-anthropic.test.ts`。
- 新建套件：`tests/integration/sdk/{dist-import,query-lifecycle,hooks,mcp,sessions,token-count}.test.ts`。
- 产品最小修复：`src/utils/sdkQuery.ts`、`src/bootstrap/state.ts`、`src/entrypoints/sdk/runtimeTypes.ts`、新建 `src/utils/sdkQuerySession.ts`；仅在红测证明需要时改相邻 loader。
- config 联动：`tests/integration/config-acceptance/fixtures/hooks.yaml`、`engine/scenarios.ts` 及必要的场景断言测试。
- 收尾：删除 `fixtures/token-count-*.json` 16 个空录制，更新实际新增文件的 coverage。

---

### Task 1：SDK 支撑、dist 新鲜度与导入

**Files:**
- Modify: `tests/integration/support/dist-fixture.ts`、`dist-fixture.test.ts`
- Modify: `tests/integration/support/mock-anthropic.ts`、`mock-anthropic.test.ts`
- Create: `tests/integration/support/sdk.ts`
- Create: `tests/integration/sdk/dist-import.test.ts`

**Interfaces:**
- `distSdkPath()` 返回 `<root>/dist/sdk.mjs`，其新鲜度检查 marker 固定为 `dist/sdk.mjs`。
- `createResponseGate(): { promise: Promise<void>; release(): void }`；gated response 在 release 或 request abort 前不写响应体，release 幂等。
- `loadDistSdk(): Promise<typeof import('../../../src/entrypoints/agentSdkTypes.js')>`，动态 import 的路径来自 `distSdkPath()`。
- `createSdkHarness()` 返回 `{ sdk, sandbox, mock, baseOptions, track, collect, waitFor, cleanup }`。`baseOptions` 包含 `cwd`、完整隔离 env、`ANTHROPIC_BASE_URL`、假 key 和 `CLAUDE_CONFIG_DIR`；`track` 登记待关闭 query；`collect` 返回 `{ messages, error }`，不吞错；`waitFor` 必须有 deadline。

- [ ] **Step 1：写 dist marker 和 dist-import 红测**

在 `dist-fixture.test.ts` 增加两个 controlled fixture：main.js 新鲜但 sdk.mjs 缺失、sdk.mjs 比新源码陈旧；二者都必须 stale。`dist-import.test.ts` 至少断言 `query`、`tool`、`createSdkMcpServer`、`listSessions`、`getSessionMessages` 为函数，并用一个 mock 文本响应完成 classic query，记录 init/assistant/result。

Run:
```bash
bun test tests/integration/support/dist-fixture.test.ts
bun run test:integration tests/integration/sdk/dist-import.test.ts
```
Expected red：若当前 dist 恰好新鲜，controlled fixture 必须仍能区分 main 与 sdk marker；导入用例不得以 src fallback 通过。记录实际失败；若断言本身已通过，将其标为既有保护而非伪称红测。

- [ ] **Step 2：最小修复 marker**

`distSdkPath()` 调 `ensureFreshDist({ marker: 'dist/sdk.mjs' })`，返回该目录的 `sdk.mjs`。不要改变 `distMainPath()` 的 main marker。

Run 同两条命令，Expected green，退出码均 0。

- [ ] **Step 3：写 gated response 红测**

在 `mock-anthropic.test.ts` 增加：
1. gate 未 release 时 fetch 仍 pending，且 mock 已记录请求；release 后得到所排队文本。
2. abort gated fetch 后 promise 以 abort 结束，服务可 stop，无悬挂。
3. gate 释放两次不抛错，下一条普通响应不受影响。

Run `bun test tests/integration/support/mock-anthropic.test.ts`，Expected red（当前无 gate 能力）。

- [ ] **Step 4：实现可 abort gate**

为现有 text/tool_use/error 剧本增加可选 gate 包装，不改变现有响应字段。等待使用 request abort signal 与 gate promise 竞争；abort 路径移除 listener。`stop()` 必须能结束剩余等待。不得用固定 sleep 代替请求已到达断言。

Run 同一测试，Expected green。

- [ ] **Step 5：实现 harness 并复核清理**

harness 的 cleanup 顺序：关闭所有 tracked query（逐个捕获错误）→ `mock.stop()` → `sandbox.cleanup()`；重复调用安全。`collect` 必须保留 result 之后的 throw，供 Task 3 断言；不得默认返回“成功”。

Run:
```bash
bun run test:integration tests/integration/sdk/dist-import.test.ts
bun test tests/integration/support/dist-fixture.test.ts tests/integration/support/mock-anthropic.test.ts
```

- [ ] **Step 6：登记实际新增测试归属并提交**

把 `tests/integration/support/sdk.ts` 和 `tests/integration/sdk/dist-import.test.ts` 加入 sdk-query-sessions coverage 的测试组；共享 support 既有文件不重复抢占归属。运行 `bun scripts/check-design-docs.ts` 后提交本 Task 文件。

---

### Task 2：既有 query 消息流、canUseTool 与 env 恢复

**Files:**
- Create: `tests/integration/sdk/query-lifecycle.test.ts`
- Modify: `src/utils/sdkQuery.ts`（仅失败断言需要）
- Modify: `tests/integration/support/sdk.ts`（仅共享断言需要）

**Interfaces:**
- 消息构造器生成含稳定 UUID、`parent_tool_use_id:null` 的 `SDKUserMessage`。
- env lease 记录本次 `options.env` 触碰键的旧值（含“不存在”），在 setup 失败、正常完成、throw、return/close 时恢复。

- [ ] **Step 1：写消息流和工具链测试**

文本剧本断言 init 在 assistant 前、success result 在 assistant 后、result.session_id 非空。工具剧本使用 `Bash` 或当前稳定工具，断言 assistant tool_use → 本地执行 → user tool_result → 第二次 mock 请求包含相同 tool_use_id 和结果 → success result。

Run `bun run test:integration tests/integration/sdk/query-lifecycle.test.ts`。若通过，保留为既有行为证明；若失败，先核对 mock SSE 协议再定位产品，不改弱消息断言。

- [ ] **Step 2：写 canUseTool allow/deny/updatedInput 测试**

目标工具不得放入 `allowedTools`，避免提前批准。allow 用例返回 `updatedInput` 改变输出 marker，断言实际执行使用修改后的 input；deny 用例返回 message，断言无文件/命令副作用且后续模型请求包含拒绝信息。记录 `toolUseID` 和 `signal`。

Run 同一文件。只修复实际失败的适配或权限接线；不得把目标工具改成自动批准来让测试变绿。

- [ ] **Step 3：写 env 恢复红测**

预置 `SDK_IT_EXISTING=old`、`SDK_IT_DELETE=gone`；query options.env 将前者改为 new、后者设 undefined，并新增 `SDK_IT_NEW`。在回调/工具中观察新值；正常结束、模型错误、setup 失败后分别断言 old 恢复、删除键恢复、新键不再存在。另测原本不存在的键被删除后仍不存在。

Run 同一文件，Expected red：当前 cleanup 不恢复 env。

- [ ] **Step 4：实现按触键恢复并跑相邻回归**

在 initialize 应用 env 前建立 lease，cleanupPromise 和 setup catch 共用幂等释放。不要用最后一个 query 的全量 process.env 快照覆盖外部变化；本阶段不宣称解决并发 env 隔离。

Run:
```bash
bun run test:integration tests/integration/sdk/query-lifecycle.test.ts
bun test tests/sdkQueryLifecycle.test.ts tests/sdkControls.test.ts
```

- [ ] **Step 5：更新 coverage 并提交**

登记 query-lifecycle 文件，提交本 Task 文件。

---

### Task 3：终端错误传播、按轮 interrupt 与 query 级 abort

**Files:**
- Modify: `tests/integration/sdk/query-lifecycle.test.ts`
- Modify: `src/utils/sdkQuery.ts`
- Modify only if required: `tests/integration/support/mock-anthropic.ts`

**Interfaces:**
- channel 可查询 `closed && queue.length === 0`，用于判断刚结束的响应是否为末轮。
- 每轮 controller 链接 `options.abortController.signal`；`interrupt()` 只中止当前轮；`close()` 仍执行外部级 abort + return。

- [ ] **Step 1：写 single-shot maxTurns 红测**

mock 首轮返回 tool_use，使 `maxTurns:1` 在最终文本前耗尽。收集器必须同时看到 `error_max_turns` result 和随后的 throw；断言 errors 含 `Reached maximum number of turns`、session_id 非空，且 env/hooks/MCP 清理由可观察计数证明。

Run 当前文件，Expected red 若只 yield 不 throw；不得只捕获异常而不检查先前 result。

- [ ] **Step 2：写执行错误与 streaming 非末轮测试**

用可控错误剧本产生 `error_during_execution`。single-shot 断言 result 后 throw。streaming input 在第一轮错误后仍有第二条消息，断言第一轮错误不提前 throw，第二轮 success；输入耗尽后的末轮若错误则 result 后 throw。

Run 并记录实际差异。若 mock 错误重试导致超时，使用已有公开 env 将重试设为 0，并保持 deadline。

- [ ] **Step 3：写 interrupt/abort 红测**

- gated 第一轮开始后调用 `q.interrupt()`；断言第一轮 error_during_execution，释放/结束 gate 后第二轮成功，证明 controller 已按轮更新。
- 外部 `AbortController.abort()` 后第二轮不得重新运行；close/return 两次只清一次。
- interrupt 发生在等待输入而不是活动轮时不得误杀后续轮。

Run 当前文件，Expected red：当前共享 controller 会让 interrupt 后续轮也 aborted。

- [ ] **Step 4：实现末轮 throw 与每轮 controller**

先 yield 错误 result，再仅在 channel 已关闭且排空时抛出包含 errors 的 Error。每轮建立 controller 并转发外部 abort reason；移除 listener。`interrupt()` 只 abort 当前轮；外部 signal 已 aborted 时新轮立即终止。保留 finally 清理和 cleanupPromise 幂等。

Run:
```bash
bun run test:integration tests/integration/sdk/query-lifecycle.test.ts
bun test tests/sdkQueryLifecycle.test.ts tests/sdkRewind.test.ts
```

- [ ] **Step 5：提交**

只提交本 Task 文件。

---

### Task 4：SDK hooks 接线与按身份 ownership

**Files:**
- Create: `tests/integration/sdk/hooks.test.ts`
- Modify: `src/bootstrap/state.ts`
- Modify: `src/utils/sdkQuery.ts`

**Interfaces:**
- `registerHookCallbacks(hooks)` 为每次调用中的每个追加项分配独立 registration occurrence，并返回幂等 `release(): void`；既有忽略返回值的调用方保持兼容。
- registry 必须能区分“同一调用方 matcher 对象被 A/B 分别注册”的两个 occurrence；release 只删除本次追加的 occurrence，不得只按原始对象引用过滤，不按事件名全清，不删除 plugin/native 或其他 query 的注册。实现可为每项建立独立注册记录/包装并保留原 callbacks；不得改变 hook 输入输出。

- [ ] **Step 1：写 options.hooks 公开行为红测**

注册 `PreToolUse`、`PostToolUse`、`UserPromptSubmit` 回调；断言 matcher 命中/不命中、toolUseID、signal、JSON 输出。一个 PreToolUse deny 必须阻止副作用，另一个 updatedInput/allow 路径必须作用于真实工具调用。

Run `bun run test:integration tests/integration/sdk/hooks.test.ts`，Expected red：createSdkQuery 当前未消费 options.hooks。

- [ ] **Step 2：写 owner/幂等红测**

在同一 harness 中初始化 query A 和 B 的 hooks，但不并发执行模型。A/B 的 options 必须复用**同一个 matcher 对象和同一个 hooks 数组**；关闭 A 两次后运行 B：A 的 occurrence 被释放，共享 callback 仍通过 B 恰好触发一次。引用过滤实现会在关闭 A 时把 B 也删掉，因此该用例必须对引用过滤方案保持红。再验证正常 return、末次错误和 setup 失败均只释放自身 occurrence，预存的其他 matcher 不被清除。

Run 同一文件。该用例证明 occurrence ownership，不据此宣称解决其他全局状态的并发隔离。

- [ ] **Step 3：实现注册 lease 和 query 接线**

在 state 中为每个追加项创建独立 occurrence 记录（例如 registry 存本次注册包装，lease 捕获包装引用），保留事件、matcher、callbacks 和原有字段；release 仅过滤这些 occurrence，空事件删除，全部为空时恢复 null。重复 release 直接返回。不得把“调用方传入的 shared matcher 原始引用”当作唯一键。`createSdkQuery` 初始化时注册 options.hooks，setup 失败与 cleanup 都调用同一 release。

Run:
```bash
bun run test:integration tests/integration/sdk/hooks.test.ts tests/integration/sdk/query-lifecycle.test.ts
bun test tests/headlessHooks.test.ts tests/sdkQueryLifecycle.test.ts
```

- [ ] **Step 4：更新 spec/coverage 实施证据并提交**

coverage 只登记实际新建 hooks 测试；spec 保持 draft，实际结果可写执行记录但不得自行改 approved。提交本 Task 文件。

---

### Task 5：进程内 MCP、断连恢复与 form elicitation

**Files:**
- Create: `tests/integration/sdk/mcp.test.ts`
- Modify: `src/utils/sdkQuery.ts`
- Modify: `src/entrypoints/sdk/runtimeTypes.ts`
- Modify: `tests/integration/config-acceptance/fixtures/hooks.yaml`
- Modify: `tests/integration/config-acceptance/engine/scenarios.ts`
- Modify: `tests/integration/config-acceptance/engine/entries.ts`（`KNOWN_TRIGGER_PREFIX`）
- Modify: `tests/integration/config-acceptance/engine/engine.test.ts`（parser 与场景回归）

**Interfaces:**
- `Options.onElicitation?: (request: ElicitRequest, options: { signal: AbortSignal }) => Promise<ElicitResult>` 使用 MCP SDK 的实际类型名；以 typecheck 为准，不自行造同构类型。
- in-process Client 声明 elicitation capability；form 请求顺序为 Elicitation hooks → onElicitation → 默认 decline，随后 ElicitationResult hooks。

- [ ] **Step 1：写 MCP 发现与调用测试**

用 dist `tool()` + `createSdkMcpServer()` 创建 `echo` 工具，经 `mcpServers:{mock:server}` 注入。断言 init/status 发现 `mcp__mock__echo`，mock 模型发起该工具调用，handler 收到参数，结果进入下一次模型请求。工具权限使用精确 `allowedTools` 或 canUseTool，禁止 broad bypass。

Run `bun run test:integration tests/integration/sdk/mcp.test.ts`。先修协议/fixture；已支持部分记录为绿，不为制造红测破坏实现。

- [ ] **Step 2：写受控断连恢复测试**

调用 `setMcpServers({})`，断言 removed 和状态/工具消失；再以同名新实例 `setMcpServers({mock:fresh})`，断言 added/errors、重新发现和第二次调用成功。测试注释明确这是 explicit replacement recovery，不是 remote 自动重连。

Run 同一文件，修复仅限 setMcpServers 清理/重组中实际失败处。

- [ ] **Step 3：写 form elicitation 红测**

mock MCP 工具 handler 内发起最小 form elicitation。覆盖：
1. `onElicitation` accept content，工具得到结果并继续；
2. 无 hook/callback 自动 decline；
3. callback abort 返回 cancel 或 MCP 约定的取消结果；
4. Elicitation hook 先响应时 onElicitation 不调用；ElicitationResult 能观察最终 action/content。

Run 同一文件，Expected red：Options 当前无 onElicitation 且 in-process client 未接 handler。

- [ ] **Step 4：最小实现公开类型和 handler**

复用 `runElicitationHooks`、`runElicitationResultHooks` 与 MCP `ElicitRequestSchema`，不要复制 settings hook 执行器。默认结果遵循 MCP 类型和上游默认 decline。异常/abort 必须解除 pending；清理仍关闭 client/server。URL mode 不进入本实现和断言。

Run:
```bash
bun run test:integration tests/integration/sdk/mcp.test.ts tests/integration/sdk/hooks.test.ts
bun run typecheck
```

- [ ] **Step 5：先扩 parser，再点亮 config-acceptance 两个事件**

先在 `engine/engine.test.ts` 写红测：包含 `trigger: mcp_elicitation` 的条目必须经 `loadHookEntries()` 保留该 trigger；现有 `bogus_trigger` 仍必须抛出含 entry id 的错误。当前 `engine/entries.ts` 的 `KNOWN_TRIGGER_PREFIX` 不含该值，测试应先失败。随后仅把 `mcp_elicitation` 加入该 allowlist，不为绕过 parser 改成 `print_turn`。

再在 `scenarios.ts` 新增同名场景：复用 fixture 写入的 settings hooks、dist classic query 和同一 in-process mock MCP，不启动真实进程/网络 MCP。先让场景以 active 断言运行并保留失败，再把 fixtures 的 Elicitation/ElicitationResult 改为 `status: active`、`trigger: mcp_elicitation`；注释保留“原 blocked-by-prereq:mcp-elicit-server，子项目 3 落地后点亮”的历史边界。

Run:
```bash
bun run test:integration tests/integration/config-acceptance/engine/engine.test.ts
bun run test:integration tests/integration/config-acceptance/hooks-matrix.test.ts
bun run test:integration --suite=config-acceptance
```
Expected：parser 接受新 trigger 且仍拒绝未知值；两个事件真实生成标记并有结果断言，不再输出对应 prereq skip；其余既有 blocked 项保持原状。

- [ ] **Step 6：更新 coverage 并提交**

提交 MCP、公开类型和 config 联动文件；不得顺带点亮其他 hooks。

---

### Task 6：classic continue/resume/forkSession 与 abort 后恢复

**Files:**
- Create: `src/utils/sdkQuerySession.ts`
- Modify: `src/utils/sdkQuery.ts`
- Create: `tests/integration/sdk/sessions.test.ts`
- Modify: `docs/architecture/coverage/sdk-query-sessions.yaml`

**Interfaces:**
- 内部 resolver 输入 classic options 与 cwd，输出 `session: { id, projectDir }`、可选 `initialMessages`。fresh 每次生成新 UUID 并经现有 `switchSession` 设置；不得沿用进程启动时的全局 session ID。
- continue：当前目录最近会话；resume：指定 ID；`resume + forkSession:true`：先复制为新 ID，再加载 fork；均复用 `resolveSessionFilePath`/`loadSdkSessionTranscript`，fork 使用 `forkSdkSession`。
- 参数解析在 switchSession、文件读取/写入和模型请求之前执行：`continue && resume` 明确报互斥；只要 `resumeSessionAt !== undefined` 就明确报当前 in-process 实现不支持（包括 resume+resumeSessionAt），不得静默忽略。

- [ ] **Step 1：写 fresh ID、参数校验与 resume 红测**

先在同一个 sandbox 进程内顺序运行两个不带 continue/resume 的 fresh classic query，分别捕获 init session ID。断言两个 ID 都是合法 UUID 且不相等，两个 transcript 文件各自只含对应 marker。当前两者会共享进程初始 session ID，此断言必须先红，再驱动 resolver 的 fresh UUID + `switchSession` 修复；不能用固定公开 session ID fixture 掩盖。

参数校验用例分别提供 `continue:true + resume:id`、`resume:id + resumeSessionAt:messageId`、仅 `resumeSessionAt:messageId`，断言明确错误且 switch/write/mock 请求计数均不增加。不得只断言“最终没有成功”。

然后写 resume：第一次 classic query 的 prompt 含唯一 marker，从 init/result 捕获 session ID。第二次 `query({prompt:'follow up',options:{resume:id,...}})` 后，断言第二次 `/v1/messages` 请求含第一轮 user/assistant 历史，结果仍属于恢复会话。对不存在 ID 和非法 ID 断言明确错误且不静默新建。

Run `bun run test:integration tests/integration/sdk/sessions.test.ts`，Expected red：fresh ID 当前复用，classic session options 当前未消费。

- [ ] **Step 2：写 continue 与 fork 红测**

- continue：复用 Step 1 已证明 ID 不同的两个 fresh 会话，用 transcript 文件 mtime/公开列表结果确定时间顺序，`continue:true` 必须选择最近者且第二次请求只含该会话的 marker；无历史时明确失败。若两个 ID 相同，本测试不得继续或被改成单会话。
- fork：记录源 transcript 字节和消息 UUID；`resume:sourceId,forkSession:true` 后 init/result ID 必须不同，第二次请求含源历史，源文件保持不变，fork 可独立 resume。不得调用 standalone v2 session wrapper；standalone `forkSession()` helper 仅可作为内部复用实现，不作为测试替代路径。

Run 同一文件，记录红测。

- [ ] **Step 3：写 abort 后 resume 测试**

第一轮使用 gated response，捕获 init session ID 后外部 abort；结束并清理。用该 ID 发起 classic resume 并注入新 mock 响应，断言已持久化历史可见、后续结果成功。若 abort 发生在首次持久化前，不得伪造历史，测试应等待可观察的 transcript 边界再 abort。

- [ ] **Step 4：实现最小 resolver 并接线**

resolver 先做互斥/不支持校验，再按 fresh/continue/resume/fork 分派。fresh 生成新 UUID 并总是经 `switchSession` 设置，不能只在提供 resume 时 switch；continue 用现有列表/解析能力定位最近文件；resume 保留源 ID 与 projectDir；fork 调 `forkSdkSession` 后加载新 ID。将结果交给现有 `switchSession` 和 `mutableMessages`，确保 storage flush 和 persistence lease 沿用。不得复制 DAG 恢复算法，不改变文件 checkpoint 规则，不实现 resumeSessionAt。

Run:
```bash
bun run test:integration tests/integration/sdk/sessions.test.ts tests/integration/sdk/query-lifecycle.test.ts
bun test tests/sdkSessions.test.ts tests/sessionChainRecovery.test.ts tests/sdkQueryLifecycle.test.ts
```

- [ ] **Step 5：登记并提交**

将新 source 和 sessions 测试加入 sdk-query-sessions 唯一 coverage 组，运行 design gate，提交本 Task 文件。

---

### Task 7：token-count 迁移与最终门禁

**Files:**
- Create: `tests/integration/sdk/token-count.test.ts`
- Modify: `tests/integration/support/sdk.ts`（新增不自动 return 的 `pauseAtResult`）
- Modify only on red evidence: `src/utils/sdkQuery.ts`、`src/entrypoints/sdk/runtimeTypes.ts`、`src/utils/sdkControl.ts`
- Delete: 16 个 `fixtures/token-count-*.json`
- Modify: `docs/architecture/coverage/sdk-query-sessions.yaml`

**Interfaces:**
- 通过 classic query 返回对象的公开 `getContextUsage()` 调真实 usage 路径；若公开 Query 类型遗漏该方法，按官方 TypeScript reference 将现有 `InternalQuery.getContextUsage` 契约提升到公开 Query，不新增平行实现。
- 测试支撑提供 `pauseAtResult(query)`：用手工 `query.next()` 收集消息，遇到 success result 后立即返回 `{ messages, result }`，**不调用 return，不用 for-await break**；调用方负责在 finally 中 return/close。
- mock count_tokens 继续使用现有 `{input_tokens:number}` 响应和请求录制，不引入真实录制。

- [ ] **Step 1：在 env lease 活跃时写真实 token-count 测试**

禁止“完整消费 query 后再调用 getContextUsage”：那时 generator finally 已清理并恢复 env，可能把 count_tokens 发到真实 `ANTHROPIC_BASE_URL`。按以下顺序实现：
1. 用 `pauseAtResult(query)` 手工 `next()` 到唯一文本的 success result，确认 generator 仍暂停在 yield，未进入 finally；
2. 此时断言 `process.env.ANTHROPIC_BASE_URL === mock.url`、API key 仍为假值，然后才 `await query.getContextUsage()`；
3. 在 finally 中 `await query.return(undefined)`/close，之后才断言原 env 已恢复；此后不得再次调用 usage。

usage 活跃期间断言：
1. mock 至少收到一个 `/v1/messages/count_tokens`；请求为 POST，body 含模型和 messages/tools 相关字段；
2. 每个响应 input_tokens 为有限非负数；usage.categories/totalTokens/maxTokens 结构有效，相关分类使用 mock 数值而非 null；
3. count_tokens 请求不作为 SDK assistant/result 消息出现在原 query 消息流；
4. 若发多个分类请求，断言每个录制值和聚合一致性，不假定请求恰好一次。

Run `bun run test:integration tests/integration/sdk/token-count.test.ts`。只对真实失败做最小修复，不用本地估算替代 full usage。若暂停点无法维持 mock env，停止测试并重新设计 per-query API config；不得为取得结果而允许真实网络或读取真实凭据。

- [ ] **Step 2：删除前重新证明 fixtures 无消费者**

Run:
```bash
rg -n "token-count-|fixtures/token-count" src tests scripts docs package.json
for f in fixtures/token-count-*.json; do jq -e '.tokenCount == null and (keys == ["tokenCount"])' "$f"; done
```
Expected：除本设计/计划和 fixtures 自身外无运行时消费者；16 个文件仍全为 null。如果出现新消费者，停止删除并更新设计，不得强行按旧清单执行。

- [ ] **Step 3：删除空 fixtures**

对设计时 13 个 tracked 文件使用 `git rm`；对工作区仍存在的 3 个既有未跟踪文件（`0ec853c8c1b3`、`89a86bd029c0`、`9657eb13c6fe`）仅在 Step 2 复核后移除。不得提交任何新录制。运行 `rg --files fixtures | rg 'token-count-'`，Expected 无输出。

- [ ] **Step 4：跑 SDK/config/全集成门禁**

```bash
bun run test:integration --suite=sdk
bun run test:integration --suite=config-acceptance
bun run test:integration
rg -n "test\.skip" tests/integration/sdk
```
Expected：前三条退出 0；最后一条无输出。runner 若有 `Failed test files`，即使末尾单个文件 pass 也判失败。

- [ ] **Step 5：跑完整工程与设计门禁**

```bash
bun run test
bun run typecheck
bun run build
bun scripts/check-design-docs.ts
```
Expected：全部退出 0；design gate 0 errors。warnings 按实际 draft/uncovered 输出报告，不把 warnings 写成 0。若遇 sandbox EPERM 等环境问题，记录文件、错误和重跑边界，不能标为通过。

- [ ] **Step 6：最终自查与提交**

确认六文件均被 runner 发现、config 两个 elicitation active、无 v2 替代、无 URL/真实 MCP、无凭据、无 unit runner/CI/smoke 改动。coverage 包含所有实际新增 source/test 且无重复归属。提交本 Task 文件。

## Self-Review 清单

- 阶段顺序与 spec 决策一致：支撑/dist → 既有 query → 错误/中断 → hooks/ownership → MCP/elicitation → classic sessions → token/最终门禁。
- 每阶段均包含红测或既有保护识别、最小实现、实际命令和退出码要求；不存在以设计推断冒充通过结果的步骤。
- `canUseTool` 不用 allowedTools 绕过；末次错误同时断言 result 和 throw；interrupt 与外部 abort 分开；hooks 按 per-registration occurrence 清理，并有 shared-matcher 回归。
- MCP 恢复明确为 explicit replacement；elicitation 只覆盖 form；config active 前先扩 `entries.ts` parser 并测 unknown-trigger 拒绝，再有真实场景断言。
- sessions 只走 classic query；两个 fresh query 必须有不同 ID；continue/resume/fork 检查真实历史；continue+resume 互斥，resumeSessionAt 一律明确拒绝；abort 后 resume 有持久化边界。
- token 测试在 result yield 暂停点、env lease 活跃时走 getContextUsage + 本地 mock count_tokens，return 后才恢复 env；16 个 null fixtures 只有复核后才删除，不重录。
