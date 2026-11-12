---
id: ide-integration
batch: 4
title: IDE Integration 编辑器连接与状态同步设计
date: 2026-11-12
status: draft
---

# IDE Integration 编辑器连接与状态同步设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理""提高可靠性""保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

当用户在 VS Code/Cursor/Windsurf 或 JetBrains IDE 中编辑代码并同时在其内置终端运行 Claude Code 时，需要在终端 UI 中与 IDE 进行双向交互（显示 diff、文件编辑预览、状态通知）。
如果没有统一的发现和连接机制，用户需要手动配置端口或路径，导致首次使用体验断裂；如果在 WSL 环境中路径不转换，会导致打开的文件路径在 IDE 中无效；如果没有降级策略，IDE 断开时会阻塞终端交互流程。
因此本子系统必须在跨平台（macOS/Windows/Linux/WSL）、多 IDE 类型、可选自动连接的约束下完成 IDE 发现、连接选择、diff 同步、终端/编辑器通知和优雅降级的职责。

约束详情：
- 支持 VS Code 系列（VS Code、Cursor、Windsurf）和 JetBrains 系列（IntelliJ、PyCharm、WebStorm、GoLand 等）
- 支持从 IDE 内置终端自动发现（通过 env var 和祖先进程检查），也支持从外部终端手动选择
- 支持 WSL 环境中 Windows IDE 与 WSL Claude Code 的跨环境通信
- SSE 或 WebSocket 两种传输协议（由 lockfile 中的 `transport` 字段决定）
- 自动安装扩展/插件（VS Code 支持，JetBrains 只提示）
- 在滚动渲染期间不执行耗时的 lockfile 扫描，避免卡顿

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 通过 lockfile 进行 IDE 发现 | `~/.claude/ide/<port>.lock` JSON 文件包含 workspaceFolders、pid、ideName、transport、authToken；扫描按 mtime 排序，最新优先 | lockfile 是文件系统级的弱契约，不需要固定端口，支持多 IDE 实例同时存在；通过 mtime 排序自然优先最近使用的 IDE | 固定端口：多个 IDE 实例冲突；环境变量只适用于内置终端；服务发现广播：跨平台复杂且需要权限 | 定期扫描有开销（通过缓存祖先进程和过滤 stale lockfile 缓解） | src/utils/ide.ts:298-344 |
| 路径 NFC 规范化 + Windows/WSL 双转换 | cwd 和 lockfile 中的 workspaceFolders 都 normalize('NFC')；WSL 中使用 WindowsToWSLConverter 双向转换 | macOS 返回 NFD 路径，IDE 报告 NFC 路径，不规范化会导致匹配失败；WSL 中 IDE 运行在 Windows 需要 \\ 路径，Claude Code 在 WSL 需要 / 路径 | 只在比较时规范化：用户可见路径仍可能混乱；假设 \\ 自动转换：不支持 WSL UNC 路径（\\\\wsl$\\distro\\...） | 每个路径比较都要 normalize，WSL 中额外 exec wslpath | src/utils/ide.ts:678-679; src/utils/idePathConversion.ts:25-73 |
| 祖先 PID 检查消歧义 | 从当前 ppid 向上遍历进程树，lockfile 中的 pid 必须在祖先链中才优先选择；只在 supported terminal 且非 WSL 中启用 | 同一用户可能打开多个 IDE 窗口都包含当前 cwd，需要知道是从哪个 IDE 的终端启动的；WSL 中 pid 命名空间不同不可靠 | 只按 workspace 匹配：连接到错误的 IDE 窗口；让用户每次选择：体验差 | 每次 detectIDEs 调用需要 ps/exec（通过 makeAncestorPidLookup 懒加载且缓存单次调用缓解） | src/utils/ide.ts:689-690,770-782 |
| 30 秒轮询 findAvailableIDE + scroll draining 暂停 | findAvailableIDE 循环调用 detectIDEs，每次间隔 1 秒，共 30 秒；getIsScrollDraining() 为 true 时跳过扫描，只 sleep | 启动时 IDE 插件可能还没写入 lockfile，需要等待；扫描涉及 fs I/O 和 ps 调用，会与 scroll 渲染争用事件循环 | 更长间隔：自动连接更慢；不暂停扫描：scroll 掉帧 | 最多延迟 30 秒自动连接；用户可能看到短暂的未连接状态 | src/utils/ide.ts:626-657; src/utils/ide.ts:639-643 |
| stale lockfile 清理策略 | 删除 pid 不存在且端口不响应的 lockfile；WSL 中只在端口不响应时才删除，因为 pid 不可靠 | IDE 崩溃或非正常退出会遗留 lockfile，导致下次扫描到无效 IDE；WSL 中 Windows pid 在 WSL 不可见，不能仅用 pid 判断 | 不清理：累积无效 lockfile，扫描变慢且可能误连；总是删除旧 lockfile：误删正在运行的 IDE（尤其是 WSL） | 每次 detectIDEs 前需要先 cleanupStaleIdeLockfiles，增加一次扫描和端口检测 | src/utils/ide.ts:522-581 |
| diff 同步使用 openDiff RPC + 三种结果消息 | callIdeRpc('openDiff') 传入 old_file_path、new_file_contents、tab_name；等待 FILE_SAVED（接受用户修改）、TAB_CLOSED（接受原样）、DIFF_REJECTED（拒绝） | 用户需要在 IDE 中预览、编辑、确认或拒绝变更；三种消息覆盖主要交互场景；tab_name 用 UUID 前缀避免冲突 | 只在终端显示 diff：无法利用 IDE 的语法高亮和编辑能力；直接写入文件：缺少确认步骤 | 需要维护 IDE 中的 diff tab 生命周期；用户关闭 tab 或保存时需要正确清理 | src/hooks/useDiffInIDE.ts:216-327 |
| VS Code 自动安装扩展，JetBrains 只提示 | isVSCodeIde 时尝试调用 code --install-extension；isJetBrainsIde 时只检查是否已安装，不自动安装 | VS Code 扩展市场公开且 CLI 稳定；JetBrains 插件市场需要 IDE 内安装或手动下载，native build 中不支持自动安装 | JetBrains 也尝试自动安装：成功率低且容易出错；都不自动安装：首次体验差 | 需要处理 VS Code 扩展安装的各种失败（权限、网络、CLI 不可用）；JetBrains 用户需要手动安装 | src/utils/ide.ts:590-622; src/utils/ide.ts:879-911 |
| IDE 连接作为动态 MCP 配置 | setDynamicMcpConfig 添加 'ide' 键，类型为 'sse-ide' 或 'ws-ide'；mcp clients 中出现 type='connected'、name='ide' 的客户端时表示连接成功 | 复用现有 MCP 连接生命周期管理、重连、错误处理逻辑；不需要为 IDE 单独建立一套连接管理 | 独立 IDE 连接管理：重复实现连接、重试、超时逻辑 | IDE 连接状态与 MCP 状态耦合 | src/hooks/useIDEIntegration.tsx:25-88; src/commands/ide/ide.tsx:544-555 |
| 通知系统显示 IDE 状态、错误和提示 | useIDEStatusIndicator 管理 'ide-status-hint'、'ide-status-disconnected'、'ide-status-jetbrains-disconnected'、'ide-status-install-error' 四种通知；ideHintShownCount 限制最多显示 5 次 hint | 用户需要知道 IDE 是否连接、安装是否成功；hint 显示太多次会打扰用户 | 只在 /status 中显示：用户可能注意不到；不限制 hint 次数：用户体验差 | 需要在全局配置中持久化 ideHintShownCount | src/hooks/notifs/useIDEStatusIndicator.tsx:24-159 |
| /ide 命令管理连接、选择 IDE、打开项目 | /ide 显示当前连接状态和可用 IDE 列表；/ide open 打开当前项目在选定 IDE 中 | 用户需要显式控制连接哪个 IDE、断开连接、重新打开项目 | 只自动连接：用户无法选择或切换；分离多个命令：记忆负担重 | 需要维护 IDE 选择 UI、连接状态、超时处理 | src/commands/ide/ide.tsx:315-580 |

## 3. 目标与非目标

### 3.1 状态与生命周期

**目标：**
- 拥有当前选中的 IDE 连接配置（动态 MCP 配置的一部分）
- 拥有 diff tab 的 UUID 和关闭清理逻辑
- 拥有全局配置中的 ideHintShownCount、diffTool、autoConnectIde、autoInstallIdeExtension
- 拥有 lockfile 扫描期间的祖先 PID 缓存（单次调用内有效）

**非目标：**
- 不拥有 IDE 插件/扩展的生命周期（由 IDE 管理）
- 不拥有 MCP 传输层的连接状态（由 MCP 客户端管理）
- 不拥有用户在 IDE 中打开的其他文件 tab（只管理 Claude Code 创建的 diff tab）

### 3.2 接口与数据

**目标：**
- 保证 detectIDEs(includeInvalid) 返回 DetectedIDEInfo[] 包含 url、name、workspaceFolders、isValid
- 保证 showDiffInIDE 返回 {oldContent, newContent} 或抛出错误
- 保证 callIdeRpc 能调用 IDE 端注册的工具（openDiff、closeAllDiffTabs、close_tab 等）
- 保证 lockfile 格式向后兼容（旧格式为纯文本路径列表，新格式为 JSON）

**非目标：**
- 不保证 IDE 插件版本兼容性（旧版本插件可能缺少某些 RPC 方法）
- 不保证 lockfile 在多个 Claude Code 实例间的并发安全（没有文件锁）

### 3.3 执行与环境

**目标：**
- 支持 CLI（内置终端、外部终端）和 SDK 模式（SDK 模式下可能不自动连接）
- 支持 macOS、Windows、Linux、WSL 环境
- 支持 offline 模式（已安装插件时不需要网络）

**非目标：**
- 不支持浏览器环境（IDE 插件只在桌面 IDE 中运行）
- 不支持未安装插件的 IDE（lockfile 不存在）

### 3.4 依赖边界

- **MCP 客户端**：本文描述如何配置 IDE MCP 连接和调用 RPC，主设计由 mcp spec 负责
- **设置系统**：本文描述如何使用和更新 diffTool、autoConnectIde 等配置，主设计由 settings spec 负责
- **权限对话框**：本文描述如何与文件权限对话框集成以在 IDE 中显示 diff，主设计由 permissions spec 负责
- **通知系统**：本文描述如何添加和移除 IDE 相关通知，主设计由 notifications spec 负责

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 发现可用 IDE
async function detectIDEs(includeInvalid: boolean): Promise<DetectedIDEInfo[]>

// 查找并等待一个可用 IDE（最多 30 秒）
async function findAvailableIDE(): Promise<DetectedIDEInfo | null>

// 初始化 IDE 集成（发现、可选安装扩展、回调通知）
async function initializeIdeIntegration(
  onIdeDetected: (ide: DetectedIDEInfo | null) => void,
  ideToInstallExtension: IdeType | null,
  onShowIdeOnboarding: () => void,
  onInstallationComplete: (status: IDEExtensionInstallationStatus | null) => void
): Promise<void>

// 在 IDE 中显示 diff 并等待用户决定
async function showDiffInIDE(
  file_path: string,
  edits: FileEdit[],
  toolUseContext: ToolUseContext,
  tab_name: string
): Promise<{oldContent: string, newContent: string}>

// 调用 IDE RPC 方法
async function callIdeRpc<T>(
  method: string,
  params: unknown,
  ideClient: ConnectedMCPServer
): Promise<T>

// 获取已连接的 IDE 客户端
function getConnectedIdeClient(
  mcpClients?: MCPServerConnection[]
): ConnectedMCPServer | undefined

// 获取已连接的 IDE 名称
function getConnectedIdeName(
  mcpClients: MCPServerConnection[]
): string | null

// 检查是否支持 IDE diff 功能
function hasAccessToIDEExtensionDiffFeature(
  mcpClients: MCPServerConnection[]
): boolean
```

调用方进入方式：
- 启动时：useIDEIntegration hook 调用 initializeIdeIntegration，onIdeDetected 回调中调用 setDynamicMcpConfig
- 用户输入：/ide 命令让用户选择 IDE，调用 onChangeDynamicMcpConfig
- 工具调用：FileEditTool 调用 useDiffInIDE，进而调用 showDiffInIDE

异步行为：
- findAvailableIDE 是轮询循环，内部调用 sleep(1000)，可通过 currentIDESearch AbortController 取消
- showDiffInIDE 等待 IDE 端 RPC 返回，可通过 toolUseContext.abortController 取消
- showDiffInIDE 在进程 beforeExit 时也会尝试清理 tab

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| src/utils/ide.ts | currentIDESearch (AbortController)、cachedRunningIDEs (IdeType[])、detectIDEs 的单次调用内的祖先 PID 缓存 | detectIDEs、findAvailableIDE、cleanupStaleIdeLockfiles、installIDEExtension、getConnectedIdeClient、callIdeRpc | MCP 传输层连接管理、IDE 插件内部逻辑 | 调用 getGlobalConfig/saveGlobalConfig；返回 DetectedIDEInfo 供 useIDEIntegration 使用；调用 callIdeRpc 时需要传入 ConnectedMCPServer |
| src/utils/idePathConversion.ts | 无状态（纯函数和类） | WindowsToWSLConverter.toLocalPath、toIDEPath、checkWSLDistroMatch | 非 WSL 环境的路径转换 | 接收路径字符串，返回转换后的路径字符串 |
| src/hooks/useIDEIntegration.tsx | 无自有状态（通过 setDynamicMcpConfig 修改 AppState） | 初始化 IDE 集成、根据 autoConnect 配置添加动态 MCP 配置 | 不直接调用 IDE RPC（通过 MCP 客户端） | 接收 setDynamicMcpConfig、setShowIdeOnboarding、setIDEInstallationState 回调；依赖 getGlobalConfig、isSupportedTerminal、initializeIdeIntegration |
| src/hooks/useDiffInIDE.ts | isUnmounted ref、sha、tabName、hasError 状态 | showDiffInIDE、computeEditsFromContents、closeTabInIDE | 不管理 IDE 连接生命周期（依赖传入的 toolUseContext.mcpClients） | 接收 toolUseContext、onChange 回调；调用 getConnectedIdeClient、callIdeRpc；使用 getPatchForEdits、getPatchFromContents |
| src/commands/ide/ide.tsx | connectingIDE 状态、isFirstCheckRef | /ide 命令 UI、IDE 选择、连接/断开、打开项目 | 不实现 diff 显示逻辑（由 useDiffInIDE 负责） | 调用 detectIDEs、findAvailableIDE、detectRunningIDEs、maybeInstallIDEExtension；使用 onChangeDynamicMcpConfig、AppState |
| src/hooks/notifs/useIDEStatusIndicator.tsx | hasShownHintRef（单次会话有效） | 添加/移除 IDE 相关通知 | 不决定通知显示优先级（由通知系统决定） | 调用 addNotification、removeNotification；使用 getGlobalConfig/saveGlobalConfig、useIdeConnectionStatus |
| src/components/ShowInIDEPrompt.tsx | 无自有状态（纯展示组件） | 渲染 IDE diff 提示 UI | 不处理 diff 同步逻辑 | 接收 filePath、ideName、onChange、options 等 props |
| src/components/permissions/FilePermissionDialog/ideDiffConfig.ts | 无自有状态（类型定义和工厂函数） | createSingleEditDiffConfig | 不实现 diff 逻辑（只定义接口） | 导出 IDEDiffConfig、IDEDiffSupport 接口供其他模块使用 |

状态放置理由：
- currentIDESearch 在 ide.ts 顶层：findAvailableIDE 可能被多次调用，需要能取消前一次搜索
- cachedRunningIDEs 在 ide.ts 顶层：detectRunningIDEs 是昂贵操作，需要缓存，但提供 resetDetectRunningIDEs 供测试使用
- isUnmounted ref 在 useDiffInIDE 内部：只在组件生命周期内有效，避免 unmount 后调用 setState
- 祖先 PID 缓存使用 makeAncestorPidLookup 闭包：只在单次 detectIDEs 调用内有效，避免 PID 回收后 stale 缓存

### 4.3 主控制流

#### 4.3.1 启动时 IDE 自动发现与连接流

```
启动
  → useIDEIntegration 调用 initializeIdeIntegration
    → 并行：
      - findAvailableIDE（后台轮询，最多 30 秒）
        → 每次循环：
          → cleanupStaleIdeLockfiles（删除 stale lockfile）
          → detectIDEs(false)
            → getSortedIdeLockfiles（读取 ~/.claude/ide/ 下的 lockfile，按 mtime 排序）
            → 并行读取所有 lockfile（parse JSON 或旧格式纯文本）
            → 对每个 lockfile：
              → 检查 workspaceFolders 是否包含当前 cwd（NFC 规范化，WSL 路径转换）
              → 检查 PID 祖先链（如需要）
              → 检测 host IP（127.0.0.1 或 WSL gateway）
              → 构建 url（ws:// 或 http://.../sse）
            → 返回 isValid=true 的 IDE 列表
          → 如果恰好一个 IDE → onIdeDetected(ide) → setDynamicMcpConfig 添加 ide
          → 否则继续 sleep(1000)
      - isIDEExtensionInstalled（如 autoInstallIdeExtension 且在 supported terminal）
        → 如需要 → maybeInstallIDEExtension
          → 成功 → onInstallationComplete
          → 如首次安装成功 → onShowIdeOnboarding
    → MCP 客户端连接到 IDE → 连接成功后 AppState.mcp.clients 中出现 name='ide' 的 connected 客户端
```

#### 4.3.2 IDE diff 同步流

```
FileEditTool 请求用户确认
  → useDiffInIDE 检查 hasAccessToIDEExtensionDiffFeature 且 diffTool='auto'
    → 如满足：
      → 显示 ShowInIDEPrompt
      → showDiffInIDE
        → 读取旧文件内容（oldContent）
        → 注册 cleanup 回调（abort 或 beforeExit 时关闭 tab）
        → getPatchForEdits 生成 updatedFile
        → Windows/WSL 路径转换（如需要）
        → callIdeRpc('openDiff', {old_file_path, new_file_path, new_file_contents, tab_name})
        → 等待 RPC 结果：
          - FILE_SAVED：用新内容 computeEditsFromContents → onChange(accept-once)
          - TAB_CLOSED：用 updatedFile → onChange(accept-once)
          - DIFF_REJECTED：用 oldContent → onChange(reject)
        → cleanup（关闭 tab）
    → 否则：显示普通终端 diff
```

#### 4.3.3 /ide 命令选择与连接流

```
用户输入 /ide
  → call 函数
    → detectIDEs(true) 显示可用 IDE 列表
    → 如无可用 IDE 且不在 supported terminal → detectRunningIDEs 并提示安装扩展
    → 显示 IDEScreen
      → 用户选择 IDE
        → 如选择 'None'：删除动态 MCP 配置中的 ide → 清理 MCP 客户端
        → 否则：setDynamicMcpConfig 添加 ide → 等待 MCP 连接（最多 35 秒超时）
        → 显示连接结果
  → 用户输入 /ide open
    → detectIDEs(true)
    → 显示 IDEOpenSelection
    → 用户选择 IDE
    → 如为 VS Code 系列：exec code <cwd>
    → 否则：提示手动打开
```

#### 4.3.4 失败分支

```
detectIDEs 中某个 lockfile 读取失败
  → catch 错误，继续处理下一个 lockfile

findAvailableIDE 30 秒超时
  → onIdeDetected(null) → 不自动连接

showDiffInIDE 中 IDE 断开
  → callIdeRpc 抛出错误 → catch → setHasError(true) → 回退到终端 diff

/ide 连接超时（35 秒）
  → 显示超时消息
```

### 4.4 数据结构与持久化

**Lockfile 格式（~/.claude/ide/<port>.lock）：**
```json
{
  "workspaceFolders": ["/path/to/workspace", "/another/workspace"],
  "pid": 12345,
  "ideName": "VS Code",
  "transport": "sse",  // 或 "ws"
  "runningInWindows": true,  // 可选，WSL 场景
  "authToken": "optional-token"  // 可选
}
```
- 旧格式为纯文本，每行一个 workspace folder 路径
- 文件名是端口号，例如 `12345.lock`
- 按 mtime 排序，最新优先
- 没有并发锁，多实例可能竞争写入

**全局配置字段：**
- `diffTool: 'auto' | 'ide' | 'terminal'`：是否优先在 IDE 中显示 diff
- `autoConnectIde: boolean`：是否自动连接 IDE
- `autoInstallIdeExtension: boolean`：是否自动安装 IDE 扩展
- `ideHintShownCount: number`：已显示 /ide hint 的次数（最多 5 次）

**内存状态：**
- `currentIDESearch: AbortController | null`：当前正在运行的 findAvailableIDE 搜索
- `cachedRunningIDEs: IdeType[] | null`：detectRunningIDEs 的缓存
- `isUnmounted: MutableRefObject<boolean>`：useDiffInIDE 组件是否已卸载
- `connectingIDE: DetectedIDEInfo | null`：/ide 命令中正在连接的 IDE
- `hasShownHintRef: MutableRefObject<boolean>`：useIDEStatusIndicator 是否已显示 hint

**diff tab 命名约定：**
- 格式：`✻ [Claude Code] <basename> (<short-uuid>) ⧉`
- short-uuid 为 randomUUID().slice(0, 6)，避免多个文件编辑时 tab 名冲突

**恢复策略：**
- 没有持久化的 IDE 连接状态，每次启动重新发现和连接
- showDiffInIDE 在 abort 或 beforeExit 时尝试关闭 tab，但如果进程崩溃可能遗留 tab（下次 openDiff 时旧 tab 不影响，因为 UUID 不同）

### 4.5 跨子系统依赖

| 子系统 | 调用方式 | 职责边界 | 相关 spec |
|---|---|---|---|
| MCP 客户端 | setDynamicMcpConfig 添加 'ide' 配置；从 AppState.mcp.clients 获取连接状态；callIdeRpc 调用 MCP 工具 | 本文定义 IDE MCP 配置结构和调用模式，传输层和连接管理由 MCP 负责 | mcp |
| 设置系统 | getGlobalConfig/saveGlobalConfig 读写 diffTool、autoConnectIde、autoInstallIdeExtension、ideHintShownCount | 本文只使用这些配置，不定义设置系统的存储和 UI | settings |
| 权限对话框 | useDiffInIDE 作为 FilePermissionDialog 的一部分被调用；ShowInIDEPrompt 替换普通 diff 提示 | 本文只定义与权限对话框的集成接口，不定义权限逻辑 | permissions |
| 通知系统 | useIDEStatusIndicator 调用 addNotification/removeNotification | 本文只添加/移除通知，不定义通知显示和优先级 | notifications |
| 分析事件 | logEvent('tengu_ext_installed')、logEvent('tengu_ext_will_show_diff')、logEvent('tengu_ext_diff_accepted')、logEvent('tengu_ext_diff_rejected')、logEvent('tengu_ext_ide_command') | 本文只发送事件，不定义事件收集和传输 | telemetry |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|---|
| IDE 插件未安装或未启动 | detectIDEs 扫描后无可用 lockfile | 无异常，findAvailableIDE 返回 null；/ide 提示安装 | 不重试（findAvailableIDE 只在启动时轮询 30 秒） | 无 | 不自动连接；/ide 显示可用 IDE 为空 |
| Lockfile 存在但 IDE 已退出 | cleanupStaleIdeLockfiles 中检查 pid 和端口响应 | 无异常，该 lockfile 被删除，detectIDEs 不返回它 | 不重试（每次 detectIDEs 前都会 cleanup） | 删除 stale lockfile | 该 IDE 不出现在可用列表中 |
| WSL 中 IDE 运行在 Windows 但 gateway IP 不可达 | detectHostIP 中检查 gateway 端口，失败回退到 127.0.0.1 | 无异常，使用回退地址 | 不重试（memoize 缓存 per (runningInWindows, port)） | 无 | 可能连接失败（如果 127.0.0.1 也不可达） |
| IDE 连接过程中超时 | /ide 命令中的 35 秒 setTimeout | 显示超时消息 | 不重试（用户可再次手动尝试） | 清理 connectingIDE 状态 | 显示"Connection to <ideName> timed out" |
| showDiffInIDE 时 IDE 断开 | callIdeRpc 抛出错误 | catch 错误，setHasError(true) | 不重试 | 尝试关闭 tab（可能失败） | hasError=true，回退到终端 diff |
| VS Code 扩展安装失败 | maybeInstallIDEExtension 中 catch 错误 | 错误消息存入 IDEExtensionInstallationStatus，不向上抛出 | 不重试（用户可通过 /ide 手动触发） | 无 | useIDEStatusIndicator 显示安装错误通知；/status 显示详情 |
| 用户在 diff 确认前按 Esc 取消 | toolUseContext.abortController abort 事件 | 无异常（catch 并 cleanup） | 不重试 | 关闭 IDE diff tab；移除 abort 监听器和 beforeExit 监听器 | 工具调用被取消，无变更应用 |
| findAvailableIDE 被新调用取消 | 新调用 findAvailableIDE 时调用 currentIDESearch.abort() | 无异常（signal.aborted 被检查） | 不重试（新调用代替旧调用） | 旧调用的 AbortController 被丢弃 | 旧调用停止轮询，新调用继续 |
| 滚动渲染期间 | getIsScrollDraining() 返回 true | 无异常 | 重试（下次循环检查） | 跳过本次扫描，只 sleep(1000) | 自动连接可能延迟最多 1 秒 |

## 6. 现状验收标准

1. 当用户在 VS Code 内置终端启动 Claude Code 且已安装扩展时，系统必须在 30 秒内自动连接到该 VS Code 实例，并且 workspace 必须与当前 cwd 匹配；不得连接到其他打开的 VS Code 窗口。
2. 当用户在 macOS 上使用包含重音字符的路径时，detectIDEs 必须正确匹配 IDE 报告的 NFC 路径和系统的 NFD 路径；不得因路径规范化失败而找不到 IDE。
3. 当用户在 WSL 中启动 Claude Code 且 IDE 运行在 Windows 时，路径必须正确双向转换（Windows \\ ↔ WSL /），并且必须检查 WSL distro 匹配；不得打开错误 distro 的文件或使用无效路径。
4. 当 FileEditTool 触发且 IDE 已连接、diffTool='auto' 时，必须在 IDE 中打开 diff tab 并等待用户保存、关闭或拒绝；用户在 IDE 中的编辑必须被正确计算为新的 edits 并应用。
5. 当用户断开 IDE 或 IDE 崩溃时，必须显示断开通知；并且下次工具调用必须回退到终端 diff，不得阻塞或崩溃。
6. 当用户从外部终端启动且检测到可用 IDE 时，必须在 3 秒后显示一次 /ide hint，最多显示 5 次；不得每次启动都显示。
7. 当用户输入 /ide 时，必须显示所有可用 IDE 列表并允许选择、连接或断开；选择 'None' 必须断开当前连接。
8. 当 findAvailableIDE 正在轮询时再次调用，必须取消前一次轮询；不得同时运行多个轮询。
9. 当 detectIDEs 发现多个匹配的 IDE 且在 supported terminal 时，必须优先选择 PID 在祖先链中的 IDE；不得选择非当前终端所属的 IDE。
10. 当 lockfile 中的 PID 不存在且端口不响应时，cleanupStaleIdeLockfiles 必须删除该 lockfile；不得累积 stale lockfile。

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 通过 lockfile 发现 IDE，支持 SSE 和 WebSocket 传输 | `src/utils/ide.ts:298-433` | 无直接覆盖 | 手动验证 lockfile 发现逻辑 |
| 路径 NFC 规范化和 WSL 转换 | `src/utils/ide.ts:678-679; src/utils/idePathConversion.ts:25-73` | 无直接覆盖 | 手动验证路径转换逻辑 |
| 祖先 PID 检查消歧义 | `src/utils/ide.ts:689-690,770-782` | 无直接覆盖 | 手动验证祖先 PID 检查逻辑 |
| 30 秒轮询 + scroll draining 暂停 | `src/utils/ide.ts:626-657` | 无直接覆盖 | 手动验证轮询和暂停逻辑 |
| stale lockfile 清理策略 | `src/utils/ide.ts:522-581` | 无直接覆盖 | 手动验证 stale 清理逻辑 |
| diff 同步使用 openDiff RPC 和三种结果消息 | `src/hooks/useDiffInIDE.ts:216-327` | 无直接覆盖 | 手动验证 diff 同步逻辑 |
| VS Code 自动安装，JetBrains 只提示 | `src/utils/ide.ts:590-622,879-911` | 无直接覆盖 | 手动验证扩展安装逻辑 |
| IDE 连接作为动态 MCP 配置 | `src/hooks/useIDEIntegration.tsx:25-88; src/commands/ide/ide.tsx:544-555` | 无直接覆盖 | 手动验证动态 MCP 配置逻辑 |
| 通知系统显示 IDE 状态和错误 | `src/hooks/notifs/useIDEStatusIndicator.tsx:24-159` | 无直接覆盖 | 手动验证通知显示逻辑 |
| /ide 命令管理连接和选择 | `src/commands/ide/ide.tsx:315-580` | 无直接覆盖 | 手动验证 /ide 命令逻辑 |
| lockfile 没有并发锁，多 Claude Code 实例可能竞争写入或读取 | `src/utils/ide.ts:522-581` | 无直接覆盖 | 手动验证多实例并发行为 |
| showDiffInIDE 在进程崩溃时可能遗留 IDE diff tab | `src/hooks/useDiffInIDE.ts:216-327` | 无直接覆盖 | 手动验证崩溃后 diff tab 清理逻辑 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/ide-integration.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| ide-core | IDE 发现、lockfile 管理、连接检测、扩展安装、RPC 调用封装 | 无直接测试 | src/services/mcp/*（MCP 传输层由 mcp spec 主拥有） |
| ide-path-conversion | WSL/Windows 路径双向转换、distro 匹配检查 | 无直接测试 | 无 |
| ide-hooks | IDE 集成初始化 hook、diff 同步 hook、IDE 状态通知 hook | 无直接测试 | src/hooks/useIdeConnectionStatus.ts（可能由其他 spec 主拥有） |
| ide-commands | /ide 命令实现、IDE 选择 UI、连接/断开/打开项目 | 无直接测试 | 无 |
| ide-components | ShowInIDEPrompt、IDE 相关权限对话框配置 | 无直接测试 | src/components/IdeOnboardingDialog.tsx（未读，可能属于本 spec 但暂不覆盖） |
| ide-types | IDE 类型定义、IdeType 枚举、支持的 IDE 配置 | 无直接测试 | 无 |

**相关子系统：**
- [mcp](./2026-11-12-mcp-design.md)：MCP 客户端、动态配置、工具调用
- [settings](./2026-11-12-settings-design.md)：diffTool、autoConnectIde 等配置
- [permissions](./2026-11-12-permissions-design.md)：文件权限对话框与 IDE diff 集成
- [telemetry](./2026-11-12-telemetry-design.md)：IDE 相关分析事件

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 缺少 IDE 集成相关的单元测试和集成测试 | 添加 detectIDEs、路径转换、cleanupStaleIdeLockfiles 的单元测试；添加 mock IDE 的集成测试 | 低（新增测试） | 测试覆盖关键路径：lockfile 读写、路径规范化、祖先 PID 检查、stale 清理、diff 消息处理 | M | 设计推断 |
| P2 | lockfile 没有并发锁，多 Claude Code 实例可能竞争写入或读取 | 添加简单的文件锁（flock 或类似机制），或使用原子写入（写入临时文件再 rename） | 中（可能引入新的竞态条件或平台兼容性问题） | 并发运行多个 Claude Code 实例，检测 IDE 时不出现错误或误读 | M | 设计推断 |
| P2 | showDiffInIDE 在进程崩溃时可能遗留 IDE diff tab | 在 tab name 中加入 Claude Code 进程 pid，下次启动时清理旧 tab；或 IDE 插件侧添加心跳检测 | 中（需要 IDE 插件配合） | 崩溃重启后，旧 diff tab 被自动关闭或显示为无效 | L | 设计推断 |
| P3 | /ide hint 显示延迟 3 秒，用户可能已经开始输入 | 优化为：在 detectIDEs 首次发现可用 IDE 后立即显示，而不是固定 3 秒；但仍需要避免与 scroll draining 冲突 | 低 | hint 在发现 IDE 后 1 秒内显示，但在滚动期间不显示 | S | 设计推断 |
