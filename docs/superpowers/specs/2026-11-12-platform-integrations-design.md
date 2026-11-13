---
id: platform-integrations
batch: 6
title: Platform Integrations 桌面、移动与协作平台集成设计
date: 2026-11-12
status: draft
---

# Platform Integrations 桌面、移动与协作平台集成设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要支持跨多个平台的集成，提供一致的用户体验。主要挑战包括：

- 桌面应用集成：CLI 会话无缝迁移到 Claude Desktop
- 移动应用集成：提供 iOS/Android 应用的便捷访问
- 浏览器集成：Claude in Chrome 扩展，支持多种 Chromium 浏览器
- Slack 集成：安装 Slack 应用以增强协作
- 跨平台兼容性：macOS、Windows、Linux、WSL 都需要支持
- 环境检测：正确识别用户环境以提供正确的集成路径
- 错误降级：当集成不可用时提供合理的回退方案
- 不重复造轮子：不复制 auth、bridge、computer use 等模块的功能

关键约束条件：

- Claude Desktop 最低支持版本：1.1.2396+
- 桌面集成只在 macOS 和 Windows x64 上提供 upsell 提示
- Claude in Chrome 仅在非 WSL 环境下完全支持
- 需要安全地与浏览器进行本地通信（Unix sockets / Windows named pipes）

## 2. 设计理由与备选方案

### 决策 1：桌面集成使用 deep link 协议进行会话迁移

实际机制：使用 `claude://resume?session={sessionId}&cwd={cwd}` 协议，开发模式下使用 `claude-dev://` 前缀。

为什么采用：deep link 是各平台通用的标准机制，不需要复杂的 IPC 基础设施。会话存储通过文件系统共享，deep link 只传递会话 ID 和工作目录。

备选方案：
- 直接 IPC 通信（Unix socket / named pipe）：实现复杂，需要处理协议版本兼容性
- 命令行参数传递：不支持无缝迁移已有会话

代价：需要在各平台上实现协议处理器检测和版本检查。

证据：`src/utils/desktopDeepLink.ts:35-41, 168-200`

### 决策 2：桌面安装状态检测采用最佳 effort 策略

实际机制：
- macOS：检查 `/Applications/Claude.app` 是否存在
- Windows：检查注册表 `HKEY_CLASSES_ROOT\claude`
- Linux：检查 `xdg-mime` 中 `claude://` 协议的处理器
- 版本检测失败时直接尝试 handoff（假设版本兼容）

为什么采用：版本检测可能因为权限或非标准安装位置失败，此时不应阻止用户尝试 handoff。

备选方案：
- 严格要求版本检测成功：用户可能无法使用 handoff 功能
- 完全跳过版本检测：可能导致与旧版本 Desktop 的兼容性问题

代价：旧版本可能收到不理解的 deep link，导致错误。

证据：`src/utils/desktopDeepLink.ts:137-162`

### 决策 3：桌面 upsell 采用渐进式提示策略

实际机制：最多显示 3 次，用户可以选择"Never"永久关闭，通过 GrowthBook 动态控制是否启用。

为什么采用：避免过度打扰用户，同时允许产品团队逐步 rollout 功能。

备选方案：
- 每次启动都提示：用户体验差
- 只提示一次：可能被用户意外忽略

代价：需要维护全局配置中的计数和 dismiss 状态。

证据：`src/components/DesktopUpsell/DesktopUpsellStartup.tsx:35-42, 54-62`

### 决策 4：Claude in Chrome 支持多种 Chromium 浏览器

实际机制：定义 `CHROMIUM_BROWSERS` 配置，包括 Chrome、Brave、Arc、Edge、Chromium、Vivaldi、Opera，按优先级检测可用浏览器。

为什么采用：用户可能使用任何主流 Chromium 浏览器，不应限制为 Chrome 独家。

备选方案：
- 只支持 Chrome：排除大量用户
- 让用户手动配置：用户体验差

代价：需要维护各浏览器的路径和配置差异。

证据：`src/utils/claudeInChrome/common.ts:39-216, 345-409`

### 决策 5：浏览器通信采用 Unix socket / Windows named pipe

实际机制：
- Unix：`/tmp/claude-mcp-browser-bridge-{username}/{pid}.sock`
- Windows：`\\.\pipe\claude-mcp-browser-bridge-{username}`

为什么采用：这是最安全的本地通信方式，限制在同一用户内。

备选方案：
- 本地 HTTP 服务器：需要处理端口占用和安全认证
- 文件轮询：延迟高，性能差

代价：需要处理 Unix 和 Windows 的差异。

证据：`src/utils/claudeInChrome/common.ts:474-540`

### 决策 6：Slack 集成采用浏览器打开 Marketplace 页面

实际机制：`/install-slack-app` 命令使用 `openBrowser()` 打开 Slack Marketplace 页面，并记录点击次数。

为什么采用：Slack 应用安装流程需要在 Slack 界面中完成，命令行无法完成完整 OAuth 流程。

备选方案：
- 完整 OAuth 流程实现：复杂，需要维护回调服务器
- 仅显示 URL：用户体验不如直接打开浏览器

代价：依赖浏览器可用性，需要处理打开失败的回退。

证据：`src/commands/install-slack-app/install-slack-app.ts:8-30`

### 决策 7：移动集成使用 QR 码显示应用商店链接

实际机制：预先生成 iOS 和 Android 的 QR 码，用户可以 tab 切换，支持键盘快捷键关闭。

为什么采用：QR 码是从 CLI 到移动设备最便捷的过渡方式。

备选方案：
- 仅显示 URL：用户需要手动输入，体验差
- 通过短信发送链接：需要手机号权限和短信服务

代价：依赖 QR 码库，需要处理生成失败的情况。

证据：`src/commands/mobile/mobile.tsx:25-120`

### 决策 8：Claude Desktop 配置读取支持 macOS 和 WSL

实际机制：
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- WSL：尝试多种路径检测 Windows 配置文件位置

为什么采用：WSL 用户可能在 Windows 侧安装了 Claude Desktop，需要能够跨环境读取配置。

备选方案：
- 仅支持原生平台：WSL 用户无法使用 Desktop MCP 服务器

代价：WSL 路径检测逻辑复杂，需要处理多种情况。

证据：`src/utils/claudeDesktop.ts:13-96`

### 决策 9：Chrome Open CDP 连接采用 Playwright MCP + 持久化 profile

实际机制：用户手动启动专用 Chrome 实例，通过 `--chrome` flag 或 `/chrome` 命令连接，支持重新连接而不关闭浏览器。

为什么采用：安全隔离用户的日常浏览 profile，同时避免每次都重启浏览器。

备选方案：
- 自动启动浏览器：可能与用户现有实例冲突
- 连接用户默认 profile：安全风险高

代价：用户需要手动启动专用 Chrome 实例。

证据：`src/commands/chrome/chrome.tsx:26-135`

## 3. 目标与非目标

### 目标

- 桌面集成：用户可以无缝将 CLI 会话迁移到 Claude Desktop
- 移动访问：提供便捷的 iOS/Android 应用安装引导
- 浏览器集成：支持 Claude in Chrome 扩展与多种 Chromium 浏览器
- Slack 集成：简化 Slack 应用安装流程
- 跨平台：在 macOS、Windows、Linux、WSL 上提供相应的集成
- 优雅降级：当集成不可用时提供清晰的错误提示和回退方案

### 非目标

- 不实现完整的 Slack bot 功能（仅安装引导）
- 不支持非 Chromium 浏览器（Firefox、Safari 等）
- 不实现跨设备剪贴板同步
- 不替换 auth 模块的认证功能
- 不复制 bridge 模块的通信机制
- 不复制 computer use 模块的浏览器控制功能

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

#### 命令入口

| 命令 | 模块 | 功能 |
|------|------|------|
| `/desktop` | `src/commands/desktop/` | 将当前会话迁移到 Claude Desktop |
| `/mobile` | `src/commands/mobile/` | 显示移动应用 QR 码 |
| `/chrome` | `src/commands/chrome/` | Claude in Chrome 控制菜单 |
| `/install-slack-app` | `src/commands/install-slack-app/` | 安装 Slack 应用 |

#### 主要 API

```typescript
// 桌面集成
function getDesktopInstallStatus(): Promise<DesktopInstallStatus>
function openCurrentSessionInDesktop(): Promise<{ success: boolean; error?: string; deepLinkUrl?: string }>
function getClaudeDesktopConfigPath(): Promise<string>
function readClaudeDesktopMcpServers(): Promise<Record<string, McpServerConfig>>

// Claude in Chrome
function detectAvailableBrowser(): Promise<ChromiumBrowser | null>
function openInChrome(url: string): Promise<boolean>
function getSecureSocketPath(): string
function getAllSocketPaths(): string[]

// 浏览器工具
function getOpenChromeLaunchCommand(): string
function getOpenChromeProfileDir(): string
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要职责 | 不承担的职责 |
|------|-----------|---------|------------|
| `desktopDeepLink.ts` | 无（纯函数） | 构建 deep link、检测 Desktop 安装、版本检查、打开 deep link | Desktop 应用内的会话恢复 |
| `claudeDesktop.ts` | 无（纯函数） | 读取 Desktop 配置路径、解析 MCP 服务器配置 | 实际 MCP 服务器连接 |
| `claudeInChrome/common.ts` | `trackedTabIds` Set | 浏览器配置、路径检测、可用浏览器检测、socket 路径管理 | 实际 MCP 服务器实现 |
| `DesktopUpsellStartup.tsx` | React 本地状态、全局配置 | 控制 upsell 提示显示、用户选择处理、seen count 管理 | Desktop 内的实际功能体验 |
| `DesktopHandoff.tsx` | React 本地状态 | handoff 状态机、用户交互、会话 flush、优雅退出 | Desktop 会话恢复逻辑 |
| `MobileQRCode.tsx` | React 本地状态、预生成 QR 码 | QR 码显示、平台切换、键盘处理 | 移动应用内的功能 |
| `ClaudeInChromeMenu.tsx` | React 本地状态 | 显示连接状态、重新连接、切换默认启用 | 浏览器实际控制 |
| `install-slack-app.ts` | 无（纯函数） | 打开 Slack Marketplace、记录点击计数 | Slack 应用内的功能 |

### 4.3 桌面 Deep Link 与会话迁移模块设计卡

#### 真实入口签名与关键类型

```typescript
// src/utils/desktopDeepLink.ts
export type DesktopInstallStatus =
  | { status: 'not-installed' }
  | { status: 'version-too-old'; version: string }
  | { status: 'ready'; version: string }

export async function getDesktopInstallStatus(): Promise<DesktopInstallStatus>
export async function openCurrentSessionInDesktop(): Promise<{
  success: boolean
  error?: string
  deepLinkUrl?: string
}>

// 内部辅助函数
function buildDesktopDeepLink(sessionId: string): string
async function isDesktopInstalled(): Promise<boolean>
async function getDesktopVersion(): Promise<string | null>
async function openDeepLink(deepLinkUrl: string): Promise<boolean>

// 常量
const MIN_DESKTOP_VERSION = '1.1.2396'
```

#### 输入输出

| 函数 | 输入 | 输出 | 失败情形 |
|------|------|------|---------|
| `buildDesktopDeepLink` | `sessionId: string` | `claude://resume?session=...&cwd=...` 或 `claude-dev://`（开发模式） | 无（纯函数） |
| `isDesktopInstalled` | 无 | `boolean` | 无（静默失败返回 false） |
| `getDesktopVersion` | 无 | `string \| null` | 权限不足、非标准安装位置 → `null` |
| `getDesktopInstallStatus` | 无 | `DesktopInstallStatus` | 版本检测失败 → 降级为 `{status: 'ready', version: 'unknown'}` |
| `openDeepLink` | `deepLinkUrl: string` | `boolean` | 平台不支持、命令执行失败 → `false` |
| `openCurrentSessionInDesktop` | 无 | `{success: boolean, error?: string, deepLinkUrl?: string}` | Desktop 未安装、打开失败 → `success: false` 带错误消息 |

#### 状态与配置

- **无本地状态**：所有函数均为纯函数或依赖外部系统状态
- **会话存储共享**：通过文件系统共享会话数据，deep link 仅传递引用
- **开发模式检测**：
  - `NODE_ENV === 'development'`
  - 或执行路径包含 `build-ant`、`build-ant-native`、`build-external`、`build-external-native`
- **协议切换**：开发模式使用 `claude-dev://`，生产模式使用 `claude://`

#### 检测流程

```
isDesktopInstalled()
  ├─ dev mode → true
  ├─ macOS → 检查 /Applications/Claude.app 存在
  ├─ Linux → 检查 xdg-mime query default x-scheme-handler/claude 有输出
  ├─ Windows → 检查 reg query HKEY_CLASSES_ROOT\claude 成功
  └─ 其他平台 → false
```

#### 版本检查流程

```
getDesktopVersion()
  ├─ macOS → defaults read /Applications/Claude.app/Contents/Info.plist CFBundleShortVersionString
  ├─ Windows → 读取 %LOCALAPPDATA%\AnthropicClaude 下 app-* 目录，取最高版本
  └─ 其他平台 → null

getDesktopInstallStatus()
  ├─ 未安装 → {status: 'not-installed'}
  ├─ 版本检测失败 → {status: 'ready', version: 'unknown'}（最佳 effort）
  ├─ 版本 < 1.1.2396 → {status: 'version-too-old', version}
  └─ 版本兼容 → {status: 'ready', version}
```

#### Deep Link 打开流程

```
openDeepLink(url)
  ├─ macOS
  │  ├─ dev mode → osascript tell application "Electron" to open location url
  │  └─ 生产 → open url
  ├─ Linux → xdg-open url
  ├─ Windows → cmd /c start "" url
  └─ 其他平台 → false
```

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 | 代价 |
|------|------|------|------|------|
| 会话迁移机制 | Deep link + 文件系统共享 | 直接 IPC（socket/pipe） | 跨平台标准，无需处理协议版本兼容性 | 需要版本检查，无法保证原子性 |
| 版本检测失败处理 | 降级为 ready，继续尝试 handoff | 严格失败阻止 handoff | 用户可能有兼容版本但检测失败，不应阻止 | 旧版本可能收到不理解的 deep link |
| Linux 安装检测 | xdg-mime 查询协议处理器 | 检查特定安装路径 | 适应不同发行版的安装位置 | 依赖 xdg-utils，可能误判 |
| Windows 协议打开 | cmd /c start | PowerShell Start-Process | 兼容性更好，避免额外依赖 | 需要处理 URL 中的特殊字符 |
| 开发模式协议 | claude-dev:// 单独命名空间 | 同一协议通过参数区分 | 避免开发与生产实例冲突 | 需要维护两套协议注册 |

#### 源码证据

- `src/utils/desktopDeepLink.ts:11-41`：常量、协议构建、开发模式检测
- `src/utils/desktopDeepLink.ts:50-96`：安装检测、版本检测
- `src/utils/desktopDeepLink.ts:129-236`：状态类型、安装状态判断、deep link 打开

#### 跨平台支持边界

| 平台 | 安装检测 | 版本检测 | Deep link 打开 | 备注 |
|------|---------|---------|---------------|------|
| macOS | ✓ | ✓ | ✓ | 完整支持 |
| Windows | ✓ | ✓ | ✓ | 完整支持 |
| Linux | ✓ | ✗ | ✓ | 仅通过 xdg-mime 检测，无版本检测 |
| WSL | ~ | ~ | ~ | 依赖 Windows 端，通过互操作访问 |

### 4.4 移动 QR 码模块设计卡

#### 真实入口签名与关键类型

```typescript
// src/commands/mobile/mobile.tsx
type Platform = 'ios' | 'android'

type Props = {
  onDone: () => void
}

const PLATFORMS: Record<Platform, { url: string }> = {
  ios: { url: 'https://apps.apple.com/app/claude-by-anthropic/id6473753684' },
  android: { url: 'https://play.google.com/store/apps/details?id=com.anthropic.claude' },
}

function MobileQRCode({ onDone }: Props): React.ReactNode
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode>
```

#### 输入输出

| 组件/函数 | 输入 | 输出/交互 |
|-----------|------|----------|
| `MobileQRCode` 组件 | `onDone` 回调 | 显示 QR 码，处理键盘输入 |
| `call` 命令入口 | `onDone` 回调 | 返回 React 节点 |
| 键盘事件 | `Tab/←/→` | 切换 iOS/Android |
| 键盘事件 | `Esc/q/Ctrl+C` | 关闭界面 |

#### 状态与配置

- **React 本地状态**：
  - `platform: Platform`：当前显示的平台（默认 `ios`）
  - `qrCodes: Record<Platform, string>`：预生成的 QR 码字符串
- **QR 码配置**：
  - `errorCorrectionLevel: 'L'`：低纠错率（适合终端显示）
  - `type: 'utf8'`：输出格式
- **无持久化状态**：每次调用重新生成

#### QR 码生成与显示流程

```
组件挂载 → 预生成 iOS + Android QR 码（Promise.all）
    ↓
显示默认平台（iOS）的 QR 码
    ↓
用户交互：
    ├─ Tab/←/→ → 切换平台状态 → 显示对应 QR 码
    └─ Esc/q/Ctrl+C → 调用 onDone 关闭
```

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 | 代价 |
|------|------|------|------|------|
| QR 码生成时机 | 预生成两个平台，避免切换闪烁 | 按需生成 | 切换更流畅 | 初始加载稍慢，浪费一个 QR 码 |
| 默认平台 | iOS | Android | iOS 用户更多 | Android 用户需要多按一次 Tab |
| 纠错级别 | L（低） | M/Q/H | 终端显示时更低的密度更容易扫描 | 抗污损能力稍弱 |
| 关闭方式 | Esc/q/Ctrl+C + 任意键 | 仅 Esc/Ctrl+C | 符合常见终端 UI 习惯 | 可能误触 |
| 应用链接 | 硬编码 | 配置/远程获取 | 稳定，无网络依赖 | 需要发版更新链接 |

#### 源码证据

- `src/commands/mobile/mobile.tsx:10-30`：类型、平台配置、URL
- `src/commands/mobile/mobile.tsx:36-53`：QR 码预生成
- `src/commands/mobile/mobile.tsx:61-71`：键盘事件处理
- `src/commands/mobile/mobile.tsx:75-110`：UI 渲染

#### 移动应用商店链接

- **iOS App Store**：`https://apps.apple.com/app/claude-by-anthropic/id6473753684`
- **Google Play Store**：`https://play.google.com/store/apps/details?id=com.anthropic.claude`

### 4.5 Claude in Chrome 与 Open CDP 模块设计卡

#### 真实入口签名与关键类型

```typescript
// src/utils/claudeInChrome/common.ts
export type ChromiumBrowser = 'chrome' | 'brave' | 'arc' | 'edge' | 'chromium' | 'vivaldi' | 'opera'

export const CHROMIUM_BROWSERS: Record<ChromiumBrowser, BrowserConfig>
export const BROWSER_DETECTION_ORDER: ChromiumBrowser[]

export async function detectAvailableBrowser(): Promise<ChromiumBrowser | null>
export async function openInChrome(url: string): Promise<boolean>
export function getSecureSocketPath(): string
export function getAllSocketPaths(): string[]
export function trackClaudeInChromeTabId(tabId: number): void
export function isTrackedClaudeInChromeTabId(tabId: number): boolean

// src/commands/chrome/chrome.tsx
type MenuAction = 'reconnect' | 'toggle-default'
type Props = {
  onDone: (result?: string) => void
  configEnabled: boolean | undefined
  isWSL: boolean
}
function ClaudeInChromeMenu({ onDone, configEnabled, isWSL }: Props): React.ReactNode
export const call = async function(onDone: (result?: string) => void): Promise<React.ReactNode>
```

#### BrowserConfig 结构

```typescript
type BrowserConfig = {
  name: string
  macos: {
    appName: string
    dataPath: string[]
    nativeMessagingPath: string[]
  }
  linux: {
    binaries: string[]
    dataPath: string[]
    nativeMessagingPath: string[]
  }
  windows: {
    dataPath: string[]
    registryKey: string
    useRoaming?: boolean  // Opera 使用 Roaming 而非 Local
  }
}
```

#### 输入输出

| 函数 | 输入 | 输出 |
|------|------|------|
| `detectAvailableBrowser` | 无 | `ChromiumBrowser \| null` |
| `openInChrome` | `url: string` | `boolean` |
| `getSecureSocketPath` | 无 | `string`（Unix socket 路径或 Windows pipe 名称） |
| `getAllSocketPaths` | 无 | `string[]`（包含当前 PID socket 和遗留路径） |
| `trackClaudeInChromeTabId` | `tabId: number` | `void` |
| `isTrackedClaudeInChromeTabId` | `tabId: number` | `boolean` |

#### 状态与配置

- **内存状态**：`trackedTabIds: Set<number>`（最大 200 个，超出自动清空）
- **全局配置**：`claudeInChromeDefaultEnabled: boolean`
- **环境变量**：
  - `CLAUDE_CHROME_CDP_ENDPOINT`：默认 `http://127.0.0.1:9222`
  - `CLAUDE_CHROME_ALLOWED_ORIGINS` 或 `PLAYWRIGHT_MCP_ALLOWED_ORIGINS`：源允许列表
- **Socket/Pipe 路径**：
  - Unix：`/tmp/claude-mcp-browser-bridge-${username}/${pid}.sock`
  - Windows：`\\.\pipe\claude-mcp-browser-bridge-${username}`

#### 浏览器检测流程

```
detectAvailableBrowser()
  按优先级顺序 [chrome, brave, arc, edge, chromium, vivaldi, opera] 检测
    ├─ macOS → 检查 /Applications/{appName}.app 目录存在
    ├─ Linux/WSL → 检查哪个 binary 存在（which）
    └─ Windows → 检查 {AppData}/Local/{dataPath} 存在（Opera 用 Roaming）
```

#### 打开 URL 流程

```
openInChrome(url)
  ├─ 检测可用浏览器
  ├─ macOS → open -a {appName} url
  ├─ Windows → rundll32 url,OpenURL url（避免 cmd 元字符问题）
  ├─ Linux/WSL → 尝试每个 binary 直到成功
  └─ 返回是否成功
```

#### Socket/Pipe 路径管理

```
getAllSocketPaths()
  ├─ Windows → [\\.\pipe\claude-mcp-browser-bridge-{username}]
  └─ Unix → 扫描 /tmp/claude-mcp-browser-bridge-{username}/*.sock
              + 遗留路径 /tmp/claude-mcp-browser-bridge-{username}
              + 遗留路径 {tmpdir}/claude-mcp-browser-bridge-{username}
```

#### Open CDP 控制菜单功能

| 功能 | 说明 |
|------|------|
| 显示连接状态 | Connected/Failed/Not connected |
| 显示 CDP endpoint | `http://127.0.0.1:9222`（仅 loopback） |
| 显示持久化 profile 目录 | 独立于用户默认 profile |
| 显示源限制配置 | 是否有允许列表 |
| 显示启动命令 | 指导用户手动启动专用 Chrome 实例 |
| 重新连接 | 清除服务器缓存，重新连接（不关闭浏览器） |
| 切换默认启用 | 修改全局配置 `claudeInChromeDefaultEnabled` |

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 | 代价 |
|------|------|------|------|------|
| 浏览器支持范围 | 仅 Chromium 系列 | Firefox/Safari | 统一扩展 API，开发成本低 | 排除部分用户 |
| 浏览器检测优先级 | Chrome > Brave > Arc > Edge > Chromium > Vivaldi > Opera | 按安装顺序/使用统计 | 覆盖主流用户，行为可预期 | 部分用户首选浏览器可能不是第一个 |
| 本地通信机制 | Unix socket / Windows named pipe | 本地 HTTP 服务器 | 安全性更高（同一用户隔离），无端口冲突 | 需要处理平台差异 |
| Open CDP 启动方式 | 用户手动启动专用实例 | 自动启动 | 避免与用户现有实例冲突，安全隔离 | 用户体验稍复杂 |
| Tab ID 追踪 | Set 自动清空（最大 200） | LRU 缓存 | 实现简单，避免内存泄漏 | 可能丢失旧 tab 跟踪 |
| Windows URL 打开 | rundll32 url,OpenURL | cmd /c start | 避免 URL 中 &\|>< 等元字符问题 | 依赖 rundll32 行为 |
| Opera 数据路径 | Roaming AppData | Local AppData | 符合 Opera 实际安装位置 | 需要特殊处理 |

#### 源码证据

- `src/utils/claudeInChrome/common.ts:15-227`：浏览器类型、配置、优先级
- `src/utils/claudeInChrome/common.ts:345-469`：浏览器检测、URL 打开
- `src/utils/claudeInChrome/common.ts:474-540`：Socket/pipe 路径管理
- `src/commands/chrome/chrome.tsx:18-135`：菜单组件、状态显示、操作处理

#### CDP Loopback 与用户数据隔离

- **CDP 仅监听 loopback**：`127.0.0.1:9222`，不暴露到网络
- **独立持久化 profile**：与用户默认 Chrome profile 分离
- **不兼容扩展配对**：Open CDP 模式与私有 Claude Chrome 扩展互斥
- **不自动关闭浏览器**：`browser_close` 禁用，用户手动管理 Chrome 生命周期
- **WSL 不支持**：Open CDP 在 WSL 环境不可用

### 4.6 Slack 安装引导模块设计卡

#### 真实入口签名与关键类型

```typescript
// src/commands/install-slack-app/install-slack-app.ts
const SLACK_APP_URL = 'https://slack.com/marketplace/A08SF47R6P4-claude'

export async function call(): Promise<LocalCommandResult>
```

#### 输入输出

| 函数 | 输入 | 输出 |
|------|------|------|
| `call` | 无 | `{type: 'text', value: string}` |

#### 状态与配置

- **全局配置**：`slackAppInstallCount: number`（记录用户点击次数）
- **无本地状态**：每次调用独立处理
- **分析事件**：`tengu_install_slack_app_clicked`

#### 安装引导流程

```
用户运行 /install-slack-app
    ↓
记录分析事件
    ↓
增加 slackAppInstallCount 计数（持久化到全局配置）
    ↓
尝试用浏览器打开 SLACK_APP_URL
    ├─ 成功 → 显示 "Opening Slack app installation page in browser…"
    └─ 失败 → 显示 URL 让用户手动访问
```

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 | 代价 |
|------|------|------|------|------|
| 安装流程位置 | Slack Marketplace 网页 | CLI 内 OAuth 流程 | Slack 安装必须在 Slack 界面完成，简化实现 | 依赖浏览器可用性 |
| 失败处理 | 显示 URL 手动访问 | 提供 QR 码 | 简单直接 | 移动设备需手动输入 |
| 点击计数 | 每次调用都增加 | 仅成功打开时增加 | 实现简单，反映用户意图 | 可能重复计数 |
| URL 硬编码 | Marketplace 固定链接 | 动态获取 | 稳定，无网络依赖 | 需要发版更新链接 |

#### 源码证据

- `src/commands/install-slack-app/install-slack-app.ts:6-30`：完整实现

#### Slack OAuth 与安装状态

- **无 CLI 内 OAuth**：完全依赖 Slack Marketplace 网页流程
- **无安装状态跟踪**：CLI 不记录是否已安装，仅记录点击次数
- **链接**：`https://slack.com/marketplace/A08SF47R6P4-claude`

### 4.7 环境检测与桌面配置读取模块设计卡

#### 真实入口签名与关键类型

```typescript
// src/utils/claudeDesktop.ts
export async function getClaudeDesktopConfigPath(): Promise<string>
export async function readClaudeDesktopMcpServers(): Promise<Record<string, McpServerConfig>>

// src/utils/platform.ts
export function getPlatform(): Platform
export const SUPPORTED_PLATFORMS: Platform[]
```

#### 输入输出

| 函数 | 输入 | 输出 | 错误情形 |
|------|------|------|---------|
| `getClaudeDesktopConfigPath` | 无 | `string`（配置文件绝对路径） | 平台不支持、文件不存在 → `Error` |
| `readClaudeDesktopMcpServers` | 无 | `Record<string, McpServerConfig>` | 平台不支持 → `Error`；其他错误 → `{}` |

#### 状态与配置

- **配置路径**：
  - macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
  - WSL：通过多种策略探测 Windows 端路径
- **配置内容**：
  ```json
  {
    "mcpServers": {
      "server-name": {
        "command": "...",
        "args": [...]
      }
    }
  }
  ```

#### WSL 配置路径探测流程

```
getClaudeDesktopConfigPath() [WSL]
  ├─ 1. 尝试 USERPROFILE 环境变量 → /mnt/c/{USERPROFILE}/AppData/Roaming/Claude/claude_desktop_config.json
  ├─ 2. 列出 /mnt/c/Users 目录，跳过 Public/Default/Default User/All Users
  ├─ 3. 对每个用户目录，尝试 /mnt/c/Users/{user}/AppData/Roaming/Claude/claude_desktop_config.json
  └─ 都失败 → 抛出 Error
```

#### MCP 配置读取流程

```
readClaudeDesktopMcpServers()
  ├─ 检查平台支持（仅 macOS/WSL）
  ├─ 获取配置路径
  ├─ 读取文件内容
  │  ├─ 文件不存在 → 返回 {}
  │  └─ 其他错误 → 记录日志，返回 {}
  ├─ 解析 JSON
  ├─ 验证 mcpServers 字段存在且为对象
  ├─ 对每个服务器配置用 McpStdioServerConfigSchema 验证
  └─ 返回通过验证的服务器配置
```

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 | 代价 |
|------|------|------|------|------|
| 支持平台 | 仅 macOS + WSL | 全平台 | 其他平台 Desktop 尚未实现或集成 | WSL 路径探测复杂 |
| WSL 路径策略 | USERPROFILE + 枚举用户目录 | 仅 USERPROFILE、要求用户配置 | 自动适应不同 WSL 设置 | 可能找到错误用户的配置 |
| 配置验证 | schema 验证过滤无效配置 | 完整返回或完全失败 | 健壮，部分配置可用时仍可工作 | 静默丢弃无效配置，难以调试 |
| 错误处理 | 读取失败返回空对象 | 抛出错误 | 不阻塞主流程 | 配置问题不可见 |

#### 源码证据

- `src/utils/claudeDesktop.ts:13-96`：配置路径获取、WSL 探测
- `src/utils/claudeDesktop.ts:98-152`：MCP 配置读取、验证

#### 桌面配置读取与隐私

- **只读访问**：仅读取配置，不修改
- **路径安全**：不访问其他 Claude Desktop 数据
- **WSL 互操作**：仅读取 Windows 端配置文件，不执行其他 Windows 操作
- **错误日志**：记录但不暴露详细错误信息

### 4.8 主控制流

#### 桌面 Handoff 流程

```
用户运行 /desktop
    ↓
检查 Desktop 安装状态
    ├─ 未安装 → 提示下载 (y/n)
    ├─ 版本过旧 → 提示更新 (y/n)
    └─ 就绪 → 继续
    ↓
Flush session storage（确保 transcript 完全写入）
    ↓
构建 deep link URL (claude://resume?session=...&cwd=...)
    ↓
打开 deep link
    ├─ 失败 → 显示错误，按任意键继续
    └─ 成功 → 显示成功消息，500ms 后优雅退出
```

#### Claude in Chrome 设置流程

```
启动时检测是否启用 Claude in Chrome
    ↓
检测可用浏览器（按优先级顺序）
    ↓
设置 native messaging host（如需要）
    ↓
启动 MCP 服务器
    ↓
建立 socket/pipe 连接
    ↓
等待浏览器扩展连接
```

#### 移动应用 QR 码流程

```
用户运行 /mobile
    ↓
预生成 iOS 和 Android QR 码
    ↓
显示默认平台（iOS）的 QR 码
    ↓
用户可以：
    ├─ Tab / ← / → → 切换平台
    ├─ Esc / Ctrl+C / 任意键 → 关闭
    └─ 用手机扫描 QR 码 → 打开应用商店
```

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 错误情况 | 处理方式 | 用户体验 |
|---------|---------|---------|
| Desktop 未安装 | 提示下载 (y/n)，y 打开浏览器 | 清晰的安装引导 |
| Desktop 版本过旧 | 提示更新 (y/n)，y 打开浏览器 | 明确的版本要求 |
| Desktop 版本检测失败 | 直接尝试 handoff | 最佳 effort，不阻止用户 |
| Deep link 打开失败 | 显示错误消息，按任意键继续 | 提供手动打开备选 |
| 无可用浏览器 | 不启动 MCP 服务器 | 无提示（静默降级） |
| Socket 创建失败 | 记录日志，不启动 | 无提示（静默降级） |
| 浏览器连接断开 | 显示失败状态，可重新连接 | /chrome 命令提供重连选项 |
| QR 码生成失败 | 留空，仍显示 URL | 用户可以手动访问 URL |
| 浏览器打开 Slack 失败 | 显示 URL 让用户手动访问 | 清晰的回退方案 |

### 5.2 工程取舍

| 取舍 | 选择 | 理由 | 代价 |
|-----|------|------|------|
| 桌面 handoff 使用 deep link | 协议标准化 | 跨平台兼容性好 | 需要版本检测和错误处理 |
| 浏览器检测优先级 | 预定义排序 | 用户体验一致 | 需要维护各浏览器路径差异 |
| 本地通信使用 socket/pipe | Unix socket + Windows named pipe | 安全性高，限制同一用户 | 需要处理平台差异 |
| Desktop 配置读取 | 支持 WSL 跨环境 | WSL 用户可用 | 路径检测逻辑复杂 |
| Chrome CDP 连接 | Playwright MCP + 持久化 profile | 安全隔离用户日常浏览 | 用户需要手动启动专用实例 |

## 6. 现状验收标准

### 6.1 功能验收标准

- 用户运行 `/desktop` 命令时，系统检测 Claude Desktop 安装状态，未安装时提示下载，版本过旧时提示更新
- Desktop handoff 成功时，会话存储完全 flush，deep link 正确打开，CLI 优雅退出
- `/mobile` 命令显示 iOS 和 Android QR 码，支持 tab 切换，键盘快捷键关闭
- Claude in Chrome 启动时自动检测可用浏览器，按优先级排序，设置 native messaging host，建立安全 socket 连接
- `/chrome` 命令显示连接状态，提供重新连接和切换默认启用选项
- `/install-slack-app` 命令在浏览器中打开 Slack Marketplace 页面，失败时显示 URL
- Claude Desktop 配置读取支持 macOS 标准路径和 WSL 跨环境检测
- Chrome Open CDP 连接支持通过 `--chrome` flag 或 `/chrome` 命令连接用户手动启动的专用实例，支持重连不关闭浏览器

### 6.2 行为验收标准

- Desktop upsell 提示最多显示 3 次，用户选择"Never"后永久关闭
- Claude in Chrome 仅在非 WSL 环境完全支持
- 浏览器通信使用用户隔离的 socket/pipe 路径
- WSL 环境下尝试多种路径检测 Windows 侧 Claude Desktop 配置
- 所有集成在不可用时提供清晰降级，不阻塞主流程

## 7. 代码与测试证据

### 7.1 关键代码证据

桌面 deep link 构建与检测：
- `src/utils/desktopDeepLink.ts:35-41`：协议格式定义
- `src/utils/desktopDeepLink.ts:137-162`：安装状态检测
- `src/utils/desktopDeepLink.ts:168-200`：deep link 打开逻辑

桌面 upsell 控制：
- `src/components/DesktopUpsell/DesktopUpsellStartup.tsx:35-42`：提示计数管理
- `src/components/DesktopUpsell/DesktopUpsellStartup.tsx:54-62`：用户选择处理

Claude in Chrome 配置：
- `src/utils/claudeInChrome/common.ts:39-216`：浏览器定义与检测
- `src/utils/claudeInChrome/common.ts:345-409`：路径管理
- `src/utils/claudeInChrome/common.ts:474-540`：socket/pipe 通信

Claude Desktop 配置：
- `src/utils/claudeDesktop.ts:13-96`：配置路径读取与解析

命令实现：
- `src/commands/desktop/`：Desktop handoff 界面
- `src/commands/mobile/mobile.tsx:25-120`：移动 QR 码显示
- `src/commands/chrome/chrome.tsx:26-135`：Chrome 控制菜单
- `src/commands/install-slack-app/install-slack-app.ts:8-30`：Slack 安装

### 7.2 测试覆盖现状

现有测试：当前无专门的 platform-integrations 测试文件，相关测试可能包含在其他模块中

未覆盖场景：
- Linux Desktop 集成完整流程测试
- WSL 与 Windows Desktop 互操作测试
- 各 Chromium 浏览器路径检测与 native messaging host 设置
- deep link 协议版本兼容性测试
- 网络错误情况下的降级行为测试
- Desktop upsell 提示计数与 dismiss 状态持久化

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/platform-integrations.yaml)

### 8.1 源文件覆盖

| 文件 | 主要职责 | 公开接口 |
|------|---------|---------|
| `src/utils/desktopDeepLink.ts` | 桌面 deep link 协议、安装检测、版本检查 | `getDesktopInstallStatus()`, `openCurrentSessionInDesktop()` |
| `src/utils/claudeDesktop.ts` | 桌面配置读取与 MCP 服务器解析 | `getClaudeDesktopConfigPath()`, `readClaudeDesktopMcpServers()` |
| `src/utils/claudeInChrome/common.ts` | 浏览器检测、socket 路径、native messaging | `detectAvailableBrowser()`, `getSecureSocketPath()`, `getAllSocketPaths()` |
| `src/components/DesktopUpsell/DesktopUpsellStartup.tsx` | Desktop upsell 提示 UI | 组件接口 |
| `src/components/DesktopHandoff/DesktopHandoff.tsx` | Desktop handoff UI | 组件接口 |
| `src/commands/mobile/mobile.tsx` | 移动应用 QR 码命令 | `/mobile` 命令 |
| `src/commands/chrome/chrome.tsx` | Chrome 控制菜单命令 | `/chrome` 命令 |
| `src/commands/install-slack-app/install-slack-app.ts` | Slack 安装命令 | `/install-slack-app` 命令 |

### 8.2 相关子系统

- MCP 集成：`src/services/mcp/` 用于 Claude in Chrome MCP 服务器连接
- 会话存储：用于 Desktop handoff 时的 flush 和恢复
- 配置管理：用于 upsell 状态、Claude in Chrome 默认启用等设置
- 浏览器工具：`src/tools/WebBrowserTool.ts` 使用隔离浏览器客户端

[Coverage](../../architecture/coverage/platform-integrations.yaml)

## 9. 改进建议

### 9.1 短期改进

- 为 Linux Desktop 集成增加完整的测试覆盖，验证 `isDesktopInstalled()` 在各发行版的行为
- 增强 WSL 与 Windows Desktop 互操作测试，验证 deep link 从 WSL 打开 Windows Desktop 的完整流程
- 重构 `DesktopUpsellStartup.tsx`，使用 `useKeybindings` 替代 raw `useInput` 以符合项目约定
- 为各 Chromium 浏览器的路径检测增加单元测试，验证优先级排序和 fallback 逻辑
- 增加 socket/pipe 创建失败时的用户可见提示，而非静默降级

### 9.2 中期改进

- 考虑支持非 Chromium 浏览器（Firefox、Safari）的扩展集成，通过统一的抽象层
- 实现 Desktop 配置的双向同步，允许 CLI 修改 Desktop MCP 服务器配置
- 增加移动应用的深层链接支持，允许从移动应用反向打开 CLI 会话
- 为 Slack 集成增加 OAuth 流程支持，允许在 CLI 内完成安装而无需浏览器
- 实现跨平台统一的协议注册机制，减少各平台代码差异

### 9.3 长期考虑

- 评估使用 gRPC 或其他标准化 IPC 机制替代当前的 deep link + 文件系统共享方案
- 考虑实现插件化的平台集成架构，允许第三方添加新的平台支持
- 探索端到端加密的跨设备会话同步机制
