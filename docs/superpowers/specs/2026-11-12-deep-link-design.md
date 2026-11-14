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

- **跨平台协议注册**：macOS 需要 .app bundle，Linux 需要 .desktop 文件，Windows 需要注册表修改
- **安全验证**：URL 参数可能包含恶意字符，需要严格验证和 sanitize
- **终端检测与偏好**：不同用户使用不同终端，需要检测并记住偏好
- **用户确认**：需要明确告知用户会话来自外部链接，防止隐藏提示注入
- **无终端环境**：协议处理程序可能在 headless 环境运行，需要能检测并启动用户偏好的终端
- **路径处理**：Windows 需要处理 POSIX 路径与 native 路径转换，Git Bash vs PowerShell vs cmd 差异
- **仓库解析**：repo 参数不直接作为路径，通过已有的 `githubRepoPaths` 配置查找本地克隆
- **Freshness 显示**：需要显示仓库的最后 fetch 时间，过时警告
- **协议格式统一**：需要简单清晰的协议格式，便于外部应用构造
- **桌面双向链接**：除了 `claude-cli://` 用于 CLI，还有反向的 `claude://` 用于桌面应用
- **防止覆盖**：协议注册需要检查是否已存在，避免覆盖其他应用的注册
- **权限限制**：注册表修改可能需要管理员权限，需要处理权限不足的情况

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

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 协议格式采用单一动作路径 `open` | `claude-cli://open?{q}{&cwd}{&repo}` | 简单清晰，未来可扩展其他动作 | REST 风格路径如 `/open/repo/{owner}/{name}`：复杂，解析错误率高 | 限制当前功能集，但预留扩展空间 | `src/utils/deepLink/parseDeepLink.ts:35-41` |
| 严格安全验证，白名单字符集 | 拒绝所有 ASCII 控制字符，repo 必须匹配 slug 模式，q 限制 5000 字符，cwd 必须是绝对路径 | 防止命令注入和恶意提示注入，超过 5000 字符很难在用户不注意的情况下隐藏恶意内容 | 只做 sanitize 不拒绝：可能在某些边缘 shell 场景出问题；完全禁止 q 参数：功能受限 | 某些超长合法提示无法使用，但用户体验更安全 | `src/utils/deepLink/parseDeepLink.ts:33-41,50-50,113-159` |
| 终端检测分层：存储偏好 > 运行进程 > 已安装应用 | macOS 下先读取用户之前存储的偏好，否则检测正在运行的终端，再通过 mdfind/ls 检查已安装应用 | 优先用户选择，其次按实际使用习惯，最后回退到系统默认 | 只用固定优先级列表：不能适应不同用户的真实偏好 | 需要存储状态，增加复杂度 | `src/utils/deepLink/terminalPreference.ts:38-54` + `src/utils/deepLink/terminalLauncher.ts:64-121` |
| macOS 注册创建独立 .app trampoline | 生成最小化 `Claude Code URL Handler.app`，仅含 Info.plist 和指向 claude 的 symlink | 避免重新签名完整应用，利用现有 LaunchServices 机制 | 直接在主应用注册：需要重新签名，对非安装版不友好 | 需要维护额外的 bundle 结构 | `src/utils/deepLink/registerProtocol.ts:72-138` |
| 安全 banner 强制显示来源提示 | 启动时显示醒目标题，说明来自外部链接，超长 q 时额外警告需滚动查看 | 防止用户误按回车执行注入的提示 | 完全阻塞：不友好；只在有 q 时显示：cwd 跳转也应让用户感知 | 每次深层链接启动都有 banner，增加用户确认步骤 | `src/utils/deepLink/banner.ts:43-75` |
| repo 参数通过 githubRepoPaths 解析，不直接作为路径 | repo 参数不直接作为路径，通过已有的 `githubRepoPaths` 配置查找本地克隆（取最近使用的） | 防止路径遍历，且支持一个仓库有多个克隆的情况 | 允许 repo 直接映射到路径：安全风险高 | 需要依赖现有映射机制 | `src/utils/deepLink/protocolHandler.ts:116-136` |
| 终端启动优先纯 argv 路径，shell 路径作为后备 | Ghostty/Alacritty/Kitty/WezTerm/Windows Terminal 使用纯 argv 路径；iTerm2/Terminal.app/PowerShell/cmd 使用 shell 路径 | 纯 argv 路径安全，无 shell 解释；shell 路径兼容性好 | 只用 shell 路径：安全风险高；只用纯 argv 路径：某些终端不支持 | 需要为每个终端处理不同参数约定 | `src/utils/deepLink/terminalLauncher.ts:64-121` |
| 注册失败时标记，下次不重试 | marker 文件标记注册失败，下次启动跳过 | 避免重复失败提示用户，静默失败不影响使用 | 每次都尝试：用户体验差，每次启动都看到错误 | 可能错过后续权限恢复后的注册机会 | `src/utils/deepLink/registerProtocol.ts:72-138` |
| 协议注册检查是否已存在且指向当前可执行文件 | isProtocolHandlerCurrent 检查是否已注册且指向 claude | 不覆盖其他应用的注册；不重复注册相同版本 | 总是覆盖：可能破坏其他应用；总是跳过：新版本无法注册 | 需要检查现有注册状态 | `src/utils/deepLink/registerProtocol.ts:72-138` |

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
- **macOS 独立 .app trampoline**：生成最小化 `Claude Code URL Handler.app`
- **Linux .desktop 文件**：注册到 `~/.local/share/applications/`
- **Windows 注册表**：注册到 `HKEY_CURRENT_USER\Software\Classes\`
- **桌面双向链接**：支持调用 `claude://` 桌面协议（作为客户端）

### 非目标

- 不支持其他动作如 `new` 或 `search`（当前不需要）
- 不需要用户手动确认注册（静默自动处理）
- 不支持自定义终端路径配置
- 不需要用户再次确认才能继续（只显示提示）
- 不实现 `claude://` 桌面协议的服务端（只作为客户端调用桌面）
- 不跨会话记住 repo 解析结果（每次重新解析）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 协议解析
function parseDeepLink(uri: string): DeepLinkAction
function buildDeepLink(action: DeepLinkAction): string

// 协议处理
async function handleDeepLinkUri(uri: string): Promise<number>
async function handleUrlSchemeLaunch(): Promise<number | null>

// 协议注册
async function registerProtocolHandler(claudePath?: string): Promise<void>
async function isProtocolHandlerCurrent(claudePath: string): Promise<boolean>
async function ensureDeepLinkProtocolRegistered(): Promise<void>

// 终端启动
async function launchInTerminal(
  claudePath: string,
  action: { query?: string; cwd?: string; repo?: string; lastFetchMs?: number }
): Promise<boolean>

// Banner
function buildDeepLinkBanner(info: DeepLinkBannerInfo): string
async function readLastFetchTime(cwd: string): Promise<Date | undefined>

// 终端偏好
function updateDeepLinkTerminalPreference(): void
```

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `parseDeepLink.ts` | 无（纯函数） | `parseDeepLink`、`buildDeepLink` | 实际协议处理 | 接收 URI，返回 `DeepLinkAction` |
| `protocolHandler.ts` | 无（纯函数） | `handleDeepLinkUri`、`handleUrlSchemeLaunch`、`resolveCwd` | 终端启动 | 接收 URI，返回 exit code |
| `registerProtocol.ts` | marker 文件（磁盘） | `registerProtocolHandler`、`isProtocolHandlerCurrent`、`ensureDeepLinkProtocolRegistered` | 协议处理 | 接收 claudePath，返回 Promise |
| `terminalLauncher.ts` | 无（纯函数） | `launchInTerminal`、终端检测、启动方式选择 | 协议解析 | 接收 claudePath 和 action，返回 boolean |
| `terminalPreference.ts` | config（用户设置） | `updateDeepLinkTerminalPreference`、存储/读取偏好 | 实际终端启动 | 读取/写入 config |
| `banner.ts` | 无（纯函数） | `buildDeepLinkBanner`、`readLastFetchTime` | 实际 UI 渲染 | 接收 info，返回 string |
| `desktopDeepLink.ts` | 无（纯函数） | 桌面双向链接（claude://） | 协议注册 | 调用桌面应用 |
| `DesktopHandoff.tsx` | 无（React 组件） | /desktop 命令的 UI 交互流程 | 协议处理 | 渲染 UI |

### 4.3 主控制流

深层链接处理流程：

```text
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
  ├─ 读取用户偏好（如有）
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
  ├─ 显示 repo freshness（如有）
  └─ 超长 query 警告需滚动查看
```

协议注册流程：

```text
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
  │   ├─ 写入 MIME=x-scheme-handler/claude-cli
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

### 4.4 数据结构与持久化

URI 结构：

```text
claude-cli://open[?q=<query>][&cwd=<absolute-path>][&repo=<owner>/<name>]
```

验证规则：

- `cwd`：必须为绝对路径（`/` 开头或 Windows 驱动器如 `C:\`），无控制字符，长度 ≤ 4096
- `repo`：必须匹配 `^[\w.-]+/[\w.-]+$`
- `q`：无控制字符，长度 ≤ 5000，经过 `partiallySanitizeUnicode` 清理
- 任何验证失败：拒绝整个链接，返回错误码

终端启动策略：

macOS 优先顺序：
1. 存储的用户偏好（来自之前在终端中的运行）
2. 正在运行的终端检测
3. 已安装应用检查（mdfind Spotlight 搜索，回退到 ls /Applications）
4. 最终回退到 Terminal.app

纯 argv vs shell 路径：

纯 argv（安全，无 shell 解释）：
- Ghostty：`open -na Ghostty --args --window-save-state=never --working-directory=<cwd> -e <claude> <args>`
- Alacritty：`open -na Alacritty --args --working-directory <cwd> -e <claude> <args>`
- Kitty/WezTerm：类似，各终端有自己的参数约定
- Linux：所有终端都通过 `-e` 或等效参数直接 exec
- Windows Terminal：`wt -d <cwd> -- <claude> <args>`

Shell 路径（需要 careful quoting）：
- iTerm2：AppleScript `write text`（shell 命令字符串）
- Terminal.app：AppleScript `do script`
- PowerShell：`-Command "& '<claude>' <args>"`（单引号 PowerShell 字符串）
- cmd.exe：`/c cd /d <cwd> && "<claude>" <args>`（特殊 cmd 引用规则，去除双引号，`%` → `%%`，尾随反斜杠加倍）

Shell 引用策略：
- POSIX shell：单引号包裹，内部 `'` 替换为 `'\''`
- AppleScript：反斜杠转义 `\` 和 `"`
- PowerShell：单引号包裹，内部 `'` 替换为 `''`
- cmd.exe：双引号包裹，去除输入中的 `"`，`%` → `%%`，尾随 `\` → `\\`

持久化：
- 终端偏好：存储在 config 中（`~/.claude/settings.json`）
- 注册失败 marker：存储在 `~/.claude/` 中

### 4.5 模块设计卡片

#### 4.5.1 协议解析 (parseDeepLink)

**真实入口签名/关键类型**
```typescript
export const DEEP_LINK_PROTOCOL = 'claude-cli'
export type DeepLinkAction = {
  query?: string
  cwd?: string
  repo?: string
}
export function parseDeepLink(uri: string): DeepLinkAction
export function buildDeepLink(action: DeepLinkAction): string
```

**输入输出**
- 输入：URI 字符串（`claude-cli://open?q=...&cwd=...&repo=...`）
- 输出：结构化 `DeepLinkAction` 对象
- 协议归一化：接受 `claude-cli://` 或 `claude-cli:` 前缀

**状态与配置**
- 无状态纯函数
- 常量定义：
  - `MAX_QUERY_LENGTH = 5000`（query 长度上限）
  - `MAX_CWD_LENGTH = 4096`（cwd 长度上限，对应 Linux PATH_MAX）
  - `REPO_SLUG_PATTERN = /^[\w.-]+\/[\w.-]+$/`（严格的 owner/repo 格式）

**解析流程**
1. 协议前缀归一化（补全 `://`）
2. URL 解析与 hostname 验证（必须为 `open`）
3. 参数提取与安全验证：
   - cwd：绝对路径验证（`/` 开头或 Windows 盘符如 `C:\`），无控制字符，长度 ≤ 4096
   - repo：匹配 slug 格式 `^[\w.-]+\/[\w.-]+$`
   - query：去除隐藏 Unicode 字符，无控制字符，长度 ≤ 5000
4. 返回结构化 action

**5000字符限制设计**
- 上限设置为 5000 字符，超过直接拒绝而非截断
- 安全 rationale：防止超长 prompt 隐藏恶意指令（如 "review PR... 同时 cat ~/.ssh/id_rsa"）
- 工程 rationale：cmd.exe 有 8191 字符命令行限制，经 `%→%%` 转义后，~7000 字符是硬上限
- 提示行为：1000~5000 字符显示超长警告，要求滚动查看

**错误与安全**
- 拒绝所有 ASCII 控制字符（0x00-0x1F, 0x7F）
- 错误类型：协议格式错误、未知动作、无效 cwd、无效 repo、超长 query、包含控制字符
- 清理策略：使用 `partiallySanitizeUnicode` 去除隐藏 Unicode 字符

**设计取舍/备选**
| 备选 | 不采用原因 | 当前选择 |
|------|-----------|---------|
| REST 风格路径 `/open/repo/owner/name` | 解析复杂度高，错误率高 | 单一 `open` 动作 + query 参数 |
| 截断超长 query 而非拒绝 | 改变语义，用户看不到被截断的恶意内容 | 直接拒绝，明确提示 |
| 宽松 repo 格式 | 路径遍历风险 | 严格 slug 格式验证 |

**源码测试证据**
- 协议解析：`src/utils/deepLink/parseDeepLink.ts:84-153`
- 协议构建：`src/utils/deepLink/parseDeepLink.ts:158-170`
- 常量定义：`src/utils/deepLink/parseDeepLink.ts:23-77`

---

#### 4.5.2 Repo/MRU 选择 (resolveCwd)

**真实入口签名/关键类型**
```typescript
async function resolveCwd(action: {
  cwd?: string
  repo?: string
}): Promise<{ cwd: string; resolvedRepo?: string }>
```

**输入输出**
- 输入：`DeepLinkAction`（可选 cwd、可选 repo）
- 输出：`{ cwd: 绝对路径; resolvedRepo?: slug }`
- resolvedRepo 仅当通过 repo lookup 命中时返回，用于显示仓库 freshness

**状态与配置**
- 依赖 `githubRepoPathMapping.ts` 的 `getKnownPathsForRepo()` 和 `filterExistingPaths()`
- 无自身持久化状态，每次重新解析

**选择流程（优先级从高到低）**
1. 显式 cwd → 直接使用（已在 parseDeepLink 验证为绝对路径）
2. repo 参数 → 通过 `githubRepoPaths` 查找本地克隆
   - `getKnownPathsForRepo(repo)` 获取已知路径列表
   - `filterExistingPaths()` 过滤出存在的路径
   - 取第一个（MRU 顺序）
3. 两者都不提供 → 回退到 `homedir()`

**Repo 多克隆选择**
- repo 参数不直接作为路径，通过已有的 `githubRepoPaths` 配置查找
- 支持一个仓库有多个克隆的情况
- `githubRepoPaths` 返回的列表已经是 MRU 排序
- 未找到本地克隆不是错误 → 静默回退到 home，仍能启动 Claude

**错误与安全**
- 安全：repo 从不直接映射到路径，防止路径遍历
- 降级：repo 未找到时回退到 home 而非失败
- 日志：记录 repo → 路径的映射或未找到的回退

**设计取舍/备选**
| 备选 | 不采用原因 | 当前选择 |
|------|-----------|---------|
| 允许 repo 直接作为路径 | 安全风险高 | 通过 githubRepoPaths 间接查找 |
| repo 未找到时失败 | 体验差，web 链接引用未克隆的仓库应仍能打开 | 回退到 home |
| 记住 repo 解析结果 | 跨会话可能过时 | 每次重新解析 |

**源码测试证据**
- resolveCwd：`src/utils/deepLink/protocolHandler.ts:117-136`
- githubRepoPaths：`src/utils/githubRepoPathMapping.ts`（被调用）

---

#### 4.5.3 终端偏好持久化 (terminalPreference)

**真实入口签名/关键类型**
```typescript
export function updateDeepLinkTerminalPreference(): void
```

**输入输出**
- 输入：`process.env.TERM_PROGRAM`（隐式）
- 输出：写入 `config.deepLinkTerminal`（无返回值）
- 仅 macOS 生效，其他平台无操作

**状态与配置**
- 持久化：存储在 `~/.claude/settings.json` 的 `deepLinkTerminal` 字段
- 映射表：`TERM_PROGRAM_TO_APP` 将终端自报告值映射到 launchMacosTerminal 使用的 app 名称
  - `iterm` / `iterm.app` → `iTerm`
  - `ghostty` → `Ghostty`
  - `kitty` → `kitty`
  - `alacritty` → `Alacritty`
  - `wezterm` → `WezTerm`
  - `apple_terminal` → `Terminal`

**macOS 偏好持久化流程**
1. 仅在 `process.platform === 'darwin'` 时执行
2. 读取 `TERM_PROGRAM` 环境变量
3. 查找映射表得到 app 名称
4. 与当前配置比较，避免重复写入
5. 调用 `saveGlobalConfig()` 持久化

**设计 rationale**
- 深层链接处理在 headless 环境运行（LaunchServices/xdg），`TERM_PROGRAM` 未设置
- 无此偏好时只能回退到静态优先级列表，往往不是用户实际使用的终端
- 在交互式启动时捕获并存储，供后续深层链接使用

**错误与安全**
- 无错误抛出，静默失败
- 仅写入已知映射的值，避免任意值污染配置

**设计取舍/备选**
| 备选 | 不采用原因 | 当前选择 |
|------|-----------|---------|
| 所有平台存储偏好 | Linux/Windows 检测逻辑不需要 | 仅 macOS |
| 每次启动都写入 | 不必要的 I/O | 仅在变化时写入 |

**源码测试证据**
- updateDeepLinkTerminalPreference：`src/utils/deepLink/terminalPreference.ts:38-54`
- 映射表：`src/utils/deepLink/terminalPreference.ts:18-26`

---

#### 4.5.4 会话路由/终端启动 (terminalLauncher)

**真实入口签名/关键类型**
```typescript
export type TerminalInfo = { name: string; command: string }
export async function detectTerminal(): Promise<TerminalInfo | null>
export async function launchInTerminal(
  claudePath: string,
  action: { query?: string; cwd?: string; repo?: string; lastFetchMs?: number }
): Promise<boolean>
```

**输入输出**
- 输入：claude 可执行路径、DeepLinkAction
- 输出：boolean（是否成功启动）
- 最终启动的 Claude 携带参数：`--deep-link-origin [--deep-link-repo repo] [--deep-link-last-fetch ms] [--prefill query]`

**终端检测策略（分平台）**

macOS 优先级（`detectMacosTerminal`）：
1. 存储的用户偏好（`config.deepLinkTerminal`）
2. `TERM_PROGRAM` 环境变量
3. Spotlight 搜索已安装的终端（mdfind kMDItemCFBundleIdentifier）
4. 直接检查 `/Applications` 目录
5. 最终回退：Terminal.app

Linux 优先级（`detectLinuxTerminal`）：
1. `$TERMINAL` 环境变量
2. `x-terminal-emulator`（Debian/Ubuntu 备选）
3. 静态优先级列表：ghostty, kitty, alacritty, wezterm, gnome-terminal, konsole, xfce4-terminal, mate-terminal, tilix, xterm

Windows 优先级（`detectWindowsTerminal`）：
1. Windows Terminal (wt.exe)
2. PowerShell 7+ (pwsh.exe)
3. Windows PowerShell 5.1 (powershell.exe)
4. 最终回退：cmd.exe

**启动方式：纯 argv 优先 vs shell 路径后备**

纯 argv 路径（安全，无 shell 解释）：
- macOS：Ghostty, Alacritty, Kitty, WezTerm → `open -na App --args` 直接传 argv
- Linux：所有终端 → 使用各自的 `--working-directory` + `-e` 直接 exec
- Windows：Windows Terminal → `wt -d cwd -- claude args`

Shell 路径（需要每层正确引用）：
- macOS：iTerm2, Terminal.app → AppleScript `write text` / `do script`（无 argv 接口）
- Windows：PowerShell → `-Command "& 'claude' args"`（单引号 PowerShell 字符串）
- Windows：cmd.exe → `/k cd /d cwd && "claude" args`（特殊 cmd 引用规则）

**cmd.exe 引号策略**
- cmd.exe 不使用 MSVCRT 风格的反斜杠转义，而是在每个 `"` 字符切换引用状态
- 策略：
  1. 去除输入中的 `"`（无法在 cmd.exe 双引号字符串中安全表示）
  2. `%` → `%%`（防止环境变量展开，cmd.exe 在双引号内仍展开）
  3. 尾随反斜杠加倍（子进程 claude.exe 使用 CommandLineToArgvW，尾随 `\` 会吃掉结束引号）
- Node.js spawn：启用 `windowsVerbatimArguments` 绕过 libuv 的默认 MSVCRT 引用

**各终端引用规则**
- POSIX shell：单引号包裹，内部 `'` 替换为 `'\''`
- AppleScript：反斜杠转义 `\` 和 `"`
- PowerShell：单引号包裹，内部 `'` 替换为 `''`
- cmd.exe：如上所述

**错误与安全**
- 失败回退：macOS 终端启动失败时回退到 Terminal.app
- 安全边界：纯 argv 路径是强安全边界，用户输入从不接触解释器
- 日志：记录检测到的终端和启动尝试
- spawn 错误：resolve(false) 而非 throw，调用方显示友好错误

**设计取舍/备选**
| 备选 | 不采用原因 | 当前选择 |
|------|-----------|---------|
| 仅使用 shell 路径 | 安全风险高 | 纯 argv 优先，shell 后备 |
| 仅使用纯 argv | 部分终端无接口 | 按终端支持情况选择 |
| cmd.exe 尝试保留 " | 无法安全表示，会导致命令注入 | 去除 " |

**源码测试证据**
- launchInTerminal：`src/utils/deepLink/terminalLauncher.ts:214-253`
- detectTerminal：`src/utils/deepLink/terminalLauncher.ts:183-194`
- macOS 终端列表：`src/utils/deepLink/terminalLauncher.ts:28-43`
- Linux 终端列表：`src/utils/deepLink/terminalLauncher.ts:46-57`
- cmdQuote：`src/utils/deepLink/terminalLauncher.ts:553-557`
- 各平台启动函数：`src/utils/deepLink/terminalLauncher.ts:255-469`

---

#### 4.5.5 平台安全/协议注册 (registerProtocol)

**真实入口签名/关键类型**
```typescript
export const MACOS_BUNDLE_ID = 'com.anthropic.claude-code-url-handler'
export async function registerProtocolHandler(claudePath?: string): Promise<void>
export async function isProtocolHandlerCurrent(claudePath: string): Promise<boolean>
export async function ensureDeepLinkProtocolRegistered(): Promise<void>
```

**输入输出**
- 输入：可选 claudePath（默认自动解析）
- 输出：无，静默失败
- 自动解析优先：`~/.local/bin/claude`（稳定符号链接，自动更新后仍然有效），回退到 `process.execPath`

**平台注册机制**

macOS：
- 创建独立 `.app` trampoline：`~/Applications/Claude Code URL Handler.app`
- `Info.plist` 注册 `claude-cli` scheme
- symlink 指向当前 claude 二进制（避免重新签名完整应用）
- 调用 `lsregister -R` 刷新 LaunchServices

Linux xdg 检测：
- 创建 `.desktop` 文件：`$XDG_DATA_HOME/applications/claude-code-url-handler.desktop`（默认 `~/.local/share/applications/`）
- Exec 行：`"claude" --handle-uri %u`
- MimeType：`x-scheme-handler/claude-cli`
- 调用 `xdg-mime default` 设置为默认处理器
- 容错：`xdg-utils` 未安装时不算失败（headless 环境）

Windows 注册表与路径：
- 写入 `HKEY_CURRENT_USER\Software\Classes\claude-cli`（无需管理员权限）
- 默认值：`URL:Claude Code Deep Link`
- `URL Protocol` 空字符串
- `shell\open\command` 默认值：`"claude" --handle-uri "%1"`
- 使用 `reg add` 命令操作
- Windows 路径支持 POSIX 路径与 native 路径转换（盘符如 `C:\`）

**权限不足冷却机制**
- 确定性失败（`EACCES` / `ENOSPC`）创建 marker 文件：`~/.claude/.deep-link-register-failed`
- 冷却期：`FAILURE_BACKOFF_MS = 24h`
- 下次启动时检查 marker，未过期则跳过
- marker 存在但已过期 → 重试
- 注册成功 → 删除 marker

**幂等性保证**
- `isProtocolHandlerCurrent()` 直接读取平台注册 artifact 而非缓存 flag：
  - macOS：读取 symlink 目标
  - Linux：读取 `.desktop` 文件的 Exec 行
  - Windows：查询注册表值
- 任何读取错误 → false → 重新注册
- 好处：跨机器配置同步不影响、安装路径变化自修复、artifact 删除自修复

**错误与安全**
- 静默失败，不影响主流程
- 仅在 feature flag `tengu_lodestone_enabled` 启用时执行
- 可通过 `disableDeepLinkRegistration` 设置禁用
- 不覆盖其他应用的注册：仅当未注册或指向非当前 claude 时才更新
- macOS 不修改主应用，仅创建独立 trampoline

**设计取舍/备选**
| 备选 | 不采用原因 | 当前选择 |
|------|-----------|---------|
| macOS 直接在主应用注册 | 需要重新签名，对非安装版不友好 | 独立 .app trampoline |
| 总是覆盖现有注册 | 可能破坏其他应用 | 检查是否已指向当前 claude |
| 每次启动都尝试注册 | 权限不足时重复失败用户体验差 | 24h 冷却 |
| 缓存 flag 到配置 | 配置可跨机器同步，OS 状态不能 | 直接读取 artifact |
| Windows 写入 HKLM | 需要管理员权限 | 写入 HKCU |

**源码测试证据**
- ensureDeepLinkProtocolRegistered：`src/utils/deepLink/registerProtocol.ts:298-348`
- registerMacos：`src/utils/deepLink/registerProtocol.ts:75-138`
- registerLinux：`src/utils/deepLink/registerProtocol.ts:144-180`
- registerWindows：`src/utils/deepLink/registerProtocol.ts:185-209`
- isProtocolHandlerCurrent：`src/utils/deepLink/registerProtocol.ts:263-290`
- 冷却常量：`src/utils/deepLink/registerProtocol.ts:54`

---

### 4.6 跨子系统依赖

- **Config**：`config.ts` 存储终端偏好，本文只描述读取/写入接口
- **GitHub Repo Paths**：`githubRepoPaths.ts` 用于 repo 参数解析，本文只描述调用接口
- **Sanitize**：`sanitize.ts` 用于 unicode 清理，本文只描述调用接口
- **Background Housekeeping**：`backgroundHousekeeping.ts` 调用协议注册，本文只描述调用点
- **Main**：`main.tsx` 早期 CLI 处理阶段使用 `--handle-uri`，本文只描述调用点
- **Desktop Deep Link**：`desktopDeepLink.ts` 用于反向 `claude://` 协议调用，本文描述

## 5. 失败语义与工程取舍

### 6.1 失败语义

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 协议解析失败 | parseDeepLink | 显示错误，退出码 1 | 否 | 无 | 用户看到清晰错误提示 |
| 参数验证失败 | parseDeepLink | 显示错误，退出码 1 | 否 | 无 | 用户看到清晰错误提示，说明验证失败原因 |
| q 超过 5000 字符 | parseDeepLink | 直接拒绝，退出码 1 | 否 | 无 | 用户看到清晰长度限制提示 |
| repo 未找到本地克隆 | resolveCwd | 回退到 $HOME，警告用户 | 否 | 无 | 用户看到警告，仍能启动 |
| 终端检测失败 | launchInTerminal | 回退到系统默认终端 | 否 | 无 | 仍能启动，可能不是用户偏好 |
| 终端启动失败 | launchInTerminal | 显示错误，退出码 1 | 否 | 无 | 用户看到清晰错误提示 |
| 协议注册权限不足 | registerProtocolHandler | 标记失败，下次不重试 | 否（下次启动跳过） | 创建 marker 文件 | 静默失败，不影响使用 |
| 协议注册已存在且指向其他版本 | isProtocolHandlerCurrent | 不覆盖，跳过 | 否 | 无 | 不破坏现有配置 |
| git fetch 时间读取失败 | readLastFetchTime | 忽略，不显示 freshness | 否 | 无 | 仍正常启动 |

### 6.2 工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 协议动作设计：单一 `open` 动作 | 简单清晰，预留扩展空间 | 限制当前功能集，但预留扩展空间 | 简单清晰，未来可扩展其他动作 |
| 参数验证策略：严格白名单 + 长度限制 | 安全优先，防止注入 | 某些超长合法提示无法使用 | 安全优先，防止注入 |
| 终端启动方式：纯 argv 优先，shell 后备 | 安全第一，无 shell 解释 | 需要为每个终端处理不同参数约定 | 安全第一，无 shell 解释 |
| macOS 注册方式：独立 .app trampoline | 避免重新签名主应用 | 需要维护额外 bundle 结构 | 避免重新签名主应用 |
| 注册失败策略：Marker 文件标记，下次不重试 | 避免重复失败提示用户 | 可能错过后续权限恢复后的注册机会 | 避免重复失败提示用户 |
| repo 解析策略：通过 githubRepoPaths 查找 | 安全，支持多克隆 | 需要依赖现有映射机制 | 安全，支持多克隆 |
| banner 策略：强制显示，不提供跳过 | 安全第一，防止注入 | 每次都有 banner，增加确认步骤 | 安全第一，防止注入 |
| 超长 q 策略：直接拒绝，不截断 | 防止用户错过截断后的恶意内容 | 某些超长合法提示无法使用 | 防止用户错过截断后的恶意内容 |

### 6.3 安全考虑

参数验证：
- 所有输入：拒绝 ASCII 控制字符（0x00-0x1F, 0x7F）
- cwd：必须是绝对路径，限制 4096 字符
- repo：严格 owner/name 格式
- q：5000 字符上限，部分清理 unicode 隐藏字符

注入防护：
- 优先纯 argv 路径：用户输入不经过 shell 解释
- Shell 路径：每层都正确引用（shell quote → AppleScript quote，等）
- cmd.exe：特殊处理，去除 `"`，`%` → `%%`

用户感知：
- Deep link banner：始终显示，说明来源
- 超长提示（> 1000 字符）：显式警告需滚动查看
- Repo 解析：显示 last fetch 时间，过时警告

隔离：
- `--handle-uri` 路径在早期 CLI 处理阶段运行，最小化暴露
- `handleUrlSchemeLaunch()` 仅在 `__CFBundleIdentifier` 匹配时触发
- 协议处理程序独立于主会话运行

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| `claude-cli://open?q=hello` | 点击链接 | 协议正确解析，q 参数提取为 "hello" | 不能接受 q 超过 5000 字符 |
| `claude-cli://open?cwd=/absolute/path` | 点击链接 | cwd 正确解析，使用 /absolute/path | 不能接受相对路径 |
| `claude-cli://open?repo=owner/repo` | 点击链接且本地有克隆 | repo 通过 githubRepoPaths 解析，取最近使用的克隆 | 不能直接将 repo 作为路径 |
| 所有参数包含 ASCII 控制字符 | 点击链接 | 链接被拒绝 | 不能接受控制字符 |
| 用户有终端偏好存储 | 点击链接 | 使用存储的偏好终端 | 不能忽略用户偏好 |
| 用户没有终端偏好但有终端在运行 | 点击链接 | 使用正在运行的终端 | 不能跳过检测正在运行的终端 |
| macOS 注册 | backgroundHousekeeping | 创建 `Claude Code URL Handler.app` | 不能修改主应用 |
| Linux 注册 | backgroundHousekeeping | 创建 .desktop 文件到 `~/.local/share/applications/` | 不能修改系统级文件 |
| Windows 注册 | backgroundHousekeeping | 写入 `HKEY_CURRENT_USER\Software\Classes\` | 不能需要管理员权限（写入 HKCU） |
| 注册失败（权限不足） | backgroundHousekeeping | 创建 marker 文件，下次跳过 | 不能每次都尝试注册 |
| 超长 q（> 5000 字符） | 点击链接 | 直接拒绝 | 不能截断 q |
| 超长 q（> 1000 字符但 ≤ 5000） | 点击链接 | 显示 banner，警告需滚动查看 | 不能静默接受超长 q |
| repo 解析有本地克隆 | 点击链接 | 显示 last fetch 时间 | 不能跳过 freshness 检查 |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 协议格式正确解析 | `src/utils/deepLink/parseDeepLink.ts:35-41` | 需补充测试 | 未找到直接测试覆盖 |
| 严格安全验证 | `src/utils/deepLink/parseDeepLink.ts:33-41,50-50,113-159` | 需补充测试 | 未找到直接测试覆盖 |
| 终端检测分层 | `src/utils/deepLink/terminalPreference.ts:38-54` + `src/utils/deepLink/terminalLauncher.ts:64-121` | 需补充测试 | 未找到直接测试覆盖 |
| macOS 独立 .app trampoline | `src/utils/deepLink/registerProtocol.ts:72-138` | 需补充测试 | 未找到直接测试覆盖 |
| 安全 banner 强制显示 | `src/utils/deepLink/banner.ts:43-75` | 需补充测试 | 未找到直接测试覆盖 |
| repo 参数通过 githubRepoPaths 解析 | `src/utils/deepLink/protocolHandler.ts:116-136` | 需补充测试 | 未找到直接测试覆盖 |

### 8.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/utils/deepLink/parseDeepLink.ts` | `parseDeepLink`、`buildDeepLink` | 协议解析与构建 |
| `src/utils/deepLink/protocolHandler.ts` | `handleDeepLinkUri`、`handleUrlSchemeLaunch`、`resolveCwd` | 协议处理主流程 |
| `src/utils/deepLink/registerProtocol.ts` | `registerProtocolHandler`、`isProtocolHandlerCurrent`、`ensureDeepLinkProtocolRegistered` | 跨平台协议注册 |
| `src/utils/deepLink/terminalLauncher.ts` | `launchInTerminal`、终端检测、启动方式选择 | 终端启动与检测 |
| `src/utils/deepLink/terminalPreference.ts` | `updateDeepLinkTerminalPreference`、存储/读取偏好 | 终端偏好管理 |
| `src/utils/deepLink/banner.ts` | `buildDeepLinkBanner`、`readLastFetchTime` | Banner 构建与 freshness 读取 |
| `src/utils/desktopDeepLink.ts` | 桌面双向链接（claude://） | 桌面应用双向链接 |
| `src/components/DesktopHandoff.tsx` | /desktop 命令的 UI 交互流程 | 桌面切换 UI |

### 8.2 未覆盖行为（基于代码阅读）

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

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/deep-link.yaml)

### 9.1 本 spec 主拥有的文件组

| 分组 | 主拥有职责 |
|---|---|
| deep-link-parse | 深层链接协议解析与验证，参数安全检查 |
| deep-link-protocol | 协议处理主流程、cwd 解析、终端启动协调 |
| deep-link-register | 跨平台协议注册、当前状态检查、自动注册逻辑 |
| deep-link-terminal | 终端检测与偏好、跨终端启动策略、shell 引用 |
| deep-link-banner | 深层链接来源 banner 构建、仓库 freshness 读取 |
| desktop-deep-link | 桌面应用双向深层链接（claude://）、会话转移 |
| desktop-handoff | /desktop 命令的 UI 交互流程 |

### 9.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/config.ts` → 主归 settings spec，本文只描述读取/写入终端偏好
- `src/utils/githubRepoPaths.ts` → 主归其他 spec，本文只描述调用接口
- `src/utils/sanitize.ts` → 主归其他 spec，本文只描述调用接口
- `src/utils/backgroundHousekeeping.ts` → 主归其他 spec，本文只描述调用点
- `src/main.tsx` → 主归其他 spec，本文只描述早期 CLI 处理阶段

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 已证实测试缺口大（第 7 节无测试） | 补充核心路径单元测试：协议解析、终端启动、注册流程 | 低（新增测试） | 每个核心模块有对应测试文件，覆盖主要路径和边界情况 | M | 设计推断 |
| P2 | 增加自定义终端路径配置：当前不支持用户配置自定义终端路径 | 增加自定义终端路径配置 | 低（新增功能，不改变现有行为） | 用户可以配置自定义终端路径 | S | 设计推断 |
| P2 | 增加协议注册用户确认：当前静默自动处理注册 | 注册前询问用户，而不是静默自动处理 | 中（改变现有行为，但可 feature gate） | 用户可以确认或拒绝协议注册 | M | 设计推断 |
| P2 | 改进错误信息：当前某些错误信息不够友好 | 为常见失败场景提供更友好的诊断和修复建议 | 低（只改变错误信息） | 用户看到更清晰的错误提示和修复建议 | S | 设计推断 |
| P3 | 增加协议调试模式：当前难以调试协议处理问题 | 提供更详细的执行日志，便于调试 | 低（新增功能） | 开发者可以查看详细的协议处理日志 | S | 设计推断 |
| P3 | 增加更多终端支持：当前支持有限的终端 | 支持更多终端（如 Hyper、Terminator 等） | 低（新增功能） | 更多终端可以被检测和使用 | M | 设计推断 |
| P3 | 支持更多动作：当前只支持 `open` | 支持更多动作如 `new`（新建项目）、`search`（搜索代码）、`share`（分享会话） | 中（需要扩展协议格式） | 新动作可以被正确解析和处理 | M | 设计推断 |
| P3 | 支持更多参数：当前只支持 q、cwd、repo | 支持更多参数如 `agent`（指定 agent）、`tools`（启用工具）、`instructions`（加载指令） | 中（需要扩展协议格式） | 新参数可以被正确解析和处理 | M | 设计推断 |
| P3 | 增加协议版本控制：当前无版本控制 | 支持协议版本升级和向后兼容 | 低（新增功能） | 不同版本的协议可以被正确处理 | M | 设计推断 |
