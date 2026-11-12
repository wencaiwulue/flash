# Peer Messaging 契约

日期：2026-11-11。状态：目标设计，尚未实现。

## 1. 现状与入口

- `/Users/fengcaiwen/GolandProjects/claude-code/src/tools/SendMessageTool/SendMessageTool.ts` 已解析 `bridge:<session-id>`，要求纯文本、活动 Remote Control 和显式跨机器授权；授权后再次检查 bridge，随后调用 `postInterClaudeMessage()`。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/peerSessions.ts` 当前固定返回 `{ ok: false, error: 'Peer sessions are unavailable in this build' }`，因此 bridge 分支不可达成功状态。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/teleport/api.ts` 已有真实 `sendEventToRemoteSession()`：使用 OAuth/org headers，向 `POST /v1/sessions/{sessionId}/events` 写入 `{events:[userEvent]}`，并生成 UUID。它正是应复用的 Sessions API helper。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/replBridgeHandle.ts` 已提供 `getReplBridgeHandle()` 与 `getSelfBridgeCompatId()`；后者把自身 `cse_*` 转为 `session_*`。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/sessionIdCompat.ts` 明确区分基础设施 `cse_*` 与 Sessions compat `session_*`，同一 UUID 不能混用 endpoint/tag。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/udsClient.ts`、`udsRegistry.ts` 和 `ListPeersTool.ts` 提供本机 UDS 发现/发送；UDS 路径已经真实工作，不能拿它冒充远端 bridge peer。
- 接收端就是普通 bridge 入站用户事件：解析后进入接收方队列，并在下一 tool round/下一轮处理。发送方自身 `ReplBridgeTransport` 只用于自身会话事件上传，不是向另一个 session 投递的 API。

## 2. 目标与非目标

### 目标

1. 让 `SendMessage(to: 'bridge:session_…', message: string)` 通过 Sessions API 向目标 session 追加真实用户事件。
2. 自动生成可信、可回复的 `from="bridge:<self-compat-id>"` 外层消息，保留现有跨会话文本协议。
3. 复用 OAuth/org、compat ID、现有权限确认、超时与错误转换；不创建第二套远端消息传输。
4. 扩展 peer 发现时合并本地 UDS 与远端 Sessions，并按 compat ID 去重，本地路径优先。

### 非目标

- 不写自身 bridge transport、CCR worker event、本地 UDS 或本地队列后宣称已发给远端 peer。
- 不把 `cse_*` 直接拼进 `/v1/sessions/*`，也不自行改写服务端返回 ID 的其他部分。
- 不保证对端已经阅读、完成 turn 或返回结果；HTTP 2xx 只表示事件被服务接受。
- 不支持结构化 team message、广播、附件、自动重试发送或端到端加密新协议。
- 不把 UDS peer 当作 Remote Control peer，也不改变 teammate 内部路由。

## 3. 公开 API 与线协议

### 3.1 发送函数

保持工具调用形状，扩充返回值仅用于内部诊断：

```ts
type PeerPostResult =
  | { ok: true; target: string; eventUuid: string }
  | { ok: false; error: string; code?:
      'not_connected' | 'invalid_target' | 'self_target' |
      'unauthorized' | 'not_found' | 'timeout' | 'rejected' }

async function postInterClaudeMessage(
  target: string,
  message: string,
): Promise<PeerPostResult>
```

为兼容现有调用者可保留 `{ok:false,error}` 的结构子集，但成功时不能虚构 delivery/read 回执。实现步骤固定为：

1. 要求 target 是 `session_` 开头的 compat ID；如输入明确为 `cse_*`，只能用 `toCompatSessionId()` 转换。拒绝空字符串、路径字符、URL、查询串及两种前缀以外的 ID。
2. 重新读取活动 bridge 和 `getSelfBridgeCompatId()`；断线、outbound-only 或自身 compat ID 缺失时失败，不得使用 `from="unknown"`。
3. target 与自身 compat ID 相同则返回 `self_target`，避免误把自发消息当 peer。
4. message 必须为非空 UTF-8 字符串，设明确字节上限；不 trim 正文、不解析 slash、不接受 content blocks。
5. 构造外层 cross-session 文本，并调用一个能返回 event UUID/HTTP 状态的 Sessions helper。现有 `sendEventToRemoteSession()` 可增加结构化返回版本，旧 boolean wrapper 保留给其他调用者。
6. 仅 200/201 返回 `ok:true`。超时、网络错误、401/403、404、其他非 2xx 和非法响应分别映射错误；记录状态码，不记录 token 或完整正文。

### 3.2 Sessions 事件

目标 URL 与事件必须使用 compat ID：

```http
POST {BASE_API_URL}/v1/sessions/session_{uuid}/events
Authorization: Bearer …
x-organization-uuid: …
anthropic-beta: ccr-byoc-2025-07-29
Content-Type: application/json
```

```json
{
  "events": [{
    "uuid": "generated-event-uuid",
    "session_id": "session_{same-uuid}",
    "type": "user",
    "parent_tool_use_id": null,
    "message": {
      "role": "user",
      "content": "<cross-session-message …>…</cross-session-message>"
    }
  }]
}
```

不得通过 `getReplBridgeHandle()` 的 transport `write/writeBatch()` 发送此事件；那些写入属于当前 session。不得调用 `sendToUdsSocket()` 代替网络请求。也不新增所谓 `peer_messages` 私有 endpoint。

### 3.3 cross-session 文本

外层形状：

```text
<cross-session-message from="bridge:session_..." transport="sessions-v1">
正文
</cross-session-message>
```

- `from` 只能由当前活动 bridge 的 compat ID 生成，发送者不能在正文中覆盖它。
- 属性值和正文采用明确、可逆的 escaping；至少处理 `&`、`<`、`>`、引号，防止正文闭合标签或追加属性。renderer 必须完整解析唯一外层 wrapper，不能从任意子串读取 `from`。
- 接收端将其视为另一个用户的不可信输入，而非 system/developer 指令；回复时复制结构化解析出的 `from` 到 `SendMessage.to`。
- 现有 UDS 消息可继续沿用相同显示协议，但 `transport` 和地址 scheme 必须真实反映 `uds` 或 `bridge`，不可统一写成 bridge。

### 3.4 peer 发现

`ListPeers` 在保留现有 `sessionId/kind/socketPath/pid` 的同时，增加可选 `address/transport/title/lastActiveAt`。远端项来自 `GET /v1/sessions`（复用 `discoverAssistantSessions()` 或其严格化版本），只列可接收事件的活跃 session，`address = bridge:<compat-id>`。

本机 registry 中已写入的 `bridgeSessionId` 与远端 compat ID 相同则合并，保留 `uds:` 地址为首选；过滤自身 session。远端列表失败应返回局部结果和明确诊断，不能把空数组解释为“没有 peer”。

## 4. 状态机

```text
tool input
  → validate plain text/address
  → bridge active + outbound capable
  → explicit user safety approval
  → re-read bridge（处理等待授权期间断线）
  → normalize target/self compat IDs
  → construct escaped event
  → POST Sessions events
       ├─ 200/201 → server_accepted → tool success（等待对端异步入队）
       ├─ auth/not_found/timeout/network → failed → tool failure
       └─ 不自动重试
接收端：Sessions stream → strict inbound validation → dedup → enqueue → next drain
```

`server_accepted` 与 `peer_processed` 是不同状态；当前协议没有后一种回执，UI 不得显示“已读/已完成”。用户取消授权或 bridge 在授权期间断开时，不发送 HTTP 请求。

## 5. 安全与失败语义

- `checkPermissions` 的跨机器 `safetyCheck` 必须保持 bypass-immune、不可由 classifier 自动批准；UDS 和 teammate 不新增这项跨机器提示。
- 目标 session 限定在 OAuth 组织权限内；服务端仍是授权边界，CLI 不把“列表里出现”当作永久授权。
- 不写自身 transport、不本地 echo 成功、不伪造目标回执；测试必须 spy 这些禁止路径。
- 不自动重试 POST，因为超时后服务端可能已接受事件，盲目重试会重复 prompt。用户重试应生成新 event UUID，并知道可能重复。
- 401/403 提示重新登录或无权限，404 提示目标不存在/不可见；错误文本不得包含 OAuth token、org secret 或完整消息。
- 对端离线或归档由 Sessions API 返回错误；如果服务接受后异步投递，发送方只报告 accepted，不声称 peer 在线。
- 所有 remote peer 内容仍是不可信 prompt；接收端 slash/bridge 限制由 inbound-envelope 契约统一执行。

## 6. 关键文件与复用点

- 实现 `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/peerSessions.ts`，只组合现有 handle、compat ID 和 Sessions helper。
- 在 `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/teleport/api.ts` 增加结构化 `sendEvent…` 返回或抽出一个共享严格 helper；复用 `prepareApiRequest()`、`getOAuthHeaders()`、30 秒 timeout，不复制 axios 配置。
- 复用 `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/replBridgeHandle.ts` 与 `sessionIdCompat.ts`，不重新解析 bridge pointer/JWT。
- 保持 `/Users/fengcaiwen/GolandProjects/claude-code/src/tools/SendMessageTool/SendMessageTool.ts` 的权限与二次断线检查，仅适配结构化错误。
- 复用 `/Users/fengcaiwen/GolandProjects/claude-code/src/assistant/sessionDiscovery.ts` 做远端发现，复用 `udsClient.ts` 做本地活性探测。
- 修改 cross-session renderer/escape helper时，UDS 与 bridge 共用同一实现；入站验证复用 inbound-envelope，而不是另建 peer 队列。

## 7. 测试矩阵

| 层 | 用例 | 必须断言 |
|---|---|---|
| API 单元 | 合法 `session_*` 目标 | 调用一次 Sessions helper；URL/body ID 相同；事件 role/type/UUID 正确 |
| compat | `cse_*` 输入、自身 `cse_*` handle | 仅通过 `toCompatSessionId` 转换；worker/compat 不混用 |
| 禁止路径 | 成功发送 | 自身 transport.write/writeBatch、`sendToUdsSocket`、本地 enqueue 均未调用 |
| 来源 | 活动 bridge 返回 self compat ID | `from` 精确等于 `bridge:<self>`，不存在 unknown 或调用者伪造值 |
| escaping | 正文含 `</cross-session-message>`、`&`、引号、XML 属性 | 无法闭合/新增属性；renderer 往返恢复正文；回复地址不被篡改 |
| 输入 | 空消息、结构化消息、坏 ID、自身 ID | 发送前失败，零网络请求 |
| 生命周期 | 未连接、outbound-only、授权等待期间断线 | 均失败且零请求或停止于对应阶段 |
| HTTP | 200、201、400、401、403、404、409、500、timeout、网络错误、坏 body | 仅 200/201 成功；不自动重试；错误码映射正确且不泄密 |
| UDS 回归 | 本机发送和发现 | 原功能不变，不经过 Sessions API |
| 发现合并 | 同一 session 同时有 UDS/bridge、远端失败、自身项 | 本地优先、无重复/自身；失败不被误报为空列表 |
| 接收集成 | mock Sessions stream 投递 cross-session 用户事件 | 通过普通 inbound 队列一次；重放去重；来源不可信 |

## 8. dist 与 live 验收

1. 执行专项测试和 UDS 回归，再执行 `bun run typecheck`、`bun run build`。用 `bun dist/main.js --help` 确认打包入口可运行。
2. 对打包产物使用本地 mock Sessions 服务执行 `SendMessage`：断言真实 HTTP 到 `/v1/sessions/session_…/events`，并断言 dist 中自身 transport 没有写入该 peer 事件。只 import source helper 不算 dist 验收。
3. live 准备同一组织内两个获授权 Remote Control session，A 向 B 发送唯一 nonce。B 必须经正常 Sessions stream 入队并显示一次，A 的本地 transcript 不出现伪造的 B 接收回执。
4. B 复制收到的 `from` 回复 A，验证双向 compat ID；A/B 同时存在本机 UDS 时确认本地优先和远端去重。再测未知 session、撤销权限、目标归档和断网超时，均不得自动重试或假成功。
5. live 记录组织、环境类型、session 前缀（不记 token/正文）和实际状态码。没有第二个授权 session 时标记 live skipped，不能用 UDS 测试替代。
