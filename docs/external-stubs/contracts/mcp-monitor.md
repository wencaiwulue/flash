# MCP Monitor 与 Tasks 取消契约

- 日期：2026-11-11
- 状态：公开实现设计，尚未实现
- 范围：`MonitorMcpTask`、MCP Tasks 适配层、后台任务 UI、agent 清理

## 1. 事实基础与协议边界

当前 `src/tasks/MonitorMcpTask/MonitorMcpTask.ts` 的 kill 函数固定返回 false/0 或抛 unavailable，`src/components/tasks/MonitorMcpDetailDialog.tsx` 也只显示 unavailable。`src/Task.ts` 已提供统一的 `pending | running | completed | failed | killed`、task id 和 `setAppState`，`src/utils/task/framework.ts` 已提供注册、更新、通知和回收机制。

`src/services/mcp/client.ts` 当前用 `client.callTool(..., CallToolResultSchema, ...)` 等待普通工具结果，`package.json` 固定 `@modelcontextprotocol/sdk` 为 `^1.8.0`；已安装的该版本没有 `tasks/get`、`tasks/list`、`tasks/cancel` 类型。因此不能把普通 MCP 长请求或本地 task id 假装成 MCP Task。实现前必须升级到带公开 Tasks schema 的 SDK，并从该 SDK 导入请求/结果 schema 与 capability 类型，不手写一套猜想的线格式。

本设计只使用公开 MCP 能力：

- 服务端通过初始化 capabilities 明确声明 Tasks 及相应请求类型、get/list/cancel 支持；未声明就不创建远端任务监视器。
- `tasks/get` 查询指定远端 task 的状态/结果；`tasks/list` 仅用于已建立映射后的重连核对；状态通知按公开 schema 订阅。
- `tasks/cancel` 的参数是**服务端返回的 remote taskId**，返回或后续查询确认远端任务为 cancelled。
- 普通 `tools/call` 的 AbortSignal 只中止本地等待，不代表远端工作已取消。

## 2. 本地状态与映射

`MonitorMcpTaskState` 在现有 `TaskStateBase`、`agentId`、`error` 上增加：

```ts
{
  type: 'monitor_mcp'
  serverName: string
  toolName: string
  remoteTaskId: string
  remoteStatus: string
  cancelRequested: boolean
  pollIntervalMs?: number
  lastRemoteUpdateAt?: number
}
```

本地 id 继续由 `generateTaskId('monitor_mcp')` 生成，与 `remoteTaskId` 永不相等也不混用。运行态可通过 registry 保存 `(serverName, remoteTaskId) -> ConnectedMCPServer` 与取消中的 Promise；registry 不序列化认证信息。恢复时只能通过 serverName 和 remoteTaskId 重新连接并调用 `tasks/get`，不能从 transcript 恢复 token。

创建入口接收 MCP task-augmented 工具调用的真实 CreateTaskResult，使用 `createTaskStateBase()`、`registerTask()` 注册本地任务。普通 CallToolResult、没有 remote taskId 的结果、或未协商 Tasks 的服务端仍走当前同步工具结果路径，不生成假的 `monitor_mcp`。

状态映射为：

- 远端 working/input_required 等未终止状态：本地 `running`（初始可为 `pending`），保留原始 `remoteStatus`。
- completed：本地 `completed`；failed：本地 `failed`；cancelled：本地 `killed`。
- 只有终态设置 `endTime`、停止轮询并进入既有任务通知/回收流程。网络错误、超时、失去连接和“本地不再等待”都不是终态。

## 3. 状态同步

每个运行中的监视器遵循服务端公布的 poll interval；没有该值时使用有上限的指数退避和 jitter。通知与轮询通过同一 `applyRemoteTask()` 串行合并，带单调更新的远端状态/时间信息，防止迟到的 working 覆盖 completed/cancelled。

`tasks/get` 返回最终结果后，复用 `processMCPResult()` 的既有内容处理与大小限制，把模型可见结果写入任务输出，不重复投递已完成结果。`tasks/list` 不用于枚举并控制无关任务：重连后只接受已有 registry 中的 remoteTaskId 映射；列表中缺失不直接判 killed，而是对指定 id 调 `tasks/get`，以明确 not-found/终态响应和本地错误状态区分。

连接断开时保留任务和 remoteTaskId，显示 reconnecting/error 并停止密集请求；重连成功后核对。进程关闭时默认停止本地观察，不主动取消远端任务；只有用户选择停止任务或 agent 清理策略明确要求时才发 cancel。

## 4. cancel 的唯一成功语义

### 4.1 单任务 API

将同步签名改为可等待的协议操作：

```ts
killMonitorMcp(taskId, getAppState, setAppState): Promise<boolean>
```

调用方需要 state 访问，故显式传入 `getAppState`，不再依赖隐藏全局。返回值表示“远端已确认 cancelled，或调用前已处于终态”，不表示仅仅发出了请求。

流程：

1. 本地任务不存在、类型不符或已是终态：终态幂等返回 true；不存在/类型错误返回 false，不发网络请求。
2. 首个调用原子设置 `cancelRequested=true`、清旧 error，但保留 `status='running'`。重复调用共享同一个 in-flight Promise。
3. 通过 registry 找到原服务端连接，确认当前连接仍声明 Tasks cancel；调用 SDK 的 `tasks/cancel`，只传该任务的 remoteTaskId。
4. cancel 响应直接确认 cancelled，或随后一次 `tasks/get`/状态通知确认 cancelled 后，才设置 `status='killed'`、`endTime`、`notified` 并返回 true。
5. 方法不支持、请求失败、超时、连接断开、响应仍非终态时返回 false 并保留可观察的 `error`；`cancelRequested` 保持 true，允许重试，但**不得设置 killed、completed 或“远端进程已停止”文案**。
6. 若服务端明确返回 unknown task，保留 `failed`（不是 killed）和可诊断错误；只有已通过 `tasks/get` 证实其终态时才映射该终态。

取消表示请求服务端按 MCP Tasks 语义取消任务，不等价于 kill 操作系统进程、杀死 MCP server、删除容器或回滚远端副作用。UI 必须如实显示“已请求取消，等待服务端确认”。

### 4.2 agent 批量清理

`killMonitorMcpTasksForAgent()` 改为 `Promise<number>`，在 `src/tools/AgentTool/runAgent.ts` 的 async `finally` 中 await。它只选择匹配 agentId 的 `monitor_mcp`，并发度受限地调用单任务 API，返回**本次已确认进入终态**的数量；失败数量另行记录并保留在 UI，不把发出 cancel 的数量冒充 stopped。

本地 shell 任务仍走 `killShellTasksForAgent()` 的进程清理；MCP 任务不得借用 tree-kill 或本地 AbortController 来伪装远端取消。

## 5. UI 与通知

`MonitorMcpDetailDialog` 展示本地 id、服务端/工具名、remoteTaskId（可截断）、远端状态、最近更新时间和 error：

- running 且未请求取消：提供“Request cancellation”。
- `cancelRequested && running`：显示等待确认并禁用重复按钮，可提供重试（在失败时）。
- cancelled/本地 killed：显示“Remote task cancelled”。
- 失败或连接中断：显示“观察状态未知/失败”，不能显示 stopped。

`onKill` 等待 Promise 后根据真实状态展示结果。任务通知沿用现有 XML/task framework；状态变化去重，error 重试不产生完成通知。纯查看/隐藏详情与取消是不同操作，关闭对话框绝不应隐式发 cancel。

## 6. 安全、隐私与副作用

- cancel 是远端写操作，必须经过明确用户操作或已文档化的 agent 清理；轮询/get/list 不自动取消。
- remoteTaskId 不是权限凭证，但仍按敏感标识处理，不写分析事件；日志不包含 access token、请求头、工具参数或结果正文。
- 只能取消本进程登记且与 serverName 绑定的任务，拒绝 UI 输入任意远端 id。
- 每个请求使用既有 MCP timeout/AbortSignal；本地 abort 只放弃等待，UI 继续保持未知/运行态。
- 不信任服务端返回的状态或结果结构，全部经升级后 SDK 的公开 Zod schema 校验。

## 7. 验收测试

使用内存 fake MCP client 和 fake setAppState，不依赖真实远端进程：

1. 未声明 Tasks、普通 CallToolResult、缺 remoteTaskId 时不注册 monitor。
2. working/input_required/completed/failed/cancelled 的映射、迟到状态覆盖、结果只投递一次。
3. cancel 确认前状态仍 running；响应 cancelled 后才 killed；重复点击只发一次线请求。
4. cancel 不支持、超时、断线、unknown id、非终态响应均不返回成功也不标 killed。
5. 本地 AbortSignal 触发时不发隐式 cancel、不伪报远端停止。
6. agent 批量清理的返回值只计确认终态，单个失败不阻塞其他任务，也不误杀同 agent 的 shell 或其他 server 的任务。
7. 重连只核对已登记 id；list 缺失、get 终态和 get 失败三种情况分别处理。
8. UI 验证按钮、等待、失败、取消确认文案；关闭详情无网络副作用。
9. 与升级后的 SDK 做 schema 兼容测试，确保实际发送方法是 `tasks/cancel` 且参数为 remoteTaskId。
