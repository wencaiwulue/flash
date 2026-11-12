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

Claude Code 的 Deep Link 系统需要解决以下核心问题：

- 跨平台协议注册：macOS 需要 .app bundle，Linux 需要 .desktop 文件，Windows 需要注册表修改
- 安全验证：URL 参数可能包含恶意字符，需要严格验证和 sanitize
- 终端检测与偏好：不同用户使用不同终端，需要检测并记住偏好
- 用户确认：需要明确告知用户会话来自外部链接，防止隐藏提示注入
- 无终端环境：协议处理程序可能在 headless 环境运行，需要能检测并启动用户偏好的终端
- 路径处理：Windows 需要处理 POSIX 路径与 native 路径转换，Git Bash vs PowerShell vs cmd 差异
- 仓库解析：repo 参数不直接作为路径，通过已有的 `githubRepoPaths` 配置查找本地克隆
- Freshness 显示：需要显示仓库的最后 fetch 时间，过时警告
- 协议格式统一：需要简单清晰的协议格式，便于外部应用构造
- 桌面双向链接：除了 `claude-cli://` 用于 CLI，还有反向的 `claude://` 用于桌面应用
- 防止覆盖：协议注册需要检查是否已存在，避免覆盖其他应用的注册
- 权限限制：注册表修改可能需要管理员权限，需要处理权限不足的情况

关键约束条件：

- 协议格式：`claude-cli://open?{query}{&cwd}{&repo}`
- cwd 必须是绝对路径，拒绝相对路径
- repo 必须匹配 `^[\w.-]+/[\w.-]+$` 格式
- query 限制 5000 字符，超过直接拒绝
- 所有参数拒绝 ASCII 控制字符（0x00-0x1F, 0x7F）
- macOS 创建独立 .app trampoline，不修改主应用
- Linux 注册到 `~/.local/share/applications/`
- Windows 注册到 `HKEY_CURRENT_USER\Software\Classes\`
- 注册失败时标记，下次不重试（通过 marker 文件）
- 显示 deep link banner，超长 query 警告需要滚动查看
- 终端启动优先纯 argv 路径（Ghostty/Alacritty/Kitty/WezTerm/Windows Terminal），shell 路径作为后备

## 2. 设计理由与备选方案

### 决策 1：协议格式采用单一动作路径 `open`

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 方案 | `claude-cli://open?{q}{&cwd}{&repo}` |
| 理由 | 简单清晰，未来可扩展其他动作 |
| 替代 | REST 风格路径如 `/open/repo/{owner}/{name}`（复杂，解析错误率高） |
| 代价 | 限制当前功能集，但预留扩展空间 |
| 证据 | `parseDeepLink.ts:35-41` |

### 决策 2：严格安全验证，白名单字符集

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 方案 | 拒绝所有 ASCII 控制字符，repo 必须匹配 slug 模式，q 限制 5000 字符，cwd 必须是绝对路径 |
| 理由 | 防止命令注入和恶意提示注入，超过 5000 字符很难在用户不注意的情况下隐藏恶意内容 |
| 替代 | 仅做 sanitize 不拒绝（可能在某些边缘 shell 场景出问题）；完全禁止 q 参数（功能受限） |
| 代价 | 某些超长合法提示无法使用，但用户体验更安全 |
| 证据 | `parseDeepLink.ts:33-41,50-50,113-159` |

### 决策 3：终端检测分层：存储偏好 > 运行进程 > 已安装应用

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 方案 | macOS 下先读取用户之前存储的偏好，否则检测正在运行的终端，再通过 mdfind/ls 检查已安装应用 |
| 理由 | 优先用户选择，其次按实际使用习惯，最后回退到系统默认 |
| 替代 | 仅用固定优先级列表（不能适应不同用户的真实偏好） |
| 代价 | 需要存储状态，增加复杂度 |
| 证据 | `terminalPreference.ts:38-54`、`terminalLauncher.ts:64-121` |

### 决策 4：macOS 注册创建独立 .app trampoline

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 方案 | 生成最小化 `Claude Code URL Handler.app`，仅含 Info.plist 和指向 claude 的 symlink |
| 理由 | 避免重新签名完整应用，利用现有 LaunchServices 机制 |
| 替代 | 直接在主应用注册（需要重新签名，对非安装版不友好） |
| 代价 | 需要维护额外的 bundle 结构 |
| 证据 | `registerProtocol.ts:72-138` |

### 决策 5：安全 banner 强制显示来源提示

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 方案 | 启动时显示醒目标题，说明来自外部链接，超长 q 时额外警告需滚动查看 |
| 理由 | 防止用户误按回车执行注入的提示 |
| 替代 | 完全阻塞（不友好）；仅在有 q 时显示（cwd 跳转也应让用户感知） |
| 代价 | 每次深层链接启动都有 banner，增加用户确认步骤 |
| 证据 | `banner.ts:43-75` |

### 决策 6：repo 参数通过 githubRepoPaths 解析，不直接作为路径

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 方案 | repo 参数不直接作为路径，通过已有的 `githubRepoPaths` 配置查找本地克隆（取最近使用的） |
| 理由 | 防止路径遍历，且支持一个仓库有多个克隆的情况 |
| 替代 | 允许 repo 直接映射到路径（安全风险高） |
| 代价 | 需要依赖现有映射机制 |
| 证据 | `protocolHandler.ts:116-136` |

## 3. 目标与非目标

### 目标

- **协议解析**：`claude-cli://open` 格式支持 `q`、`cwd`、`repo` 参数
- **安全验证**：严格参数验证，拒绝控制字符，强制 cwd 为绝对路径，repo 为 owner/name 格式
- **长度限制**：q 限制 5000 字符，超过直接拒绝而非截断
- **跨平台注册**：macOS/Linux/Windows 自动注册
- **失败回退**：权限不足时标记，下次不重试（marker 文件）
- **终端检测**：检测并记住用户偏好的终端
- **纯 argv 优先**：纯 argv 路径优先（Ghostty/Alacritty/Kitty/WezTerm/Windows Terminal），避免 shell 解释
- **shell 路径后备**：shell 路径作为后备（iTerm2/Terminal.app/PowerShell/cmd）
- **安全 banner**：显示深层链接来源提示
- **超长警告**：超长提示时显式警告需滚动查看
- **Freshness 显示**：repo 解析时显示 git 仓库的最后 fetch 时间

### 非目标

- 不支持其他动作如 `new` 或 `search`（当前不需要）
- 不需要用户手动确认注册（静默自动处理）
- 不支持自定义终端路径配置
- 不需要用户再次确认才能继续（仅显示提示）
- 不实现 `claude://` 桌面协议的服务端（仅作为客户端调用桌面）
- 不跨会话记住 repo 解析结果（每次重新解析）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// parseDeepLink.ts
function parseDeepLink(uri: string): DeepLinkAction
function buildDeepLink(action: DeepLinkAction): string

// protocolHandler.ts
async function handleDeepLinkUri(uri: string): Promise<number>
async function handleUrlSchemeLaunch(): Promise<number | null>

// registerProtocol.ts
async function registerProtocolHandler(claudePath?: string): Promise<void>
async function isProtocolHandlerCurrent(claudePath: string): Promise<boolean>
async function ensureDeepLinkProtocolRegistered(): Promise<void>

// terminalLauncher.ts
async function launchInTerminal(
  claudePath: string,
  action: { query?: string; cwd?: string; repo?: string; lastFetchMs?: number }
): Promise<boolean>

// banner.ts
function buildDeepLinkBanner(info: DeepLinkBannerInfo): string
async function readLastFetchTime(cwd: string): Promise<Date | undefined>

// terminalPreference.ts
function updateDeepLinkTerminalPreference(): void
```

### 4.2 深层链接处理流程

```
外部链接（claude-cli://open?q=...&cwd=...）
    ↓
操作系统协议处理程序
    ↓
claude --handle-uri <uri>
    ↓
parseDeepLink() 验证与解析
    ├─ 验证协议格式
    ├─ 验证参数（无控制字符）
    ├─ 验证 cwd 是绝对路径
    ├─ 验证 repo 格式
    └─ 验证 q 长度 ≤ 5000
    ↓
resolveCwd() 解析工作目录
    ├─ cwd 提供 → 验证绝对路径，使用
    ├─ repo 提供 → 查找 githubRepoPaths，取最近使用
    └─ 都不提供 → 使用 $HOME
    ↓
readLastFetchTime() 读取 git freshness
    ├─ 检查 FETCH_HEAD mtime
    ├─ 检查 common git dir（工作树情况）
    └─ 取较新的时间
    ↓
launchInTerminal() 检测终端并启动
    ├─ 读取用户偏好（如果有）
    ├─ 检测正在运行的终端
    ├─ 检测已安装应用
    ├─ 选择终端和启动方式
    ├─ 纯 argv 路径：直接 exec（无 shell 解释）
    └─ shell 路径：小心引用，通过 shell 执行
    ↓
新终端运行：claude --deep-link-origin --prefill=...
    ↓
显示 deep link banner + prefilled input
    ├─ 显示来源提示
    ├─ 显示 repo freshness（如果有）
    └─ 超长 query 警告需滚动查看
```

### 4.3 协议注册流程

```
backgroundHousekeeping() 调用 ensureDeepLinkProtocolRegistered()
    ↓
检查 marker 文件（是否上次注册失败）
    ├─ 存在且未过期 → 跳过
    └─ 不存在或过期 → 继续
    ↓
isProtocolHandlerCurrent() 检查是否已注册且指向当前可执行文件
    ├─ 是 → 跳过
    └─ 否 → 继续
    ↓
按平台注册：
    ├─ macOS：
    │   ├─ 创建 `~/Applications/Claude Code URL Handler.app`
    │   ├─ 写入 Info.plist（注册 claude-cli scheme）
    │   ├─ 创建 symlink 到当前 claude 可执行文件
    │   └─ 运行 lsregister 刷新 LaunchServices
    ├─ Linux：
    │   ├─ 创建 `~/.local/share/applications/claude-code-url-handler.desktop`
    │   ├─ 写入 Exec=... --handle-uri %u
    │   ├─ 写入 MimeType=x-scheme-handler/claude-cli
    │   └─ 运行 xdg-mime default 设置为默认
    └─ Windows：
        ├─ 写入 `HKEY_CURRENT_USER\Software\Classes\claude-cli`
        ├─ 设置默认值为 URL:Claude Code Deep Link
        ├─ 设置 URL Protocol 为空字符串
        └─ 创建 shell\open\command 键
    ↓
注册成功 → 完成
注册失败 → 创建 marker 文件，标记下次不重试
```

### 4.4 终端启动策略

#### macOS 优先顺序

1. 存储的用户偏好（来自之前在终端中的运行）
2. 正在运行的终端检测
3. 已安装应用检查（mdfind Spotlight 搜索，回退到 ls /Applications）
4. 最终回退到 Terminal.app

#### 纯 argv vs shell 路径

**纯 argv（安全，无 shell 解释）**：
- Ghostty：`open -na Ghostty --args --window-save-state=never --working-directory=<cwd> -e <claude> <args>`
- Alacritty：`open -na Alacritty --args --working-directory <cwd> -e <claude> <args>`
- Kitty/WezTerm：类似，各终端有自己的参数约定
- Linux：所有终端都通过 `-e` 或等效参数直接 exec
- Windows Terminal：`wt -d <cwd> -- <claude> <args>`

**Shell 解释路径（需要 careful quoting）**：
- iTerm2：AppleScript `write text`（shell 命令字符串）
- Terminal.app：AppleScript `do script`
- PowerShell：`-Command "& '<claude>' <args>"`（单引号 PowerShell 字符串）
- cmd.exe：`/c cd /d <cwd> && "<claude>" <args>`（特殊 cmd 引用规则，去除双引号，`%` → `%%`，尾随反斜杠加倍）

#### Shell 引用策略

- POSIX shell：单引号包裹，内部 `'` 替换为 `'\''`
- AppleScript：反斜杠转义 `\` 和 `"`
- PowerShell：单引号包裹，内部 `'` 替换为 `''`
- cmd.exe：双引号包裹，去除输入中的 `"`，`%` → `%%`，尾随 `\` → `\\`

### 4.5 模块依赖边界

- **deepLink 模块**：独立，可单独导入使用
  - 依赖：`config.ts`（终端偏好存储）、`githubRepoPaths.ts`（repo 解析）、`sanitize.ts`（unicode sanitize）
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
- `repo`：必须匹配 `^[\w.-]+/[\w.-]+$`
- `q`：无控制字符，长度 ≤ 5000，经过 `partiallySanitizeUnicode` 清理
- 任何验证失败：拒绝整个链接，返回错误码

## 6. 失败语义与工程取舍

### 6.1 失败语义

| 失败场景 | 处理方式 | 用户体验 |
|---------|---------|---------|
| 协议解析失败 | 显示错误，退出码 1 | 清晰错误提示 |
| 参数验证失败 | 显示错误，退出码 1 | 清晰错误提示，说明验证失败原因 |
| q 超过 5000 字符 | 直接拒绝，退出码 1 | 清晰长度限制提示 |
| repo 未找到本地克隆 | 回退到 $HOME，警告用户 | 显示警告，仍启动 |
| 终端检测失败 | 回退到系统默认终端 | 仍能启动，可能不是用户偏好 |
| 终端启动失败 | 显示错误，退出码 1 | 清晰错误提示 |
| 协议注册权限不足 | 标记失败，下次不重试 | 静默失败，不影响使用 |
| 协议注册已存在且指向其他版本 | 不覆盖，跳过 | 不破坏现有配置 |
| git fetch 时间读取失败 | 忽略，不显示 freshness | 仍正常启动 |

### 6.2 工程取舍

| 取舍 | 选择 | 理由 | 代价 |
|-----|------|------|------|
| 协议动作设计 | 单一 `open` 动作 | 简单清晰，预留扩展空间 | 当前功能受限 |
| 参数验证策略 | 严格白名单 + 长度限制 | 安全优先，防止注入 | 某些超长合法提示无法使用 |
| 终端启动方式 | 纯 argv 优先，shell 后备 | 安全第一，无 shell 解释 | 需要为每个终端处理不同参数约定 |
| macOS 注册方式 | 独立 .app trampoline | 避免重新签名主应用 | 需要维护额外 bundle 结构 |
| 注册失败策略 | Marker 文件标记，下次不重试 | 避免重复失败提示用户 | 可能错过后续权限恢复后的注册机会 |
| repo 解析策略 | 通过 githubRepoPaths 查找 | 安全，支持多克隆 | 需要依赖现有映射机制 |
| banner 策略 | 强制显示，不提供跳过 | 安全第一，防止注入 | 每次都有 banner，增加确认步骤 |
| 超长 q 策略 | 直接拒绝，不截断 | 防止用户错过截断后的恶意内容 | 某些超长合法提示无法使用 |

### 6.3 安全考虑

#### 参数验证

- 所有输入：拒绝 ASCII 控制字符（0x00-0x1F, 0x7F）
- cwd：必须是绝对路径，限制 4096 字符
- repo：严格 owner/name 格式
- q：5000 字符上限，部分清理 unicode 隐藏字符

#### 注入防护

- 优先纯 argv 路径：用户输入不经过 shell 解释
- Shell 路径：每层都正确引用（shell quote → AppleScript quote，等）
- cmd.exe：特殊处理，去除 `"`，`%` → `%%`

#### 用户感知

- Deep link banner：始终显示，说明来源
- 超长提示（>1000 字符）：显式警告需滚动查看
- Repo 解析：显示 last fetch 时间，过时警告

#### 隔离

- `--handle-uri` 路径在早期 CLI 处理阶段运行，最小化暴露
- `handleUrlSchemeLaunch()` 仅在 `__CFBundleIdentifier` 匹配时触发
- 协议处理程序独立于主会话运行

## 7. 现状验收标准

### 7.1 功能验收标准

- 协议格式正确解析：`claude-cli://open` 格式支持 `q`、`cwd`、`repo` 参数
- 严格安全验证：拒绝所有 ASCII 控制字符，repo 必须匹配 slug 模式，q 限制 5000 字符，cwd 必须是绝对路径
- 跨平台自动注册：macOS/Linux/Windows 自动注册
- 失败回退策略：权限不足时标记，下次不重试（marker 文件）
- 终端检测与偏好：检测并记住用户偏好的终端
- 纯 argv 优先：纯 argv 路径优先（Ghostty/Alacritty/Kitty/WezTerm/Windows Terminal），避免 shell 解释
- shell 路径后备：shell 路径作为后备（iTerm2/Terminal.app/PowerShell/cmd）
- 安全 banner 显示：显示深层链接来源提示
- 超长提示警告：超长提示时显式警告需滚动查看
- repo 解析：repo 参数通过 githubRepoPaths 解析，不直接作为路径
- Freshness 显示：显示仓库的最后 fetch 时间，过时警告
- macOS 独立 .app trampoline：生成最小化 `Claude Code URL Handler.app`
- Linux .desktop 文件：注册到 `~/.local/share/applications/`
- Windows 注册表：注册到 `HKEY_CURRENT_USER\Software\Classes\`
- 桌面双向链接：支持调用 `claude://` 桌面协议（作为客户端）

### 7.2 行为验收标准

- cwd 必须是绝对路径，拒绝相对路径
- repo 必须匹配 `^[\w.-]+/[\w.-]+$` 格式
- q 超过 5000 字符直接拒绝，不截断
- 所有参数拒绝 ASCII 控制字符
- 每次深层链接启动都显示 banner
- 超长 query（>1000 字符）警告需滚动查看
- 终端偏好被记住，下次优先使用
- 协议注册检查是否已存在且指向当前可执行文件
- 注册失败时创建 marker 文件，下次不重试
- repo 解析取最近使用的克隆
- Freshness 同时检查工作目录 git dir 和 common git dir（工作树情况）

## 8. 代码与测试证据

### 8.1 关键代码证据

协议解析：
- `src/utils/deepLink/parseDeepLink.ts`：`parseDeepLink()`、`buildDeepLink()`

协议处理：
- `src/utils/deepLink/protocolHandler.ts`：`handleDeepLinkUri()`、`handleUrlSchemeLaunch()`、`resolveCwd()`

协议注册：
- `src/utils/deepLink/registerProtocol.ts`：`registerProtocolHandler()`、`isProtocolHandlerCurrent()`、`ensureDeepLinkProtocolRegistered()`

终端启动：
- `src/utils/deepLink/terminalLauncher.ts`：`launchInTerminal()`、终端检测、启动方式选择

终端偏好：
- `src/utils/deepLink/terminalPreference.ts`：`updateDeepLinkTerminalPreference()`、存储/读取偏好

Banner：
- `src/utils/deepLink/banner.ts`：`buildDeepLinkBanner()`、`readLastFetchTime()`

### 8.2 测试覆盖现状

现有测试：当前无专门的 deep-link 测试文件

未覆盖场景：
- 协议解析边界条件测试（无控制字符、cwd 绝对路径、repo 格式、q 长度）
- 终端检测各路径的完整测试（存储偏好、运行进程、已安装应用、回退）
- 纯 argv 路径启动测试（各终端参数约定）
- shell 路径引用测试（各 shell 的引用策略）
- 跨平台协议注册测试（macOS .app、Linux .desktop、Windows 注册表）
- 注册失败回退测试（权限不足、marker 文件）
- repo 解析测试（githubRepoPaths 查找、多克隆选择最近使用）
- Freshness 读取测试（FETCH_HEAD mtime、common git dir）
- banner 显示测试（来源提示、超长警告、freshness 显示）
- 桌面双向链接测试（`claude://` 调用）
- 路径转换测试（Windows POSIX ↔ native）

## 9. 文件覆盖与相关子系统

### 9.1 源文件覆盖

| 文件 | 主要职责 | 公开接口 |
|------|---------|---------|
| `src/utils/deepLink/parseDeepLink.ts` | 协议解析 | `parseDeepLink()`、`buildDeepLink()` |
| `src/utils/deepLink/protocolHandler.ts` | 协议处理 | `handleDeepLinkUri()`、`handleUrlSchemeLaunch()` |
| `src/utils/deepLink/registerProtocol.ts` | 协议注册 | `registerProtocolHandler()`、`ensureDeepLinkProtocolRegistered()` |
| `src/utils/deepLink/terminalLauncher.ts` | 终端启动 | `launchInTerminal()` |
| `src/utils/deepLink/terminalPreference.ts` | 终端偏好 | `updateDeepLinkTerminalPreference()` |
| `src/utils/deepLink/banner.ts` | Banner 构建 | `buildDeepLinkBanner()`、`readLastFetchTime()` |

### 9.2 相关子系统

- 配置系统：`config.ts` 存储终端偏好
- GitHub 仓库路径：`githubRepoPaths.ts` 用于 repo 参数解析
- Sanitize：`sanitize.ts` 用于 unicode 清理
- 后台维护：`backgroundHousekeeping.ts` 调用协议注册
- 主入口：`main.tsx` 早期 CLI 处理阶段处理 `--handle-uri`
- 桌面集成：`desktopDeepLink.ts` 用于反向 `claude://` 协议调用

[Coverage](../../architecture/coverage/deep-link.yaml)

## 10. 改进建议

### 10.1 短期改进

- 为 Deep Link 系统增加完整的测试覆盖，特别是协议解析、终端启动、注册流程
- 增加自定义终端路径配置：允许用户配置自定义终端路径
- 增加协议注册用户确认：注册前询问用户，而不是静默自动处理
- 改进错误信息：为常见失败场景提供更友好的诊断和修复建议
- 增加协议调试模式：提供更详细的执行日志，便于调试
- 增加更多终端支持：支持更多终端（如 Hyper、Terminator 等）

### 10.2 中期改进

- 支持更多动作：如 `new`（新建项目）、`search`（搜索代码）、`share`（分享会话）
- 支持更多参数：如 `agent`（指定 agent）、`tools`（启用工具）、`instructions`（加载指令）
- 支持自定义协议处理器：允许用户注册自定义协议处理器
- 增加协议版本控制：支持协议版本升级和向后兼容
- 增加协议签名验证：支持验证链接来源，防止伪造
- 增加链接历史：记录深层链接历史，用户可重新打开
- 增加链接预览：在打开前显示链接内容预览

### 10.3 长期考虑

- 通用 URI 处理框架：支持更多协议（如 `claude-code://`）
- 跨应用会话传输：支持完整会话的深层链接传输
- 协作链接：支持多人协作的深层链接
- 插件集成：允许插件注册自定义协议处理
- 跨平台协议标准：定义行业标准的 Claude 协议
- 端到端加密链接：支持加密链接内容
- 链接权限控制：支持链接过期、使用次数限制等权限控制
- 链接分析：提供链接使用统计和分析
