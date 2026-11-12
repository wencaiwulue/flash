---
id: sessions-share
batch: 3
title: Session Sharing 会话导出、共享与恢复设计
date: 2026-11-12
status: draft
---

# Session Sharing 会话导出、共享与恢复设计

## 1. 概述

Claude Code 提供**多层级会话导出与共享机制**，支持从简单只读导出到完整可恢复会话的多种场景：

| 机制 | 格式 | 用途 | 可恢复 | 权限 |
|------|------|------|--------|------|
| `/share` | 静态 HTML | 只读存档/分享 | ❌ | 本地仅写 |
| `/export` | 纯文本 | 纯文本导出 | ❌ | 本地仅写 |
| `ccshare` | JSONL | 远程会话恢复 | ✅ | HTTPS 下载 |

### 非目标

本设计不包含：
- 实时协作编辑
- 云端会话同步（见 Teleport）
- 加密分享
- 访问控制列表

---

## 2. 导出格式

### 2.1 `/share` HTML 格式

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code conversation</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;background:#f7f7f5;color:#20201e}
h1{font-size:1.5rem}.message{background:white;border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}h2{font-size:.85rem;text-transform:uppercase;color:#666}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,monospace;margin:0}
</style>
</head>
<body>
<h1>Claude Code conversation</h1>
<section class="message user"><h2>User</h2><pre>...</pre></section>
<section class="message assistant"><h2>Claude</h2><pre>...</pre></section>
</body>
</html>
```

#### 设计决策：HTML 是纯静态且自包含的

- **原因**：无需外部资源，单文件即可完整查看
- **代价**：无交互回放能力
- **证据**：`shareHtml.ts` 中 CSS 内联在 `<style>` 标签内

#### 设计决策：工具输出默认不包含

- **原因**：工具输出可能包含敏感数据（密码、密钥、文件内容）
- **备选**：
  - 默认包含但提示审查
  - 完全禁止工具输出
- **证据**：`ShareDialog.tsx` 中 `includeToolOutput` 默认 `false`

### 2.2 `/export` 纯文本格式

基于完整 React 渲染管线输出的纯文本，保留 ANSI 转义序列可选：

```typescript
export async function renderMessagesToPlainText(
  messages: Message[],
  tools: Tools = [],
  columns?: number,
): Promise<string> {
  const parts: string[] = []
  await streamRenderedMessages(
    messages,
    tools,
    chunk => void parts.push(stripAnsi(chunk)),
    { columns },
  )
  return parts.join('')
}
```

#### 设计决策：复用同一渲染管线

- **原因**：保证导出格式与 UI 所见一致
- **代价**：需要完整 React 上下文来渲染
- **证据**：`exportRenderer.tsx` 使用 `renderToAnsiString` + `Messages` 组件

#### 设计决策：分块渲染降低内存峰值

- **原因**：长会话完整渲染可能导致 OOM
- **备选**：单块全量渲染（更简单但更吃内存）
- **证据**：`streamRenderedMessages` 中 `chunkSize = 40`

### 2.3 `ccshare` JSONL 格式

完整会话转录，每行一条 JSON 记录：

```json
{"type":"user","uuid":"...","parentUuid":null,"timestamp":"2026-01-02T03:04:05.000Z","sessionId":"...","cwd":"/untrusted/path","userType":"external","version":"1.0.0","message":{"role":"user","content":"..."}}
{"type":"assistant","uuid":"...","parentUuid":"...","timestamp":"2026-01-02T03:04:06.000Z","sessionId":"...","cwd":"/untrusted/path","userType":"external","version":"1.0.0","message":{"role":"assistant","content":"..."}}
```

#### 设计决策：ccshare 不执行远程 hook 或命令

- **原因**：远程转录是不受信任的数据
- **证据**：`loadCcshare` 返回时 `projectPath: undefined`

---

## 3. 上传与链接

### 3.1 `/share` 本地仅写模型

```typescript
export function resolveShareOutputPath(filename: string, cwd = getCwd()): string {
  const requested = filename.trim()
  if (!requested || requested.includes('\0')) {
    throw new Error('Provide a non-empty output filename ending in .html.')
  }
  if (!requested.toLowerCase().endsWith('.html')) {
    throw new Error('The output filename must end in .html.')
  }
  if (isAbsolute(requested)) {
    throw new Error('Use a relative output path inside the current working directory.')
  }
  const destination = resolve(cwd, requested)
  const fromCwd = relative(cwd, destination)
  if (fromCwd === '..' || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd)) {
    throw new Error('The output path must stay inside the current working directory.')
  }

  const realCwd = realpathSync(cwd)
  const realParent = realpathSync(dirname(destination))
  const realFromCwd = relative(realCwd, realParent)
  if (
    realFromCwd === '..' ||
    realFromCwd.startsWith(`..${sep}`) ||
    isAbsolute(realFromCwd)
  ) {
    throw new Error('The output path must not escape through a symbolic link.')
  }
  return destination
}

export async function writeSharedHtml(
  destination: string,
  html: string,
): Promise<void> {
  await writeFile(destination, html, { encoding: 'utf8', flag: 'wx' })
}
```

#### 设计决策：双重路径检查防止逃逸

- **原因**：防止通过 `../` 或符号链接写入工作区外
- **检查层级**：
  1. 词法检查（不允许 `..` 开头）
  2. 真实路径检查（解析符号链接后仍在工作区内）
- **证据**：`resolveShareOutputPath` 的两层检查

#### 设计决策：永不覆盖现有文件

- **原因**：防止意外覆盖用户重要文件
- **备选**：自动追加编号（`file (1).html`）
- **代价**：用户必须手动选择唯一文件名
- **证据**：`writeFile` 使用 `flag: 'wx'`

#### 设计决策：不自动创建目录

- **原因**：防止意外创建深层目录树
- **证据**：`writeSharedHtml` 不调用 `mkdir`

### 3.2 `ccshare` 下载与链接解析

```typescript
const DEFAULT_ORIGIN = 'https://go'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_LINES = 20_000
const MAX_REDIRECTS = 5
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function parseCcshareId(value: string): string | null {
  let url: URL
  let origin: URL
  try {
    url = new URL(value)
    origin = configuredOrigin()
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== origin.origin
  ) {
    return null
  }
  const match = /^\/ccshare\/([A-Za-z0-9._-]+)\/?$/.exec(url.path)
  return validId(match?.[1]) ? match?.[1] : null
}
```

#### 设计决策：仅 HTTPS，无查询参数或片段

- **原因**：防止通过 HTTP 明文传输或查询参数注入
- **证据**：`parseCcshareId` 检查 `protocol === 'https:'` 且无 `search`/`hash`

#### 设计决策：可配置原点，默认 `https://go`

- **原因**：企业部署可自定义
- **配置**：环境变量 `CLAUDE_CODE_CCSHARE_ORIGIN`
- **证据**：`configuredOrigin()` 读取环境变量

---

## 4. 敏感信息处理

### 4.1 HTML 转义

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

#### 设计决策：全面 HTML 实体转义

- **原因**：防止 XSS 攻击
- **覆盖字符**：`&`, `<`, `>`, `"`, `'`
- **证据**：`shareHtml.ts` 的 `escapeHtml` 函数

### 4.2 工具输出选择加入

```typescript
function getSharePreview(messages: Message[]): string {
  const preview = messages
    .map(message => messageText(message, false)) // 默认 exclude
    .filter(Boolean)
    .join('\n\n')
  return preview.length > 4000 ? `${preview.slice(0, 4000)}\n…` : preview
}
```

#### 设计决策：预览始终隐藏工具输出

- **原因**：预览在用户选择前展示，必须安全
- **证据**：`getSharePreview` 调用 `messageText(..., false)`

### 4.3 UI 显式提示

```typescript
<Text color="warning">
  Privacy: this conversation may contain secrets or other sensitive
  data. Review the preview; automatic redaction is not guaranteed.
</Text>
```

#### 设计决策：明确提示而非自动审查

- **原因**：自动审查难以覆盖所有敏感模式，反而给用户虚假安全感
- **备选**：正则匹配常见密钥模式
- **代价**：用户必须手动审查
- **证据**：`ShareDialog.tsx` 中的警告文本

### 4.4 ccshare 凭证安全

```typescript
async function readCredential(): Promise<string | undefined> {
  const path =
    process.env.CLAUDE_CODE_CCSHARE_TOKEN_FILE ||
    join(getClaudeConfigHomeDir(), 'ccshare-credentials.json')
  let info
  try {
    info = await lstat(path)
  } catch {
    return undefined
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('The ccshare credential must be a regular, non-symlink file.')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('The ccshare credential file must have mode 0600.')
  }
  if (info.size > 4096) throw new Error('The ccshare credential file is too large.')
  const raw = await readFile(path, 'utf8')
  let token: unknown
  try {
    token = (JSON.parse(raw) as { token?: unknown }).token
  } catch {
    throw new Error('The ccshare credential file is not valid JSON.')
  }
  if (token !== undefined && (typeof token !== 'string' || !token.trim())) {
    throw new Error('The ccshare credential token must be a non-empty string.')
  }
  return typeof token === 'string' ? token.trim() : undefined
}
```

#### 设计决策：凭证文件权限严格验证

- **要求**：
  - 必须是常规文件（非符号链接）
  - 权限必须是 `0600`（仅所有者可读写）
  - 大小不超过 4KB
- **证据**：`readCredential()` 中的多重检查

---

## 5. 恢复与兼容

### 5.1 ccshare 下载流程

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│ parseCcshareId │ ──▶ │ fetchTranscript │ ──▶ │ writeBounded │
│               │     │                 │     │   Response   │
└─────────────┘     └─────────────────┘     └──────┬───────┘
                                                  │
                                                  ▼
                              ┌───────────────────┐
                              │ loadTranscript    │
                              │ FromFile          │
                              └───────────────────┘
```

```typescript
export async function loadCcshare(
  id: string,
  options: CcshareLoadOptions = {},
): Promise<LogOption> {
  if (!validId(id)) throw new Error('Invalid ccshare id.')
  const directory = join(getClaudeConfigHomeDir(), 'tmp')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('ccshare temporary directory must be a real directory.')
  }
  const download = await fetchTranscript(id, options)
  const path = join(directory, `ccshare-${randomBytes(16).toString('hex')}.jsonl`)
  try {
    await writeBoundedResponse(
      download.response,
      path,
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      options.maxLines ?? DEFAULT_MAX_LINES,
    )
    const log = await loadTranscriptFromFile(path)
    return { ...log, projectPath: undefined }
  } catch (error) {
    await unlink(path).catch(() => {})
    if (download.signal.aborted) throw new Error('ccshare download timed out.')
    throw error
  } finally {
    download.cleanup()
    await discardResponse(download.response)
  }
}
```

#### 设计决策：临时文件仅用于中转，成功后由调用方清理

- **证据**：`loadCcshare` 返回 `LogOption`，调用方可通过 `log.fullPath` 删除

#### 设计决策：projectPath 始终设为 undefined

- **原因**：远程路径与本地不匹配，且可能包含敏感信息
- **证据**：`return { ...log, projectPath: undefined }`

### 5.2 重定向处理

```typescript
async function fetchTranscript(
  id: string,
  options: CcshareLoadOptions,
): Promise<{ response: Response; signal: AbortSignal; cleanup: () => void }> {
  const origin = configuredOrigin()
  let current = new URL(`/ccshare/${encodeURIComponent(id)}`, origin)
  const token = await readCredential()
  let sendAuthorization = Boolean(token)
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid ccshare timeout.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let completed = false
  try {
    for (let redirects = 0; ; redirects++) {
      if (redirects > MAX_REDIRECTS) throw new Error('Too many ccshare redirects.')
      let response: Response
      try {
        response = await fetch(current, {
          method: 'GET',
          headers: {
            Accept: 'application/x-ndjson, application/jsonl',
            ...(sendAuthorization && token ? { Authorization: `Bearer ${token}` } : {}),
          },
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw new Error('ccshare download timed out.')
        throw error
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) {
          await discardResponse(response)
          throw new Error('ccshare redirect has no Location header.')
        }
        const next = new URL(location, current)
        await discardResponse(response)
        if (next.protocol !== 'https:' || next.username || next.password) {
          throw new Error('ccshare redirects must use HTTPS without userinfo.')
        }
        if (next.origin !== current.origin) {
          const confirm = options.confirmCrossOrigin ?? defaultCrossOriginConfirmation
          if (!(await confirm(current, next))) {
            throw new Error('Cross-origin ccshare redirect was not confirmed.')
          }
          sendAuthorization = false
        }
        current = next
        continue
      }
      if (!response.ok) {
        await discardResponse(response)
        throw new Error(`ccshare download failed with HTTP ${response.status}.`)
      }
      if (!contentTypeIsJsonl(response)) {
        await discardResponse(response)
        throw new Error('ccshare response must have a JSONL content type.')
      }
      completed = true
      return {
        response,
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
      }
    }
  } finally {
    if (!completed) clearTimeout(timer)
  }
}
```

#### 设计决策：手动处理重定向而非依赖 fetch 自动跟随

- **原因**：需要精确控制 Authorization 头在跨原点时不发送
- **证据**：`redirect: 'manual'` 及重定向逻辑中 `sendAuthorization = false`

#### 设计决策：跨原点重定向需要用户确认

- **原因**：防止凭证意外发送到不受信任的服务器
- **确认回调**：`confirmCrossOrigin(from, to): Promise<boolean>`
- **证据**：重定向处理中的确认逻辑

### 5.3 边界限制

```typescript
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024  // 10MB
const DEFAULT_MAX_LINES = 20_000
const MAX_REDIRECTS = 5

async function writeBoundedResponse(
  response: Response,
  path: string,
  maxBytes: number,
  maxLines: number,
): Promise<void> {
  if (!response.body) throw new Error('ccshare response has no body.')
  const handle = await open(path, 'wx', 0o600)
  let bytes = 0
  let lines = 0
  try {
    for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value)
      bytes += chunk.length
      if (bytes > maxBytes) throw new Error(`ccshare transcript exceeds ${maxBytes} bytes.`)
      for (const byte of chunk) if (byte === 10) lines++
      if (lines > maxLines) throw new Error(`ccshare transcript exceeds ${maxLines} lines.`)
      await handle.write(chunk)
    }
    if (bytes > 0 && lines >= maxLines) {
      const tail = Buffer.alloc(1)
      const { bytesRead } = await handle.read(tail, 0, 1, bytes - 1)
      if (bytesRead === 1 && tail[0] !== 10) lines++
      if (lines > maxLines) throw new Error(`ccshare transcript exceeds ${maxLines} lines.`)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}
```

#### 设计决策：双重限制（字节 + 行数）

- **原因**：
  - 字节限制防止超大文件
  - 行数限制防止超多小记录
- **证据**：`writeBoundedResponse` 同时检查两者

#### 设计决策：超时默认 15 秒

- **原因**：平衡用户体验与慢速网络
- **可配置**：`timeoutMs` 选项
- **证据**：`DEFAULT_TIMEOUT_MS = 15_000`

---

## 6. 失败语义

### 6.1 `/share` 失败模式

| 失败 | 原因 | 用户可见消息 |
|------|------|-------------|
| 文件已存在 | `EEXIST` | "That file already exists. Choose a new filename; existing files are never overwritten." |
| 路径逃逸 | `../` 或符号链接 | "The output path must stay inside the current working directory." |
| 非 .html | 扩展名错误 | "The output filename must end in .html." |
| 空文件名 | 空字符串 | "Provide a non-empty output filename ending in .html." |

### 6.2 ccshare 失败模式

| 失败 | 原因 | 异常消息 |
|------|------|---------|
| 无效 ID | 格式不匹配 | "Invalid ccshare id." |
| HTTP 错误 | 非 2xx | "ccshare download failed with HTTP ${status}." |
| 非 JSONL | Content-Type 错误 | "ccshare response must have a JSONL content type." |
| 超时 | 网络慢或服务器慢 | "ccshare download timed out." |
| 超过字节限制 | 文件太大 | "ccshare transcript exceeds ${maxBytes} bytes." |
| 超过行数限制 | 记录太多 | "ccshare transcript exceeds ${maxLines} lines." |
| 太多重定向 | > 5 | "Too many ccshare redirects." |
| 跨原点拒绝 | 用户不确认 | "Cross-origin ccshare redirect was not confirmed." |
| 凭证错误 | 权限或格式 | 参见凭证安全章节 |

#### 设计决策：网络错误不重试

- **原因**：ccshare 是用户主动操作，失败后用户可重试
- **备选**：指数退避重试
- **代价**：用户等待时间更长
- **证据**：`fetchTranscript` 无重试逻辑

#### 设计决策：失败时清理临时文件

- **原因**：防止残留敏感数据
- **证据**：`loadCcshare` catch 块中 `await unlink(path).catch(() => {})`

---

## 7. 设计决策总结

| ID | 决策 | 备选 | 代价 | 证据 |
|----|------|------|------|------|
| D1 | HTML 纯静态自包含 | 需要外部资源 | 无交互能力 | `shareHtml.ts` 内联 CSS |
| D2 | 工具输出默认排除 | 默认包含 | 减少信息量 | `ShareDialog.tsx` 中 `includeToolOutput = false` |
| D3 | 同一渲染管线导出 | 独立简单导出 | 需要完整 React 上下文 | `exportRenderer.tsx` 复用 `Messages` |
| D4 | 分块渲染降低内存 | 单块渲染 | 代码更复杂 | `chunkSize = 40` |
| D5 | 双重路径检查 | 仅词法检查 | 稍慢但更安全 | `resolveShareOutputPath` 两层检查 |
| D6 | 永不覆盖 | 自动编号 | 用户需手动选名 | `flag: 'wx'` |
| D7 | 仅 HTTPS 下载 | 允许 HTTP | 降低灵活性 | `parseCcshareId` 协议检查 |
| D8 | 凭证权限 0600 | 宽松权限 | 配置更严格 | `readCredential` mode 检查 |
| D9 | 手动处理重定向 | 自动跟随 | 代码更复杂 | `redirect: 'manual'` |
| D10 | 跨原点不发送凭证 | 始终发送 | 更安全但限制多 | 重定向中 `sendAuthorization = false` |
| D11 | 双重边界限制 | 仅字节或仅行数 | 稍复杂 | 字节 + 行数同时检查 |
| D12 | projectPath undefined | 保留远程路径 | 无本地路径 | `loadCcshare` 返回值 |
| D13 | 不执行远程 hook | 尝试执行 | 更安全 | `loadTranscriptFromFile` 不执行 hook |
| D14 | 显式隐私提示 | 自动审查 | 用户需手动检查 | `ShareDialog.tsx` 警告文本 |
| D15 | 预览始终排除工具 | 预览可选择 | 预览信息少 | `getSharePreview(..., false)` |

---

## 8. 覆盖率

见 [Coverage](../../architecture/coverage/sessions-share.yaml)
