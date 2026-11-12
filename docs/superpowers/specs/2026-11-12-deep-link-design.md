---
id: deep-link
batch: 6
title: Deep Link 协议解析与目标路由设计
date: 2026-11-12
status: draft
---

# Deep Link 协议解析与目标路由设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要支持从外部应用（如浏览器、IDE）通过自定义 URI 协议启动并自动跳转到特定工作目录或仓库，甚至可以预填充用户输入，以提供无缝的跨应用体验。主要挑战包括：

- 跨平台协议注册差异：macOS 需要 .app bundle，Linux 需要 .desktop 文件，Windows 需要注册表修改
- 安全风险：URL 参数可能包含恶意字符，需严格验证
- 终端检测与偏好：不同用户使用不同终端，需记住偏好
- 用户确认：需要明确告知用户会话来自外部链接，避免隐藏提示注入
- 无终端环境：协议处理程序在 headless 环境运行，需能检测并启动用户偏好的终端

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|----------|------------|---------------------|------|------|
| 协议格式：`claude-cli://open` | 采用单一动作路径 `open`，参数 `q`（预填充）、`cwd`（目录）、`repo`（仓库 slug） | 简单清晰，未来可扩展其他动作 | 使用 REST 风格路径如 `/open/repo/:owner/:name` 会让 URL 构造复杂，增加解析错误率 | 限制当前功能集，但预留扩展空间 | [parseDeepLink.ts:35-41](/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs/src/utils/deepLink/parseDeepLink.ts) |
| 安全验证：严格控制字符集 | 拒绝所有 ASCII 控制字符，repo 必须匹配 slug 模式，q 限制 5000 字符，cwd 必须是绝对路径 | 防止命令注入和恶意提示注入，超过 5000 字符很难在用户不注意的情况下隐藏恶意内容 | 仅做 sanitize 不拒绝：可能在某些边缘 shell 场景出问题；完全禁止 q 参数：功能受限 | 某些超长合法提示无法使用，但用户体验更安全 | [parseDeepLink.ts:33-41,50-50,113-159](/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs/src/utils/deepLink/parseDeepLink.ts) |
| 终端检测分层：存储偏好 > 运行进程 > 已安装应用 | macOS 下先读取用户之前存储的偏好，否则检测正在运行的终端，再通过 mdfind/ls 检查已安装应用 | 优先用户选择，其次按实际使用习惯，最后回退到系统默认 | 仅用固定优先级列表：不能适应不同用户的真实偏好 | 需要存储状态，增加复杂度 | [terminalPreference.ts:38-54](/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs/src/utils/deepLink/terminalPreference.ts), [terminalLauncher.ts:64-121](/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs/src/utils/deepLink/terminalLauncher.ts) |
| macOS 注册：创建独立 .app trampoline | 生成最小化 `Claude Code URL Handler.app`，仅含 Info.plist 和指向 claude 的 symlink | 避免重新签名完整应用，利用现有 LaunchServices 机制 | 直接在主应用注册：需要重新签名，对非安装版不友好 | 需要维护额外的 bundle 结构 | [registerProtocol.ts:72-138](/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs/src/utils/deepLink/registerProtocol.ts) |
| 安全 banner：强制显示来源提示 | 启动时显示醒目标题，说明来自外部链接，超长 q 时额外警告需滚动查看 | 防止用户误按回车执行注入的提示 | 完全阻塞：不友好；仅在有 q 时显示：cwd 跳转也应让用户感知 | 每次深层链接启动都有 banner，增加用户确认步骤 | [banner.ts:43-75](/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs/src/utils/deepLink/banner.ts) |
| repo 解析：通过 githubRepoPathMapping | repo 参数不直接作为路径，而是通过已有的 `githubRepoPaths` 配置查找本地克隆 | 防止路径遍历，且支持一个仓库有多个克隆的情况（取最近使用） | 允许 repo 直接映射到路径：安全风险高 | 需要依赖现有映射机制 | [protocolHandler.ts:116-136](/Users/fengcaiwen/GolandProjects/claude-code/.claude/worktrees/date-based-commit-docs/src/utils/deepLink/protocolHandler.ts) |

## 3. 目标与非目标

### 协议与解析

- **目标**：`claude-cli://open` 格式支持 `q`、`cwd`、`repo` 参数
- **目标**：严格的参数验证，拒绝控制字符，强制 cwd 为绝对路径，repo 为 owner/name 格式
- **目标**：q 限制 5000 字符，超过直接拒绝而非截断
- **非目标**：不支持其他动作如 `new` 或 `search`（当前不需要）

### 注册与安装

- **目标**：跨平台自动注册（macOS/Linux/Windows）
- **目标**：失败回退策略（权限不足时标记，下次不重试）
- **非目标**：不需要用户手动确认注册（静默自动处理）

### 终端启动

- **目标**：检测并记住用户偏好的终端
- **目标**：纯 argv 路径优先，避免 shell 解释（Ghostty/Alacritty/Kitty/WezTerm/Windows Terminal）
- **目标**：shell 路径作为后备（iTerm2/Terminal.app/PowerShell/cmd）
- **非目标**：不支持自定义终端路径配置

### 安全与提示

- **目标**：显示深层链接来源 banner
- **目标**：超长提示时显式警告需滚动查看
- **目标**：repo 解析时显示 git 仓库的 freshness
- **非目标**：不需要用户再次确认才能继续（仅显示提示）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// parseDeepLink.ts
// 解析深层链接 URL，返回结构化动作
function parseDeepLink(uri: string): DeepLinkAction
function buildDeepLink(action: DeepLinkAction): string

// protocolHandler.ts
// 主入口：处理 URI 并启动终端
async function handleDeepLinkUri(uri: string): Promise<number>
// macOS 特殊处理：通过 Apple Event 接收 URL
async function handleUrlSchemeLaunch(): Promise<number | null>

// registerProtocol.ts
// 注册协议处理器
async function registerProtocolHandler(claudePath?: string): Promise<void>
// 检查是否已注册且指向当前可执行文件
async function isProtocolHandlerCurrent(claudePath: string): Promise<boolean>
// 后台自动注册入口
async function ensureDeepLinkProtocolRegistered(): Promise<void>

// terminalLauncher.ts
// 在检测到的终端中启动 claude
async function launchInTerminal(
  claudePath: string,
  action: { query?: string; cwd?: string; repo?: string; lastFetchMs?: number }
): Promise<boolean>

// banner.ts
// 构建 banner 文本
function buildDeepLinkBanner(info: DeepLinkBannerInfo): string
// 读取 FETCH_HEAD mtime
async function readLastFetchTime(cwd: string): Promise<Date | undefined>

// terminalPreference.ts
// 从当前运行终端捕获并存储偏好
function updateDeepLinkTerminalPreference(): void
```

### 4.2 深层链接处理流程

```
外部链接 (claude-cli://open?q=...&cwd=...)
    ↓
操作系统协议处理程序
    ↓
claude --handle-uri <uri>
    ↓
parseDeepLink() 验证与解析
    ↓
resolveCwd() 解析工作目录 (cwd → repo 查找 MRU → homedir)
    ↓
readLastFetchTime() 读取 git freshness
    ↓
launchInTerminal() 检测终端并启动
    ├─ 纯 argv: open -a Ghostty --args --working-directory=... claude ...
    ├─ AppleScript: tell app "iTerm" to write text <shell cmd>
    ├─ Linux: x-terminal-emulator -e claude ...
    └─ Windows: wt -d ... claude ... 或 PowerShell/cmd
         ↓
    新终端运行: claude --deep-link-origin --prefill=...
         ↓
    show deep link banner + prefilled input
```

### 4.3 模块依赖边界

- **deepLink 模块**：独立，可单独导入使用
  - 依赖：`config.ts`（终端偏好存储）、`githubRepoPathMapping.ts`（repo 解析）、`sanitize.ts`（unicode sanitize）
- **registerProtocol.ts**：在 `backgroundHousekeeping.ts` 中被调用
- **protocolHandler.ts**：在 `main.tsx` 早期 CLI 处理阶段使用（在 full init 之前）
- **banner.ts**：在交互式启动时构建提示

## 5. 协议格式详解

### 5.1 URI 结构

```
claude-cli://open[?q=<query>][&cwd=<absolute-path>][&repo=<owner>/<name>]
```

- 协议：`claude-cli`（也接受 `claude-cli:` 无 `//` 的形式，会标准化）
- 主机名：必须为 `open`（仅一个动作）
- 参数：
  - `q`：预填充的提示文本（URL 编码，可选）
  - `cwd`：绝对工作目录路径（可选）
  - `repo`：GitHub `owner/name` slug（可选，通过 `githubRepoPaths` 解析）

### 5.2 验证规则

- `cwd`：必须为绝对路径（`/` 开头或 Windows 驱动器如 `C:\`），无控制字符，长度 ≤ 4096
- `repo`：必须匹配 `/^[\w.-]+\/[\w.-]+$/`
- `q`：无控制字符，长度 ≤ 5000，经过 `partiallySanitizeUnicode` 清理
- 任何验证失败：拒绝整个链接，返回错误码

## 6. 终端启动策略

### 6.1 macOS 优先顺序

1. 存储的用户偏好（来自之前在终端中的运行）
2. 正在运行的终端检测
3. 已安装应用检查（mdfind Spotlight 搜索，回退到 ls /Applications）
4. 最终回退到 Terminal.app

支持的终端：iTerm2、Ghostty、Kitty、Alacritty、WezTerm、Terminal.app

### 6.2 纯 argv vs shell 路径

纯 argv（安全，无 shell 解释）：
- Ghostty：`open -na Ghostty --args --window-save-state=never --working-directory=<cwd> -e <claude> <args>`
- Alacritty：`open -na Alacritty --args --working-directory <cwd> -e <claude> <args>`
- Kitty/WezTerm：类似，各终端有自己的参数约定
- Linux：所有终端都通过 `-e` 或等效参数直接 exec
- Windows Terminal：`wt -d <cwd> -- <claude> <args>`

Shell 解释路径（需要 careful quoting）：
- iTerm2：AppleScript `write text`（shell 命令字符串）
- Terminal.app：AppleScript `do script`
- PowerShell：`-Command "& '<claude>' <args>"`（单引号 PowerShell 字符串）
- cmd.exe：`/c cd /d <cwd> && "<claude>" <args>`（特殊 cmd 引用规则，去除双引号，`%` → `%%`，尾随反斜杠加倍）

### 6.3 Shell 引用策略

- POSIX shell：单引号包裹，内部 `'` 替换为 `'\''`
- AppleScript：反斜杠转义 `\` 和 `"`
- PowerShell：单引号包裹，内部 `'` 替换为 `''`
- cmd.exe：双引号包裹，去除输入中的 `"`，`%` → `%%`，尾随 `\` → `\\`

## 7. 跨平台注册机制

### 7.1 macOS

- 创建 `~/Applications/Claude Code URL Handler.app`
- `Contents/Info.plist` 包含 `CFBundleURLTypes` 注册 `claude-cli` scheme
- `Contents/MacOS/claude` → symlink 到当前可执行文件
- 运行 `lsregister` 刷新 LaunchServices
- bundle ID：`com.anthropic.claude-code-url-handler`

### 7.2 Linux

- 创建 `~/.local/share/applications/claude-code-url-handler.desktop`
- 内容：`Exec=<claudePath> --handle-uri %u` + `MimeType=x-scheme-handler/claude-cli`
- 运行 `xdg-mime default` 设置为默认处理器

### 7.3 Windows

- 写入 `HKEY_CURRENT_USER\Software\Classes\claude-cli`
- 设置默认值为 `URL:Claude Code Deep Link`，`URL Protocol` 为空字符串
- 创建 `shell\open\command` 键，值为 `"<claudePath>" --handle-uri "%1"`

### 7.4 注册检查与幂等性

- `isProtocolHandlerCurrent()` 验证注册指向当前可执行文件
- macOS：读取 symlink 目标
- Linux：读取 .desktop 文件的 Exec 行
- Windows：查询注册表默认值
- 失败回退：24 小时内不再重试（通过 marker 文件标记）

## 8. 安全考虑

### 8.1 参数验证

- 所有输入：拒绝 ASCII 控制字符（0x00-0x1F, 0x7F）
- cwd：必须是绝对路径，限制 4096 字符
- repo：严格 owner/name 格式
- q：5000 字符上限，部分清理 unicode 隐藏字符

### 8.2 注入防护

- 优先纯 argv 路径：用户输入不经过 shell 解释
- Shell 路径：每层都正确引用（shell quote → AppleScript quote，等）
- cmd.exe：特殊处理，去除 `"`，`%` → `%%`

### 8.3 用户感知

- Deep link banner：始终显示，说明来源
- 超长提示（>1000 字符）：显式警告需滚动查看
- Repo 解析：显示 last fetch 时间，过时警告

### 8.4 隔离

- `--handle-uri` 路径在早期 CLI 处理阶段运行，最小化暴露
- `handleUrlSchemeLaunch()` 仅在 `__CFBundleIdentifier` 匹配时触发
- 协议处理程序独立于主会话运行

## 9. 仓库 Freshness 显示

- 从 `FETCH_HEAD` mtime 读取最后 fetch 时间
- 同时检查工作目录 git dir 和 common git dir（如工作树情况），取较新的
- Banner 显示：`Resolved owner/repo from local clones · last fetched 3 days ago`
- 超过 7 天：`· last fetched 3 months ago — CLAUDE.md may be stale`

## 10. 桌面应用双向深层链接

除了 `claude-cli://` 用于 CLI 外，还有反向的 `claude://` 协议用于桌面应用：

- 格式：`claude://resume?session=<sessionId>&cwd=<cwd>`
- Dev mode：`claude-dev://resume?session=<sessionId>&cwd=<cwd>`
- 功能：将 CLI 会话转移到 Claude Desktop
- 入口：`/desktop` 命令
- 检测：检查桌面应用是否安装且版本 ≥ 1.1.2396
- 流程：flush session storage → open deep link → exit CLI

这部分与 `claude-cli://` 协议是独立的，不要混淆。

## 11. Coverage

相关代码与测试覆盖范围见 [Coverage](/docs/architecture/coverage/deep-link.yaml)。
