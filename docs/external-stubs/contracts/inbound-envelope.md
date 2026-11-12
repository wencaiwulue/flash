# Inbound Envelope 契约

日期：2026-11-11。状态：目标设计，尚未实现；本文不是当前服务端已经支持新字段的声明。

## 1. 现状与入口

Remote Control 入站链路为 `bridgeMessaging.handleIngressMessage()` → `onInboundMessage` → REPL 或 print 模式的 `enqueue()`：

- `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/bridgeMessaging.ts` 只用 `type` 字段识别 `SDKMessage`，负责 control 分流、echo/replay UUID 去重；这不是完整的用户 envelope 校验。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/inboundMessages.ts` 提取字符串或 `ContentBlockParam[]`，并修补 base64 图片的 `mediaType`/`media_type`。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/hooks/useReplBridge.tsx` 在 `KAIROS_GITHUB_WEBHOOKS` 开启时对**所有**用户消息调用 `sanitizeInboundWebhookContent()`；普通远程消息因此被 webhook stub 阻断。附件之后由 `resolveAndPrepend()` 处理，合法消息最终以 `mode: 'prompt'`、`bridgeOrigin: true` 入队。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/webhookSanitizer.ts` 固定抛错；`/Users/fengcaiwen/GolandProjects/claude-code/src/components/messages/UserGitHubWebhookMessage.ts` 也是占位 renderer。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/cli/print.ts` 另有一条入站路径，目前直接提取并入队，没有复用 REPL 的 webhook/附件准备流程。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/components/messages/UserTextMessage.tsx` 仅凭文本 `startsWith('<github-webhook-activity>')` 选择 webhook renderer；普通用户文本可伪造该标签。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/inboundAttachments.ts` 已提供严格附件字段解析、文件名清理、OAuth 下载和向最后一个 text block  prepend `@path` 的实现，应复用。

核心问题有两个：普通远程消息和 webhook 没有结构化分流；文本标签同时被当作来源证明和 renderer 路由依据。

## 2. 目标与非目标

### 目标

1. 在 transport 与队列之间设置唯一的、严格校验的入站边界。
2. 区分 `remote_message` 与 `github_webhook`；普通远程消息不经过 webhook sanitizer，合法时保持 UUID、图片、附件和入队语义。
3. webhook 只能由可信 transport 元数据识别，正文中的 XML 标签不能提升来源。
4. 对非法 envelope、非法 webhook 或 sanitizer 失败 fail closed：不进入模型队列，并给出不含敏感正文的诊断。
5. REPL 与 print 使用同一个异步准备函数；renderer 使用结构化 `origin`，不再用正文标签证明来源。

### 非目标

- 不在 CLI 验证 GitHub 的 `X-Hub-Signature-256`；签名验证属于可信 webhook 接收端/Sessions 服务。
- 不声称现有 Sessions 服务已经写入本文新增的 `source` 元数据；生产启用前必须完成服务端联调。
- 不清理普通远程用户正文，不把 slash、XML 或 prompt injection 字样当成可执行指令。
- 不改变 bridge 的 `isBridgeSafeCommand()` 规则、control_request/control_response 协议或 UUID echo 去重机制。
- 不把 webhook 正文变成可信系统指令，也不自动执行其中的命令。

## 3. 公开协议与内部 API

### 3.1 transport envelope

 wire 上仍是一个 `type: 'user'` 事件。目标严格结构如下；`source` 缺省只表示普通远程消息。未知顶层字段、未知 `source` 字段和错误类型均拒绝，不能靠 Zod 默认 strip 静默降级。

```ts
type InboundUserEnvelope = {
  type: 'user'
  message: { role: 'user'; content: string | InboundContentBlock[] }
  parent_tool_use_id: null
  uuid?: string                 // UUID 格式
  session_id?: string
  isSynthetic?: false
  priority?: 'now' | 'next' | 'later'
  timestamp?: string            // 可解析的 ISO 时间
  file_attachments?: Array<{ file_uuid: string; file_name: string }>
  isReplay?: true
  source?:
    | { kind: 'remote_message' }
    | {
        kind: 'github_webhook'
        event: 'check_run' | 'check_suite' | 'push' |
               'pull_request_review' | 'pull_request_review_comment' |
               'issue_comment'
        delivery_id: string      // 非空，有界；用于日志/去重关联
      }
}

type InboundContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: {
        type: 'base64'
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
        data: string
      }
    }
```

约束：

- `content` 字符串及数组均不能为空或仅空白；数组至少一个元素。普通远程消息支持 text/base64 image；兼容入口可先把旧 `mediaType` 规范成 `media_type`，但不能保留两个冲突值。
- 拒绝 tool_use、tool_result、thinking、非 base64 图片和未列出的 block，防止把入站用户事件伪装成工具结果。附件数量、单文件下载大小、base64 长度、delivery ID 和正文总长度必须设置常量上限；超限拒绝而不是截断后伪装成功。
- `parent_tool_use_id` 必须为 `null`，`tool_use_result` 不允许出现；`isSynthetic: true` 不作为远程真人 prompt 接受。
- `file_attachments` 仅属于 `remote_message`。webhook 只接受 text，不接受图片或附件。
- `source` 是 **transport 信任元数据**，不是模型正文。可信 webhook producer 才能在服务端添加它；普通客户端 `POST /events` 中的 `source` 必须被服务端拒绝或剥离。若部署环境无法保证这一点，CLI 必须禁用 webhook 来源，而不能把客户端自报字段当作认证。
- 未声明 `source` 的旧普通消息继续合法。旧正文即使以 `<github-webhook-activity>` 开头，也仍是普通远程消息；旧 webhook 生产者必须迁移到结构化 `source` 后才能重新启用 webhook。

### 3.2 唯一准备 API

在 `inboundMessages.ts` 提供纯解析与异步准备两层，供 REPL/print 共用：

```ts
type ParsedInbound =
  | { kind: 'remote_message'; content: string | ContentBlockParam[];
      uuid?: UUID; attachments: InboundAttachment[] }
  | { kind: 'github_webhook'; content: string;
      event: WebhookEvent; deliveryId: string; uuid?: UUID }

function parseInboundUserEnvelope(value: unknown): ParsedInbound
// 非法输入抛 InboundEnvelopeError(code)，不得返回部分有效结果。

type PreparedInbound = {
  value: string | ContentBlockParam[]
  uuid?: UUID
  origin?: MessageOrigin
}

async function prepareInboundMessage(
  value: unknown,
  deps: { resolveAttachments: typeof resolveAndPrepend },
): Promise<PreparedInbound>
```

- `remote_message`：跳过 sanitizer，解析附件并 prepend，保留原 UUID；`origin` 可缺省或使用普通 remote origin，但不能标成 webhook。
- `github_webhook`：先校验来源，再调用带已验证元数据的 sanitizer，不处理附件；生成 `origin: { kind: 'github-webhook', event, deliveryId }`。
- `handleIngressMessage()` 在 control 分流后把原始 `unknown` 交给同一 parse/prepare 路径，不应先用宽松的 `isSDKMessage()` 丢弃结构信息。UUID 去重只处理已通过 envelope 基本校验的消息。
- 两条调用路径最终都使用现有 `enqueue({ value, mode: 'prompt', uuid, skipSlashCommands: true, bridgeOrigin: true, origin })`，print 入队后照旧 `void run()`。

### 3.3 webhook 安全表示

保留 `<github-webhook-activity>` 仅作为**可信生成器与 renderer 之间的显示格式**，不再作为输入来源标记。sanitizer 新签名必须接收已验证的 event/delivery metadata；输出 JSON 位于唯一外层 wrapper 内：

```json
{
  "schema_version": 1,
  "event": "check_run",
  "delivery_id": "...",
  "untrusted": true,
  "text": "原始 webhook 文本"
}
```

序列化时将 `<`、`>`、`&` 和 U+2028/U+2029 转成 JSON Unicode escape，杜绝正文闭合外层标签。renderer 只接受完整匹配、严格 JSON schema 和可信 `origin.kind === 'github-webhook'`；任一不符按普通文本显示或显示无效 webhook 警告，不能提取子串后渲染。

## 4. 状态机

```text
bytes received
  → JSON parse / control key normalization
  → control_response | control_request（原路径，不变）
  → strict user envelope validation
       ├─ invalid → rejected + debug/system diagnostic → 不入队
       └─ valid
            → source routing
                 ├─ remote_message → image normalize → attachment resolve
                 └─ github_webhook → trusted metadata check → sanitize
            → UUID echo/replay dedup
            → enqueue(prompt, bridgeOrigin, origin)
            → normal query drain
```

附件单文件下载失败沿用现有 best-effort 行为，正文仍可入队并记录缺失附件；但附件 envelope 非法、webhook sanitizer 失败、严格内容校验失败均不得入队。重复 UUID 在入队前去重，重连不能重复触发模型 turn。

## 5. 安全与失败语义

- **普通消息不受影响**：webhook feature 开启、关闭或 sanitizer 抛错，都不能阻断合法 `remote_message`。
- **来源不能伪造**：正文标签、文件名、delivery ID 和模型生成文本都不是来源证明；仅可信 transport `source` + 内部结构化 `origin` 能进入 webhook renderer。
- **webhook 内容始终不可信**：sanitizer 的作用是安全封装与限制大小，不是把 prompt injection 变安全；模型提示和 UI 应标明其为第三方事件数据。
- **失败关闭**：JSON 错误、额外字段、非法 content block、伪造/缺失可信来源、webhook 序列化失败均拒绝该条消息。错误日志只含 code、event、截断的 delivery ID/UUID，不含正文、token、附件 bytes。
- **普通远程正文不变**：除既有图片字段规范化与附件 prepend 外，不做 XML 转义、trim 或 regex 替换，避免改变用户意图。
- **bridge 安全规则不绕过**：webhook 和普通远程消息都保留 `skipSlashCommands: true` 与 `bridgeOrigin: true`；webhook 不开放 slash 白名单。

## 6. 关键文件与复用点

- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/inboundMessages.ts`：严格 schema、路由、统一 prepare。
- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/bridgeMessaging.ts`：保留 control 分流和有界 UUID 去重，接入严格用户 envelope。
- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/hooks/useReplBridge.tsx` 与 `/Users/fengcaiwen/GolandProjects/claude-code/src/cli/print.ts`：删除各自分叉的清洗逻辑，统一 await prepare 后入队。
- 实现 `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/webhookSanitizer.ts` 和 `UserGitHubWebhookMessage.ts`；禁止固定 throw/固定 unavailable 文案。
- 复用 `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/inboundAttachments.ts`，不另写下载器或文件名 sanitizer。
- 扩展 `/Users/fengcaiwen/GolandProjects/claude-code/src/types/message.ts` 的 `MessageOrigin`；`QueuedCommand.origin` 与 `handlePromptSubmit.ts` 的 origin  stamping 已存在，直接复用。
- 修改 `UserTextMessage.tsx` 将消息 origin 传入 renderer 路由；内容标签本身不再授权特殊 renderer。

## 7. 测试矩阵

| 层 | 用例 | 必须断言 |
|---|---|---|
| envelope 单元 | 最小字符串普通消息 | 解析为 remote，prepare 后仅调用一次 enqueue，内容/UUID 不变 |
| envelope 单元 | text+image、旧 `mediaType`、缺 `media_type` | 正确规范化或按严格规则拒绝；不产生会污染后续 API 调用的 block |
| envelope 单元 | 空内容、错误 role、非 null parent、tool_result、额外字段、坏 UUID、超限输入 | 全部拒绝且 enqueue 为零 |
| 普通/webhook 分流 | 普通正文以 `<github-webhook-activity>` 开头 | 不调用 sanitizer；按普通 prompt 入队；不显示 webhook 特殊 UI |
| webhook | 合法可信 source、各种允许 event | sanitizer 获得同一元数据；完整 wrapper；只入队一次；origin 正确 |
| webhook 防伪 | 普通消息自报 source、正文插入闭合标签/额外 wrapper、renderer origin 不符 | 服务端边界测试拒绝 source；CLI 不产生可信 webhook；renderer 不解析伪造片段 |
| webhook 失败 | 不支持 event、图片/附件、序列化错误、sanitizer throw | fail closed，不进入模型队列，不泄漏正文到日志 |
| 附件 | 单附件失败、部分成功、数组最后一个 text block | 复用现有 best-effort；refs 位于最后 text block；普通正文保留 |
| transport | control_request/response、echo、重放、非法 JSON | 原 control 行为不变；合法用户事件去重；非法用户事件不入队 |
| 双入口 | 同一 fixture 分别走 REPL 与 print | 两种入口的 value、UUID、origin、附件与错误语义一致 |
| renderer | 可信 webhook JSON、普通同标签文本、坏 JSON | 仅可信 origin 渲染 webhook；其余不误判 |

## 8. dist 与 live 验收

1. 先执行上述专项测试、`bun run typecheck`、`bun run build`，再运行 `bun dist/main.js --version` 和 `bun dist/main.js --help` 确认产物可启动。
2. 用打包后的 `dist/main.js` 分别驱动 REPL/`-p` Remote Control fixture：普通文本、图片消息在 webhook feature 开启时仍入队；伪造标签按普通消息处理；非法 webhook 不触发模型请求。source 单测不能替代此验收。
3. 在两个获授权的 Sessions 环境中验证：普通远程文本和带附件消息到达一次；可信 webhook producer 写入结构化来源后，REPL 与 print 均能显示并处理一次；重放 delivery UUID 不重复执行。
4. live 必须同时验证普通客户端不能通过 `POST /events` 自报 `source.kind=github_webhook`，且旧伪造标签正文不会获得 webhook UI。缺少可信 producer 或服务端未部署字段时标记 `live skipped/blocked`，不得声称 webhook 已兼容或已上线。
