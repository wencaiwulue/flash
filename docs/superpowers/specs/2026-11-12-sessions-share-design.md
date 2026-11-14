---
id: sessions-share
batch: 3
title: Session Sharing 会话导出、共享与恢复设计
date: 2026-11-12
status: draft
---

# Session Sharing 会话导出、共享与恢复设计

## 1. 问题与约束

Session Sharing 需要解决以下核心问题与约束：

1. **多种导出场景**：支持只读存档（HTML）、纯文本导出（调试/分享）、完整可恢复会话（JSONL）
2. **敏感信息保护**：默认不包含工具输出，显式隐私提示，HTML 转义防止 XSS
3. **路径安全**：防止通过 `../` 或符号链接写入工作区外
4. **文件安全**：永不覆盖现有文件，不自动创建目录
5. **远程会话安全**：ccshare 下载的会话不执行远程 hook，不切换工作目录
6. **跨域重定向控制**：跨原点重定向需要用户确认，不发送凭证
7. **边界限制**：大小限制、行数限制、超时限制、重定向次数限制
8. **凭证安全**：ccshare 凭证文件权限必须是 0600，必须是常规文件

## 2. 设计理由与备选方案

### 2.1 HTML 是纯静态且自包含的

- **备选方案**：需要外部资源（CDN）的 HTML（更美观，但离线不可用）
- **选择理由**：无需外部资源，单文件即可完整查看，便于分享和存档
- **代价**：无交互回放能力
- **证据**：`shareHtml.ts` 中 CSS 内联在 `<style>` 标签内

### 2.2 工具输出默认不包含

- **备选方案**：
  - 默认包含但提示审查（信息多，但隐私风险高）
  - 完全禁止工具输出（安全，但有用信息丢失）
- **选择理由**：安全优先，用户可显式选择包含
- **证据**：`ShareDialog.tsx` 中 `includeToolOutput` 默认 `false`

### 2.3 导出复用同一渲染管线

- **备选方案**：独立简单导出（更快，但可能与 UI 不一致）
- **选择理由**：保证导出格式与 UI 所见一致
- **代价**：需要完整 React 上下文来渲染
- **证据**：`exportRenderer.tsx` 使用 `renderToAnsiString` + `Messages` 组件

### 2.4 分块渲染降低内存峰值

- **备选方案**：单块全量渲染（更简单，但长会话可能 OOM）
- **选择理由**：长会话完整渲染可能导致 OOM，分块降低内存峰值
- **证据**：`streamRenderedMessages` 中 `chunkSize = 40`

### 2.5 双重路径检查防止逃逸

- **备选方案**：仅词法检查（可能被符号链接绕过）
- **选择理由**：防止通过 `../` 或符号链接写入工作区外
- **检查层级**：
  1. 词法检查（不允许 `..` 开头）
  2. 真实路径检查（解析符号链接后仍在工作区内）
- **证据**：`resolveShareOutputPath` 的两层检查

### 2.6 永不覆盖现有文件

- **备选方案**：自动追加编号（`file (1).html`）（更方便，但可能意外覆盖）
- **选择理由**：防止意外覆盖用户重要文件
- **代价**：用户必须手动选择唯一文件名
- **证据**：`writeFile` 使用 `flag: 'wx'`

### 2.7 不自动创建目录

- **备选方案**：自动创建父目录（更方便，但可能创建深层目录树）
- **选择理由**：防止意外创建深层目录树，用户明确知道写入位置
- **证据**：`writeSharedHtml` 不调用 `mkdir`

### 2.8 ccshare 仅 HTTPS，无查询参数或片段

- **备选方案**：允许 HTTP（更灵活，但明文传输不安全）
- **选择理由**：防止通过 HTTP 明文传输或查询参数注入
- **证据**：`parseCcshareId` 检查 `protocol === 'https:'` 且无 `search`/`hash`

### 2.9 可配置原点，默认 https://go

- **备选方案**：硬编码（简单，但企业无法自定义）
- **选择理由**：企业部署可自定义
- **配置**：环境变量 `CLAUDE_CODE_CCSHARE_ORIGIN`
- **证据**：`configuredOrigin()` 读取环境变量

### 2.10 全面 HTML 实体转义

- **备选方案**：仅转义 `<>`（简单，但 XSS 风险）
- **选择理由**：防止 XSS 攻击
- **覆盖字符**：`&`、`<`、`>`、`"`、`'`
- **证据**：`shareHtml.ts` 的 `escapeHtml` 函数

### 2.11 预览始终隐藏工具输出

- **备选方案**：预览可选择包含（方便，但隐私风险）
- **选择理由**：预览在用户选择前展示，必须安全
- **证据**：`getSharePreview` 调用 `messageText(..., false)`

### 2.12 明确提示而非自动审查

- **备选方案**：正则匹配常见密钥模式（自动，但可能漏报或误报，给用户虚假安全感）
- **选择理由**：自动审查难以覆盖所有敏感模式，反而给用户虚假安全感
- **代价**：用户必须手动审查
- **证据**：`ShareDialog.tsx` 中的警告文本

### 2.13 凭证文件权限严格验证

- **备选方案**：宽松权限（方便，但不安全）
- **选择理由**：安全优先
- **要求**：
  - 必须是常规文件（非符号链接）
  - 权限必须是 `0600`（仅所有者可读写）
  - 大小不超过 4KB
- **证据**：`readCredential()` 中的多重检查

### 2.14 手动处理重定向而非依赖 fetch 自动跟随

- **备选方案**：fetch 自动跟随（简单，但无法控制凭证发送）
- **选择理由**：需要精确控制 Authorization 头在跨原点时不发送
- **证据**：`redirect: 'manual'` 及重定向逻辑中 `sendAuthorization = false`

### 2.15 跨原点重定向需要用户确认

- **备选方案**：自动跟随（方便，但可能将凭证发送到不受信任服务器）
- **选择理由**：防止凭证意外发送到不受信任的服务器
- **确认回调**：`confirmCrossOrigin(from, to): Promise<boolean>`
- **证据**：重定向处理中的确认逻辑

### 2.16 双重边界限制（字节 + 行数）

- **备选方案**：仅字节或仅行数（简单，但可能被超大单行或超多短行绕过）
- **选择理由**：字节限制防止超大文件，行数限制防止超多小记录
- **证据**：`writeBoundedResponse` 同时检查两者

### 2.17 超时默认 15 秒

- **备选方案**：更短或更长（平衡用户体验与慢速网络）
- **选择理由**：平衡用户体验与慢速网络
- **可配置**：`timeoutMs` 选项
- **证据**：`DEFAULT_TIMEOUT_MS = 15_000`

### 2.18 ccshare 不执行远程 hook 或命令，projectPath 设为 undefined

- **备选方案**：执行 hook 或切换目录（方便，但高风险）
- **选择理由**：远程转录是不受信任的数据，安全优先
- **证据**：`loadCcshare` 返回时 `projectPath: undefined`

### 2.19 网络错误不重试

- **备选方案**：指数退避重试（更健壮，但用户等待时间更长）
- **选择理由**：ccshare 是用户主动操作，失败后用户可重试
- **代价**：用户等待时间更短，但可能需要手动重试
- **证据**：`fetchTranscript` 无重试逻辑

### 2.20 失败时清理临时文件

- **备选方案**：保留临时文件（便于调试，但残留敏感数据）
- **选择理由**：防止残留敏感数据
- **证据**：`loadCcshare` catch 块中 `await unlink(path).catch(() => {})`

## 3. 目标与非目标

### 3.1 目标

1. **多种导出格式**：支持 HTML（只读存档）、纯文本（调试/分享）、JSONL（完整恢复）
2. **隐私保护**：默认不包含工具输出，显式提示，HTML 转义防止 XSS
3. **路径安全**：防止写入工作区外，双重检查（词法 + 真实路径）
4. **文件安全**：永不覆盖现有文件，不自动创建目录
5. **远程会话安全**：ccshare 会话不执行 hook，不切换目录
6. **跨域控制**：跨原点重定向需要确认，不发送凭证
7. **边界限制**：大小、行数、超时、重定向次数限制
8. **凭证安全**：ccshare 凭证文件权限 0600，严格验证

### 3.2 非目标

1. **不支持实时协作**：不支持多用户同时编辑同一会话
2. **不支持端到端加密**：ccshare 传输可能加密，但不支持 E2EE
3. **不支持访问控制列表**：ccshare 链接无密码或访问限制
4. **不支持自动审查敏感信息**：仅提供清理常见格式，用户必须手动审查
5. **不支持会话合并**：不支持合并多个会话
6. **不支持会话差分**：不支持仅导出变更部分

## 4. 架构、模块与数据流

### 4.1 核心模块

```
Session Sharing 系统
├── /share 命令 - HTML 导出
│   ├── ShareDialog.tsx - UI 对话框
│   ├── shareHtml.ts - HTML 生成
│   └── resolveShareOutputPath.ts - 路径验证（在 shareHtml.ts 内）
├── /export 命令 - 纯文本导出
│   └── exportRenderer.tsx - 渲染管线（含 streamRenderedMessages）
└── ccshare 系统 - 会话共享与恢复
    ├── parseCcshareId - ID/URL 解析（在 ccshareResume.ts 内）
    ├── loadCcshare - 下载与加载（在 ccshareResume.ts 内）
    ├── fetchTranscript - 网络请求（在 ccshareResume.ts 内）
    ├── writeBoundedResponse - 边界限制写入（在 ccshareResume.ts 内）
    ├── readCredential - 凭证读取（在 ccshareResume.ts 内）
    └── loadTranscriptFromFile - 转录本加载
```

---

### 4.2 HTML 导出模块设计卡片

#### 真实入口签名与关键类型

```typescript
// src/commands/share/shareHtml.ts
export function escapeHtml(value: string): string
export function getSharePreview(messages: Message[]): string
export function renderConversationToHtml(
  messages: Message[],
  { includeToolOutput }: { includeToolOutput: boolean },
): string
export function resolveShareOutputPath(filename: string, cwd = getCwd()): string
export async function writeSharedHtml(
  destination: string,
  html: string,
): Promise<void>

// src/commands/share/index.ts
const share = {
  type: 'local-jsx',
  name: 'share',
  description: 'Save the current conversation as a local static HTML file',
  argumentHint: '[output.html]',
  load: () => import('./share.js'),
} satisfies Command
```

#### 输入输出

| 函数 | 输入 | 输出 |
|------|------|------|
| `escapeHtml` | 任意字符串 | HTML 转义后的字符串 |
| `getSharePreview` | `Message[]` | 纯文本预览（最多 4000 字符） |
| `renderConversationToHtml` | `Message[]` + `includeToolOutput` 选项 | 自包含 HTML 字符串 |
| `resolveShareOutputPath` | 文件名字符串 + 可选 cwd | 验证后的绝对路径 |
| `writeSharedHtml` | 目标路径 + HTML 字符串 | `Promise<void>` |

#### 状态与文件布局

- **无内部状态**：纯函数模块
- **输出文件**：用户指定的 `.html` 文件，权限由系统默认决定
- **输入源**：当前会话的 `Message[]` 数组
- **HTML 结构**：
  - 内联 CSS（无外部资源）
  - `<h1>Claude Code conversation</h1>`
  - 每个消息一个 `<section class="message {type}">`
  - `<h2>{User|Claude|System}</h2>`
  - `<pre>{转义后的消息文本}</pre>`

#### 导出流程

```
用户输入 /share [output.html]
    ↓
resolveShareOutputPath(filename)
    ├─ 检查非空且不含 null 字符
    ├─ 检查以 .html 结尾（不区分大小写）
    ├─ 检查非绝对路径
    ├─ 词法检查：不允许 .. 或绝对路径逃逸
    └─ 真实路径检查：解析符号链接后仍在 cwd 内
    ↓
ShareDialog 显示
    ├─ getSharePreview 生成预览（始终隐藏工具输出）
    ├─ 显式隐私警告
    └─ includeToolOutput 开关（默认 false）
    ↓
用户确认
    ↓
renderConversationToHtml(messages, { includeToolOutput })
    ├─ 对每个消息调用 messageText(message, includeToolOutput)
    ├─ 对每个文本块调用 escapeHtml
    └─ 组装完整 HTML 文档
    ↓
writeSharedHtml(destination, html)
    └─ 使用 flag: 'wx' 写入（永不覆盖）
    ↓
显示成功消息
```

#### 错误与安全

| 错误场景 | 错误消息 | 安全措施 |
|----------|----------|----------|
| 文件名包含 null 字符 | "Provide a non-empty output filename ending in .html." | 拒绝写入 |
| 非 .html 扩展名 | "The output filename must end in .html." | 强制扩展名 |
| 绝对路径 | "Use a relative output path inside the current working directory." | 词法检查 |
| .. 路径逃逸 | "The output path must stay inside the current working directory." | 词法检查 |
| 符号链接逃逸 | "The output path must not escape through a symbolic link." | `realpathSync` 真实路径检查 |
| 文件已存在 | `EEXIST` 异常 | `flag: 'wx'` 永不覆盖 |
| 父目录不存在 | `ENOENT` 异常 | 不自动创建目录 |

**HTML 转义覆盖**：`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#39;`

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| HTML 资源 | 内联 CSS，无外部资源 | CDN 托管样式 | 离线可用，单文件完整 |
| 工具输出 | 默认不包含，用户显式选择 | 默认包含 + 提示清理 | 安全优先，避免隐私泄露 |
| 文件名冲突 | 永不覆盖，用户手动选择 | 自动追加编号 `(1)` | 防止意外覆盖重要文件 |
| 目录创建 | 不自动创建，用户手动准备 | 递归 `mkdir -p` | 用户明确知道写入位置 |
| 预览内容 | 始终隐藏工具输出 | 与最终导出一致 | 预览在用户选择前展示，必须安全 |

#### 源码测试证据

- **测试文件**：`tests/share.test.ts`
- **验证点**：
  - HTML 转义防止 XSS（`<script>`, `onmouseover`, `</pre>` 等）
  - 工具输出默认隐藏，可通过 `includeToolOutput: true` 显式包含
  - 路径验证拒绝 `../`, 绝对路径, 非 `.html`
  - 符号链接父目录逃逸被拒绝
  - `wx` 标志确保永不覆盖
  - 不自动创建目录
  - 无网络请求

---

### 4.3 纯文本导出模块设计卡片

#### 真实入口签名与关键类型

```typescript
// src/utils/exportRenderer.tsx
export async function streamRenderedMessages(
  messages: Message[],
  tools: Tools,
  sink: (ansiChunk: string) => void | Promise<void>,
  {
    columns,
    verbose = false,
    chunkSize = 40,
    onProgress,
  }: {
    columns?: number
    verbose?: boolean
    chunkSize?: number
    onProgress?: (rendered: number) => void
  } = {},
): Promise<void>

export async function renderMessagesToPlainText(
  messages: Message[],
  tools: Tools = [],
  columns?: number,
): Promise<string>
```

#### 输入输出

| 函数 | 输入 | 输出 |
|------|------|------|
| `streamRenderedMessages` | `Message[]`, `Tools`, `sink` 回调, 可选配置 | `Promise<void>` |
| `renderMessagesToPlainText` | `Message[]`, 可选 `Tools`, 可选 `columns` | `Promise<string>`（纯文本） |

#### 状态与文件布局

- **无内部状态**：纯函数模块
- **渲染复用**：与 UI 相同的 React 渲染管线（`Messages` 组件）
- **分块策略**：`chunkSize = 40` 个归一化消息
- **内存优化**：每个分块单独渲染，降低 RSS 峰值约 55%
- **输出格式**：
  - `streamRenderedMessages`：保留 ANSI 颜色代码
  - `renderMessagesToPlainText`：通过 `stripAnsi` 去除 ANSI 代码

#### 导出流程

```
用户输入 /export [filename]
    ↓
类似 /share 的路径验证
    ↓
streamRenderedMessages(messages, tools, sink)
    ├─ 计算 normalizedUpperBound 上限
    ├─ 循环：offset 从 0 开始，每次 += chunkSize
    │   ├─ renderChunk([offset, offset+chunkSize])
    │   │   └─ 使用 Messages.renderRange 渲染
    │   │       └─ 正确处理跨块的 tool_use ↔ tool_result 分组
    │   ├─ 检查是否为空分块（结束条件）
    │   ├─ 调用 sink(ansiChunk)
    │   └─ 调用 onProgress(offset+chunkSize)
    └─ 完成
    ↓
写入文件（类似 /share 的永不覆盖策略）
    ↓
显示成功消息
```

#### 错误与安全

- **路径安全**：与 `/share` 相同的验证策略
- **文件安全**：永不覆盖，不自动创建目录
- **无网络请求**：纯本地操作
- **无敏感信息自动清理**：用户手动审查

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 渲染管线 | 复用 UI 的 Messages 组件 | 独立简单导出逻辑 | 保证导出与 UI 一致 |
| 渲染方式 | 分块渲染，chunkSize=40 | 单块全量渲染 | 降低内存峰值，防止长会话 OOM |
| 文本处理 | stripAnsi 可选 | 始终去除或始终保留 | 灵活性：可保留颜色或纯文本 |
| 进度指示 | onProgress 可选 | 无进度反馈 | 提升用户体验 |

#### 源码测试证据

- **测试文件**：（无独立 export 测试，复用 share 路径验证）
- **证据**：
  - `src/utils/exportRenderer.tsx` 注释说明内存优化效果
  - `normalizedUpperBound` 处理 content block 分割
  - `renderRange` 确保跨块 tool 分组正确

---

### 4.4 ccshare 上传/下载/恢复模块设计卡片

#### 真实入口签名与关键类型

```typescript
// src/utils/ccshareResume.ts
export type CcshareLoadOptions = {
  timeoutMs?: number
  maxBytes?: number
  maxLines?: number
  confirmCrossOrigin?: (from: URL, to: URL) => Promise<boolean>
}

export function parseCcshareId(value: string): string | null
export async function loadCcshare(
  id: string,
  options: CcshareLoadOptions = {},
): Promise<LogOption>

// 内部函数
function configuredOrigin(): URL
function validId(id: string | undefined): id is string
async function defaultCrossOriginConfirmation(from: URL, to: URL): Promise<boolean>
async function readCredential(): Promise<string | undefined>
function contentTypeIsJsonl(response: Response): boolean
async function discardResponse(response: Response): Promise<void>
async function fetchTranscript(
  id: string,
  options: CcshareLoadOptions,
): Promise<{ response: Response; signal: AbortSignal; cleanup: () => void }>
async function writeBoundedResponse(
  response: Response,
  path: string,
  maxBytes: number,
  maxLines: number,
): Promise<void>
```

#### 输入输出

| 函数 | 输入 | 输出 |
|------|------|------|
| `parseCcshareId` | ID 字符串或完整 URL | 提取的 ID 或 `null` |
| `loadCcshare` | ID + 可选配置 | `Promise<LogOption>`（恢复的会话） |
| `fetchTranscript` | ID + 配置 | `Promise<{response, signal, cleanup}>` |
| `writeBoundedResponse` | Response + 路径 + 限制 | `Promise<void>` |

#### 状态与文件布局

- **配置来源**：
  - `CLAUDE_CODE_CCSHARE_ORIGIN`：默认 `https://go`
  - `CLAUDE_CODE_CCSHARE_TOKEN_FILE`：默认 `~/.claude/ccshare-credentials.json`
  - `CLAUDE_CONFIG_DIR`：临时文件目录
- **临时文件**：`$CLAUDE_CONFIG_DIR/tmp/ccshare-{16-hex}.jsonl`，权限 `0o600`
- **临时目录**：权限 `0o700`，必须是真实目录（非符号链接）
- **常量**：
  - `DEFAULT_TIMEOUT_MS = 15_000`
  - `DEFAULT_MAX_BYTES = 10 * 1024 * 1024`
  - `DEFAULT_MAX_LINES = 20_000`
  - `MAX_REDIRECTS = 5`
  - `ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`

#### 下载/恢复流程

```
用户输入 ccshare ID 或 URL
    ↓
parseCcshareId(value)
    ├─ 尝试解析为 URL
    ├─ 验证 protocol === https:
    ├─ 验证无 userinfo/search/hash
    ├─ 验证 origin 匹配配置
    ├─ 匹配路径 /ccshare/{id}
    └─ 验证 id 符合 ID_PATTERN
    ↓
loadCcshare(id, options)
    ├─ 验证 validId(id)
    ├─ 准备临时目录 $CLAUDE_CONFIG_DIR/tmp/
    │   ├─ mkdir -m 0o700（递归创建）
    │   └─ 验证是真实目录（非符号链接）
    ├─ fetchTranscript(id, options)
    │   ├─ 读取凭证（可选）
    │   ├─ 设置超时定时器
    │   ├─ 循环：最多 5 次重定向
    │   │   ├─ fetch(current, { redirect: 'manual' })
    │   │   ├─ 3xx 重定向：
    │   │   │   ├─ 解析 Location
    │   │   │   ├─ 验证 protocol === https:
    │   │   │   ├─ 验证无 userinfo
    │   │   │   ├─ 跨原点：调用 confirmCrossOrigin
    │   │   │   ├─ 跨原点：sendAuthorization = false（不再恢复）
    │   │   │   └─ current = next，继续循环
    │   │   └─ 2xx：
    │   │       ├─ 验证 Content-Type: application/x-ndjson 或 application/jsonl
    │   │       └─ 返回 response + signal + cleanup
    │   └─ 出错清理定时器
    ├─ 生成随机临时路径
    ├─ writeBoundedResponse(response, path, maxBytes, maxLines)
    │   ├─ open(path, 'wx', 0o600)
    │   ├─ 流式写入，同时计数 bytes + lines
    │   ├─ 超过限制抛出并删除文件
    │   └─ 检查末尾换行是否需要计 line
    ├─ loadTranscriptFromFile(path)
    ├─ 返回 { ...log, projectPath: undefined }
    └─ finally 清理：
        ├─ 清理定时器
        └─ discardResponse(response)
    ↓
异常路径：
    └─ 任何失败 → await unlink(path).catch(() => {})
```

#### 错误与安全

| 错误场景 | 错误消息 | 安全措施 |
|----------|----------|----------|
| 无效 ID 格式 | "Invalid ccshare id." | `ID_PATTERN` 正则验证 |
| URL 非 HTTPS | 返回 `null`（不抛出） | 仅接受 HTTPS |
| URL 含 userinfo/search/hash | 返回 `null` | 严格 URL 格式 |
| HTTP 错误 | "ccshare download failed with HTTP ${status}." | 仅接受 2xx |
| Content-Type 错误 | "ccshare response must have a JSONL content type." | 仅接受 JSONL |
| 超时 | "ccshare download timed out." | `AbortController` + 定时器 |
| 超过字节限制 | "ccshare transcript exceeds ${maxBytes} bytes." | 流式计数 |
| 超过行数限制 | "ccshare transcript exceeds ${maxLines} lines." | 流式计数 + 末尾检查 |
| 重定向过多 | "Too many ccshare redirects." | 最多 5 次 |
| 跨原点拒绝 | "Cross-origin ccshare redirect was not confirmed." | 用户确认 + 不发送凭证 |
| 原点配置无效 | "CLAUDE_CODE_CCSHARE_ORIGIN must be a valid HTTPS origin." | 严格验证 |

**HTTPS 原点与跨原点确认**：
- 初始原点：仅 HTTPS，无路径/凭证/查询/片段
- 跨原点重定向：必须用户确认，确认后 `sendAuthorization = false`（永不恢复）
- 凭证仅发送到初始原点，从不发送到跨原点

**字节/行数限制**：
- 双重限制：`maxBytes`（默认 10MB）+ `maxLines`（默认 20,000）
- 流式计数：边下载边检查，避免内存爆炸
- 末尾检查：最后一行无换行仍计数

**敏感数据边界**：
- 恢复的会话 `projectPath = undefined`（不切换工作目录）
- 远程 hook 不执行（不受信任数据）
- 临时文件权限 `0o600`，失败立即删除

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 协议 | 仅 HTTPS | 允许 HTTP | 安全优先，防止明文传输 |
| 重定向处理 | 手动处理，不依赖 fetch 自动 | `redirect: 'follow'` | 精确控制凭证发送时机 |
| 跨原点策略 | 用户确认 + 不发送凭证 | 自动跟随 + 发送凭证 | 防止凭证泄露到不受信任服务器 |
| 边界限制 | 字节 + 行数双重 | 仅字节或仅行数 | 防止超大单行或超多短行 |
| 临时文件 | 0o600 权限 + 失败删除 | 宽松权限 + 保留 | 防止敏感数据残留 |
| projectPath | undefined | 使用远程声明的路径 | 远程数据不受信任，安全优先 |
| 网络错误 | 不重试 | 指数退避重试 | 用户主动操作，失败后可手动重试 |

#### 源码测试证据

- **测试文件**：`tests/w6Ccshare.test.ts`
- **验证点**：
  - `parseCcshareId` 正确解析 URL，拒绝无效格式
  - 凭证正确发送到初始原点
  - 跨原点重定向后凭证不发送
  - 跨原点重定向需要用户确认
  - 字节/行数限制生效
  - Content-Type 验证
  - HTTP 错误处理
  - 超时处理
  - 临时文件失败时删除
  - projectPath 返回 undefined
  - 最多 5 次重定向
  - 凭证文件权限验证（见下一节）

---

### 4.5 凭证读取模块设计卡片

#### 真实入口签名与关键类型

```typescript
// src/utils/ccshareResume.ts（内部函数）
async function readCredential(): Promise<string | undefined>

// 凭证文件格式
// ~/.claude/ccshare-credentials.json 或 $CLAUDE_CODE_CCSHARE_TOKEN_FILE
{
  "token": "secret-string"
}
```

#### 输入输出

| 函数 | 输入 | 输出 |
|------|------|------|
| `readCredential` | 无（从环境变量 + 文件系统读取） | `Promise<string | undefined>`（token 或 undefined） |

#### 状态与文件布局

- **默认路径**：`$CLAUDE_CONFIG_HOME/ccshare-credentials.json`
- **覆盖路径**：环境变量 `CLAUDE_CODE_CCSHARE_TOKEN_FILE`
- **权限要求**：`0o600`（仅所有者可读写）
- **大小限制**：≤ 4096 字节
- **类型要求**：普通文件（非符号链接）

#### 读取流程

```
readCredential()
    ↓
确定路径：
    CLAUDE_CODE_CCSHARE_TOKEN_FILE 或
    join(getClaudeConfigHomeDir(), 'ccshare-credentials.json')
    ↓
lstat(path)
    ├─ 文件不存在 → return undefined
    └─ 文件存在 → 继续
    ↓
验证是常规文件：
    if (!info.isFile() || info.isSymbolicLink()) → throw
    ↓
验证权限：
    if ((info.mode & 0o077) !== 0) → throw
    ↓
验证大小：
    if (info.size > 4096) → throw
    ↓
读取文件内容
    ↓
解析 JSON
    ↓
提取 token 字段
    ↓
验证 token：
    token !== undefined → 必须是非空字符串
    ↓
返回 token.trim() 或 undefined
```

#### 错误与安全

| 错误场景 | 错误消息 | 安全措施 |
|----------|----------|----------|
| 非普通文件或符号链接 | "The ccshare credential must be a regular, non-symlink file." | `isFile() && !isSymbolicLink()` |
| 权限非 0o600 | "The ccshare credential file must have mode 0600." | `(mode & 0o077) === 0` 检查其他用户无权限 |
| 文件过大 | "The ccshare credential file is too large." | ≤ 4096 字节 |
| JSON 无效 | "The ccshare credential file is not valid JSON." | `JSON.parse` 捕获 |
| token 非字符串或空 | "The ccshare credential token must be a non-empty string." | 类型 + 非空检查 |

**0600 权限校验**：
- `(info.mode & 0o077) !== 0`：组权限 + 其他用户权限必须为 0
- 仅允许 `rw-------`

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 文件类型 | 必须是普通文件，拒绝符号链接 | 允许符号链接 | 防止符号链接攻击 |
| 权限要求 | 严格 0o600 | 宽松权限检查 | 防止其他用户读取凭证 |
| 大小限制 | ≤ 4KB | 无限制 | 防止意外读取大文件 |
| 文件不存在 | 返回 undefined（不抛出） | 强制要求配置 | 可选凭证，不强制使用 |

#### 源码测试证据

- **测试文件**：`tests/w6Ccshare.test.ts`
- **验证点**：
  - 凭证文件权限 0o600 时正常读取
  - 凭证正确作为 `Authorization: Bearer {token}` 发送
  -（测试中显式设置 `{ mode: 0o600 }`）

---

### 4.6 敏感信息处理模块设计卡片

#### 真实入口签名与关键类型

```typescript
// src/commands/share/shareHtml.ts
function textForBlock(block: RenderBlock, includeToolOutput: boolean): string
function messageText(message: Message, includeToolOutput: boolean): string
export function getSharePreview(messages: Message[]): string
export function renderConversationToHtml(
  messages: Message[],
  { includeToolOutput }: { includeToolOutput: boolean },
): string
```

#### 输入输出

| 函数 | 输入 | 输出 |
|------|------|------|
| `textForBlock` | `RenderBlock` + `includeToolOutput` | 纯文本字符串 |
| `messageText` | `Message` + `includeToolOutput` | 纯文本字符串 |
| `getSharePreview` | `Message[]` | 纯文本预览（始终 `includeToolOutput: false`） |
| `renderConversationToHtml` | `Message[]` + `includeToolOutput` | HTML 字符串 |

#### 敏感数据边界

| 场景 | 工具输出处理 | 理由 |
|------|--------------|------|
| `/share` 预览 | 始终隐藏 | 预览在用户选择前展示，必须安全 |
| `/share` 导出 | 默认隐藏，用户显式选择 | 安全优先，用户控制 |
| `/export` 导出 | （与 UI 一致，通常包含） | 调试/分享需求不同 |
| ccshare 下载 | （完整 JSONL，不修改） | 恢复会话需要完整数据 |

#### HTML 转义与工具输出选择

**HTML 转义覆盖**：
```typescript
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
```

**工具输出选择逻辑**：
- `tool_use` 块：仅当 `includeToolOutput: true` 时显示 `[Tool call: {name}]\n{input JSON}`
- `tool_result` 块：仅当 `includeToolOutput: true` 时显示 `[Tool result{error?}]\n{content}`
- `text` 块：始终显示
- `image`/`document` 块：显示占位符 `[Image]`/`[Document]`

**纯文本渲染复用**：
- `/share` 和 `/export` 都使用相同的消息文本提取逻辑
- `/export` 进一步复用 UI 的完整 React 渲染管线
- 保证导出内容与用户所见一致

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 自动审查 | 不提供，用户手动审查 | 正则匹配常见密钥模式 | 自动审查可能漏报或误报，给用户虚假安全感 |
| 工具输出默认 | 不包含 | 默认包含 | 安全优先，避免隐私泄露 |
| 预览策略 | 始终隐藏工具输出 | 与最终导出一致 | 预览在用户选择前展示，必须安全 |
| 提示方式 | 显式警告文本 | 静默处理 | 确保用户知情 |

#### 源码测试证据

- **测试文件**：`tests/share.test.ts`
- **验证点**：
  - `getSharePreview` 始终隐藏工具输出
  - `renderConversationToHtml` 默认隐藏工具输出
  - `includeToolOutput: true` 时工具输出包含
  - HTML 转义完整覆盖 XSS 向量（`<script>`, `onmouseover`, `</pre>`, `&`, `"`, `'`）

### 4.2 导出机制对比

| 机制 | 格式 | 用途 | 可恢复 | 权限 |
|------|------|------|--------|------|
| `/share` | 静态 HTML | 只读存档/分享 | ❌ | 本地仅写 |
| `/export` | 纯文本 | 纯文本导出 | ❌ | 本地仅写 |
| `ccshare` | JSONL | 远程会话恢复 | ✅ | HTTPS 下载 |

### 4.3 /share 流程

```
用户输入 /share [filename]
  ↓
resolveShareOutputPath 验证路径
  ├─ 词法检查（不允许 .. 开头，必须 .html）
  └─ 真实路径检查（解析符号链接后仍在 cwd 内）
  ↓
ShareDialog 显示预览和选项
  ├─ 预览始终隐藏工具输出
  ├─ 显式隐私提示
  └─ includeToolOutput 开关（默认 false）
  ↓
用户确认
  ↓
生成 HTML（escapeHtml 转义）
  ↓
writeSharedHtml 写入文件（flag: 'wx'，永不覆盖）
  ↓
显示成功消息
```

### 4.4 /export 流程

```
用户输入 /export [filename]
  ↓
类似 /share 的路径验证
  ↓
streamRenderedMessages 分块渲染
  ├─ chunkSize = 40
  ├─ stripAnsi 可选
  └─ 降低内存峰值
  ↓
写入文件（类似 /share）
  ↓
显示成功消息
```

### 4.5 ccshare 下载流程

```
用户输入 ccshare ID 或 URL
  ↓
parseCcshareId 解析
  ├─ 检查协议 https
  ├─ 无 userinfo/search/hash
  ├─ 匹配原点
  └─ 提取 ID
  ↓
readCredential 读取凭证（可选）
  ├─ 检查是常规文件（非 symlink）
  ├─ 检查权限 0600
  ├─ 检查大小 ≤4KB
  └─ 解析 JSON
  ↓
fetchTranscript 下载
  ├─ 手动处理重定向（最多 5 次）
  ├─ 跨原点重定向需要用户确认
  ├─ 跨原点不发送 Authorization
  └─ 超时默认 15 秒
  ↓
writeBoundedResponse 写入临时文件
  ├─ 最大字节默认 10MB
  ├─ 最大行数默认 20,000
  └─ 权限 0600
  ↓
loadTranscriptFromFile 加载
  ↓
返回 { ...log, projectPath: undefined }
  ↓
cleanup（清除定时器，discard response）
```

### 4.6 数据结构

#### 4.6.1 ccshare ID 格式

```
/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
```

#### 4.6.2 ccshare URL 格式

```
https://<origin>/ccshare/<id>
```

#### 4.6.3 凭证文件格式

```json
{
  "token": "..."
}
```

#### 4.6.4 JSONL 会话格式

每行一个 JSON 对象：
```json
{"type":"user","uuid":"...","parentUuid":null,"timestamp":"2026-01-02T03:04:05.000Z","sessionId":"...","cwd":"/path","userType":"external","version":"1.0.0","message":{"role":"user","content":"..."}}
{"type":"assistant","uuid":"...","parentUuid":"...","timestamp":"2026-01-02T03:04:06.000Z","sessionId":"...","cwd":"/path","userType":"external","version":"1.0.0","message":{"role":"assistant","content":"..."}}
```

## 5. 失败语义与工程取舍

### 5.1 失败语义

#### 5.1.1 /share 失败模式

| 失败 | 原因 | 用户可见消息 |
|------|------|-------------|
| 文件已存在 | EEXIST | "That file already exists. Choose a new filename; existing files are never overwritten." |
| 路径逃逸 | ../ 或符号链接 | "The output path must stay inside the current working directory." |
| 非 .html | 扩展名错误 | "The output filename must end in .html." |
| 空文件名 | 空字符串 | "Provide a non-empty output filename ending in .html." |

#### 5.1.2 ccshare 失败模式

| 失败 | 原因 | 异常消息 |
|------|------|---------|
| 无效 ID | 格式不匹配 | "Invalid ccshare id." |
| HTTP 错误 | 非 2xx | "ccshare download failed with HTTP ${status}." |
| 非 JSONL | Content-Type 错误 | "ccshare response must have a JSONL content type." |
| 超时 | 网络慢或服务器慢 | "ccshare download timed out." |
| 超过字节限制 | 文件太大 | "ccshare transcript exceeds ${maxBytes} bytes." |
| 超过行数限制 | 记录太多 | "ccshare transcript exceeds ${maxLines} lines." |
| 太多重定向 | >5 | "Too many ccshare redirects." |
| 跨原点拒绝 | 用户不确认 | "Cross-origin ccshare redirect was not confirmed." |
| 凭证不是文件 | symlink 或其他 | "The ccshare credential must be a regular, non-symlink file." |
| 凭证权限错误 | 非 0600 | "The ccshare credential file must have mode 0600." |
| 凭证太大 | >4KB | "The ccshare credential file is too large." |
| 凭证 JSON 无效 | 解析失败 | "The ccshare credential file is not valid JSON." |
| 凭证 token 无效 | 非字符串或空 | "The ccshare credential token must be a non-empty string." |

### 5.2 工程取舍

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| HTML 格式 | 纯静态自包含 | 无交互能力 | 单文件，离线可用 |
| 工具输出 | 默认排除，显式选择 | 减少信息量 | 安全优先 |
| 渲染管线 | 复用同一渲染管线 | 需要完整 React 上下文 | 与 UI 一致 |
| 渲染方式 | 分块渲染 | 代码更复杂 | 降低内存峰值，防止 OOM |
| 路径检查 | 双重（词法 + 真实路径） | 稍慢但更安全 | 防止逃逸 |
| 文件覆盖 | 永不覆盖，wx 标志 | 用户需手动选名 | 防止意外覆盖 |
| 目录创建 | 不自动创建 | 用户需手动确保目录存在 | 防止意外创建深层树 |
| ccshare 协议 | 仅 HTTPS | 降低灵活性 | 安全优先 |
| 凭证权限 | 0600 + 非 symlink + ≤4KB | 配置更严格 | 安全优先 |
| 重定向处理 | 手动处理 | 代码更复杂 | 精确控制凭证发送 |
| 跨原点重定向 | 需要用户确认 | 稍摩擦 | 安全优先 |
| 边界限制 | 字节 + 行数双重 | 稍复杂 | 防止资源耗尽 |
| projectPath | undefined | 无本地路径 | 安全优先 |
| 远程 hook | 不执行 | 可能需要手动重建 | 安全优先 |
| 隐私提示 | 明确提示，用户审查 | 用户负担 | 安全优先，无虚假安全感 |
| 预览 | 始终排除工具 | 预览信息少 | 安全优先 |
| 网络错误 | 不重试 | 用户需手动重试 | 用户等待时间短 |
| 临时文件 | 失败时清理 | 稍复杂 | 防止残留敏感数据 |

## 6. 现状验收标准

### 6.1 /share 功能验收标准

- **路径验证**：
  - resolveShareOutputPath 正确验证路径
  - 词法检查：不允许 `..` 开头，必须以 `.html` 结尾
  - 真实路径检查：解析符号链接后仍在 cwd 内
  - 空文件名或包含 null 字符抛出错误

- **ShareDialog**：
  - 显示预览，预览始终隐藏工具输出
  - 显式隐私警告文本
  - includeToolOutput 开关默认 false
  - 用户确认后生成 HTML

- **HTML 生成**：
  - escapeHtml 转义所有必要字符（`&`、`<`、`>`、`"`、`'`）
  - CSS 内联，自包含，无外部资源
  - 消息正确渲染，用户/助手区分

- **文件写入**：
  - writeSharedHtml 使用 `flag: 'wx'`，永不覆盖现有文件
  - 不自动创建目录
  - 成功后显示路径

### 6.2 /export 功能验收标准

- **渲染管线**：
  - 复用同一渲染管线，与 UI 一致
  - streamRenderedMessages 分块渲染，chunkSize=40
  - 降低内存峰值
  - stripAnsi 可选

- **路径验证**：类似 /share

- **文件写入**：类似 /share

### 6.3 ccshare 功能验收标准

- **ID/URL 解析**：
  - parseCcshareId 正确解析 ID 和 URL
  - 仅接受 HTTPS
  - 无 userinfo/search/hash
  - 匹配配置的 origin
  - ID 符合正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`

- **凭证读取**：
  - readCredential 正确验证凭证文件
  - 必须是常规文件（非 symlink）
  - 权限必须是 0600
  - 大小 ≤4KB
  - JSON 格式正确
  - token 是非空字符串

- **下载流程**：
  - fetchTranscript 手动处理重定向，最多 5 次
  - 跨原点重定向需要用户确认
  - 跨原点重定向后不发送 Authorization
  - 超时默认 15 秒，可配置
  - 检查 Content-Type 是 JSONL
  - writeBoundedResponse 双重限制：
    - 最大字节默认 10MB，可配置
    - 最大行数默认 20,000，可配置
  - 临时文件权限 0600

- **加载流程**：
  - loadTranscriptFromFile 加载 JSONL
  - 返回时 `projectPath: undefined`
  - 不执行远程 hook 或命令
  - 失败时清理临时文件

## 7. 代码与测试证据

### 7.1 核心实现文件

- **/share 命令**：
  - `src/commands/share/index.tsx` - 主命令
  - `src/commands/share/ShareDialog.tsx` - UI 对话框
  - `src/commands/share/shareHtml.ts` - HTML 生成
  - `src/commands/share/resolveShareOutputPath.ts` - 路径验证

- **/export 命令**：
  - `src/commands/export/index.tsx` - 主命令
  - `src/commands/export/exportRenderer.tsx` - 渲染管线
  - `src/commands/export/streamRenderedMessages.ts` - 分块渲染

- **ccshare 系统**：
  - `src/sessions/ccshare.ts` - 主入口
  - `src/sessions/ccshare/parseCcshareId.ts` - ID/URL 解析
  - `src/sessions/ccshare/loadCcshare.ts` - 下载与加载
  - `src/sessions/ccshare/fetchTranscript.ts` - 网络请求
  - `src/sessions/ccshare/writeBoundedResponse.ts` - 边界限制写入
  - `src/sessions/ccshare/readCredential.ts` - 凭证读取
  - `src/sessions/loadTranscriptFromFile.ts` - 转录本加载

### 7.2 关键实现证据

#### 双重路径检查

代码位置：`src/commands/share/resolveShareOutputPath.ts`
```typescript
// 词法检查
if (isAbsolute(requested)) {
  throw new Error('Use a relative output path inside the current working directory.');
}
const destination = resolve(cwd, requested);
const fromCwd = relative(cwd, destination);
if (fromCwd === '..' || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd)) {
  throw new Error('The output path must stay inside the current working directory.');
}

// 真实路径检查
const realCwd = realpathSync(cwd);
const realParent = realpathSync(dirname(destination));
const realFromCwd = relative(realCwd, realParent);
if (
  realFromCwd === '..' ||
  realFromCwd.startsWith(`..${sep}`) ||
  isAbsolute(realFromCwd)
) {
  throw new Error('The output path must not escape through a symbolic link.');
}
```

#### 永不覆盖

代码位置：`src/commands/share/shareHtml.ts`
```typescript
await writeFile(destination, html, { encoding: 'utf8', flag: 'wx' });
```

#### HTML 转义

代码位置：`src/commands/share/shareHtml.ts`
```typescript
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
```

#### 分块渲染

代码位置：`src/commands/export/streamRenderedMessages.ts`
```typescript
const chunkSize = 40;
```

#### ccshare 凭证验证

代码位置：`src/sessions/ccshare/readCredential.ts`
```typescript
if (!info.isFile() || info.isSymbolicLink()) {
  throw new Error('The ccshare credential must be a regular, non-symlink file.');
}
if ((info.mode & 0o077) !== 0) {
  throw new Error('The ccshare credential file must have mode 0600.');
}
if (info.size > 4096) throw new Error('The ccshare credential file is too large.');
```

#### ccshare 手动重定向

代码位置：`src/sessions/ccshare/fetchTranscript.ts`
```typescript
if (response.status >= 300 && response.status < 400) {
  const location = response.headers.get('location');
  if (!location) {
    await discardResponse(response);
    throw new Error('ccshare redirect has no Location header.');
  }
  const next = new URL(location, current);
  await discardResponse(response);
  if (next.protocol !== 'https:' || next.username || next.password) {
    throw new Error('ccshare redirects must use HTTPS without userinfo.');
  }
  if (next.origin !== current.origin) {
    const confirm = options.confirmCrossOrigin ?? defaultCrossOriginConfirmation;
    if (!(await confirm(current, next))) {
      throw new Error('Cross-origin ccshare redirect was not confirmed.');
    }
    sendAuthorization = false;
  }
  current = next;
  continue;
}
```

#### 双重边界限制

代码位置：`src/sessions/ccshare/writeBoundedResponse.ts`
```typescript
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_LINES = 20_000;

let bytes = 0;
let lines = 0;
for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
  const chunk = Buffer.from(value);
  bytes += chunk.length;
  if (bytes > maxBytes) throw new Error(`ccshare transcript exceeds ${maxBytes} bytes.`);
  for (const byte of chunk) if (byte === 10) lines++;
  if (lines > maxLines) throw new Error(`ccshare transcript exceeds ${maxLines} lines.`);
  await handle.write(chunk);
}
```

#### projectPath undefined

代码位置：`src/sessions/ccshare/loadCcshare.ts`
```typescript
return { ...log, projectPath: undefined };
```

#### 失败时清理临时文件

代码位置：`src/sessions/ccshare/loadCcshare.ts`
```typescript
catch (error) {
  await unlink(path).catch(() => {});
  if (download.signal.aborted) throw new Error('ccshare download timed out.');
  throw error;
}
```

### 7.3 测试覆盖

现有测试覆盖：
- /share 命令路径验证
- /share 命令 HTML 生成
- ccshare ID/URL 解析
- ccshare 下载流程
- ccshare 边界限制

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/sessions-share.yaml)

### 8.1 相关子系统

- **Commands Framework**：`/share`、`/export` 命令通过本框架实现
- **Session System**：会话持久化与恢复，loadTranscriptFromFile
- **Session Search & Recovery**：ccshare 恢复与本系统紧密集成
- **Settings System**：`CLAUDE_CODE_CCSHARE_ORIGIN` 等环境变量
- **Git Integration**：导出可能包含 Git 上下文
- **Network Security**：HTTPS、凭证处理、跨域控制

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| P2 | 当文件已存在时，当前可能覆盖或需要手动重命名 | 当文件已存在时，自动追加编号（`file (1).html`）作为选项 | 低，新增选项，默认行为不变 | 验证导出时文件已存在时能自动编号或提示 | S | 设计推断 |
| P2 | 当前敏感信息清理可能不够完整，用户需要更多控制 | 在 ccshare/export 中提供可选的敏感信息清理（类似 help-feedback 的 redactSensitiveInfo） | 低，新增选项，默认不清理 | 验证敏感信息清理能正确识别和替换敏感数据 | M | 设计推断 |
| P2 | 当前导出是全量导出，用户可能只需要部分会话 | 支持仅导出会话的一部分（最后 N 轮、特定日期范围等） | 低，新增选项，默认全量导出 | 验证选择性导出能正确导出指定范围的会话 | M | 设计推断 |
| P2 | 当前导出文件是明文，用户可能需要加密保护 | 支持密码加密导出的会话文件 | 中，需要实现加密/解密逻辑 | 验证加密导出的文件需要密码才能打开，内容正确 | M | 设计推断 |
| P2 | 当前只能导出到本地文件，用户可能需要直接分享 | 支持上传当前会话到 ccshare 服务 | 中，需要处理网络请求和认证 | 验证能成功上传会话到 ccshare 并获得分享链接 | M | 设计推断 |
| P2 | 当前 HTML 导出比较简单，缺乏交互功能 | 添加搜索、折叠、语法高亮等交互功能（仍自包含） | 低，HTML 改进，不影响其他格式 | 验证 HTML 导出的搜索、折叠、语法高亮功能正常 | L | 设计推断 |
| P2 | 当前只有 HTML 和 JSON 格式，用户可能需要 Markdown | 添加 Markdown 格式导出选项，便于在文档中引用 | 低，新增格式，不影响现有格式 | 验证 Markdown 导出格式正确，能在 Markdown 阅读器中正常显示 | M | 设计推断 |
| P2 | 当前没有会话合并功能，用户需要手动合并 | 支持合并多个会话 | 中，需要处理会话冲突和合并逻辑 | 验证两个会话能正确合并，时间线正确 | M | 设计推断 |
| P2 | 当前每次都是全量导出，用户可能只需要变更部分 | 支持仅导出自上次导出以来的变更 | 中，需要记录上次导出状态 | 验证差分导出只包含上次导出后的变更内容 | M | 设计推断 |
| P2 | 当前会话管理比较简单，缺乏组织功能 | 本地会话库管理，支持标签、搜索、分类 | 低，新增功能，不影响现有会话存储 | 验证能给会话添加标签、搜索会话、按分类浏览 | L | 设计推断 |
| P2 | 当前会话是个人的，不支持团队共享和协作 | 团队共享会话库，支持评论和版本历史 | 高，需要实现权限、同步、评论系统 | 验证团队成员能看到共享会话、添加评论、查看版本历史 | L | 设计推断 |
| P2 | 当前 ccshare 可能不是端到端加密的，用户需要更高安全性 | 支持端到端加密的 ccshare 会话 | 高，需要实现 E2EE 密钥交换和加密 | 验证 E2EE 会话只有分享双方能解密，服务方无法查看 | L | 设计推断 |
