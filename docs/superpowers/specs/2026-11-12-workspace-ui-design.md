---
id: workspace-ui
batch: 4
title: Workspace UI 工作区、差异与对话框交互设计
date: 2026-11-12
status: draft
---

# Workspace UI 工作区、差异与对话框交互设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理"、"提高可靠性"、"保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

工作区 UI 系统需要解决以下具体问题：

当用户在命令行界面中：
1. 需要查看未提交的代码变更时，必须有一个键盘友好的 diff 查看器
2. 需要添加额外的工作区目录时，必须有一个交互式对话框处理权限和持久性选项
3. 需要配置沙箱模式时，必须有一个标签页式的设置界面
4. 需要在全屏模式下滚动浏览对话历史时，必须有粘性提示和新消息指示器
5. 需要在多个选项之间做选择时，必须有一个可键盘导航的选择组件

如果没有 diff 对话框，用户需要离开 Claude Code 去运行 git diff，打断工作流。

如果没有交互式目录添加对话框，用户需要手动编辑配置文件，容易出错且体验差。

如果没有全屏布局的粘性提示，用户滚动浏览历史时会忘记当前正在讨论什么内容。

### 调用方与责任边界

调用方：
- 主命令系统（`src/commands.ts`）调用 `/add-dir`、`/diff`、`/sandbox-toggle` 的 `call` 函数
- REPL 组件使用 FullscreenLayout 作为主渲染容器
- 其他对话框（权限、文件编辑）复用 Dialog、Select 等基础组件

责任边界：
- add-dir 命令：处理目录路径验证、权限更新、沙箱配置刷新
- diff 命令：收集 git diff 数据、渲染文件列表和差异详情
- sandbox-toggle 命令：检查依赖、显示设置界面、更新配置
- FullscreenLayout：管理滚动状态、粘性提示、新消息药丸、模态对话框
- Dialog/Select：通用 UI 组件，无业务逻辑
- 权限系统：检查目录访问权限（不属于本 spec 核心，但会调用）

### 实际约束

平台与兼容性约束：
- 沙箱仅在 macOS、Linux 和 WSL2 上可用，WSL1 不支持
- 全屏模式需要 Alternate Screen 支持，可通过 `CLAUDE_CODE_NO_FLICKER=0` 禁用
- 键盘快捷键必须支持终端常见的键（方向键、Enter、Esc、Tab），不依赖鼠标

体验约束：
- DiffDialog 列表只显示 5 个文件，支持滚动（避免过长列表）
- 新消息药丸在用户向上滚动且有新消息时显示
- 粘性提示固定在 1 行高度（避免内容跳动）

### 内部/外部差异

本系统在 CLI、SDK、离线/在线模式下行为一致，唯一差异是：
- 全屏模式默认对内部启用，对外部用户禁用（可通过环境变量覆盖）
- SDK 模式下可能没有终端，FullscreenLayout 会回退到简单布局

## 2. 设计理由与备选方案

### 决策 1：DiffDialog 支持当前变更和历史轮次双数据源

**实际机制：**
- sources 数组包含 `{type: 'current'}`（git diff）和 `{type: 'turn', turn: TurnDiff}`（对话历史中的文件变更）
- 左/右方向键在列表模式下切换源，在详情模式下返回列表
- 源切换时重置选中文件索引为 0
- 显示源选择器药丸（当有多个源时）

**为什么这样设计：**
- 用户需要既能查看当前未提交的变更，也能查看历史对话中某个轮次做了什么修改
- 双模式复用同一视图组件，代码更简洁
- 方向键行为随模式上下文变化，减少学习成本

**备选方案及不采用原因：**
- 方案 A：两个独立命令 `/diff` 和 `/diff-history` → 被否决，用户需要记忆更多命令
- 方案 B：始终展开所有源的所有文件 → 被否决，列表太长难以导航
- 方案 C：用 Tab 键切换源 → 被否决，Tab 习惯上用于自动补全，冲突

**代价：**
- 需要在两种模式下复用相同快捷键，逻辑复杂
- 用户需要学习上下文相关的键盘行为

**证据：**
- `src/components/diff/DiffDialog.tsx:67-76` sources 数组构建
- `src/components/diff/DiffDialog.tsx:118-136` 键盘快捷键处理（视图模式相关）
- `src/components/diff/DiffDialog.tsx:181-199` 源选择器 UI

### 决策 2：AddWorkspaceDirectory 预填路径时显示确认选项，否则显示输入框

**实际机制：**
- 两种分支：有 `directoryPath` prop 时显示确认对话框，无则显示输入框
- 确认对话框包含三个选项："Yes, for this session"、"Yes, and remember this directory"、"No"
- 输入框支持 Tab 自动补全目录，Enter 确认，Esc 取消
- Tab 补全使用 `getDirectoryCompletions` 函数，有 100ms debounce

**为什么这样设计：**
- 用户可能通过两种方式使用 `/add-dir`：直接传路径或交互式选择
- 直接传路径时仍需要确认持久化选项，防止误操作
- 交互式输入时需要自动补全提升效率
- 用同一个组件处理两种场景，减少代码重复

**备选方案及不采用原因：**
- 方案 A：两个独立组件 → 被否决，代码重复，维护成本高
- 方案 B：总是显示输入框，把路径作为默认值 → 被否决，用户体验差（需要额外确认持久化）
- 方案 C：持久化与会话选项用额外命令参数表示 → 被否决，用户难以记忆参数格式

**代价：**
- 组件复杂度增加，需要处理两种分支的 UI 和逻辑
- 测试需要覆盖两种场景

**证据：**
- `src/components/permissions/rules/AddWorkspaceDirectory.tsx:267-288` 条件渲染
- `src/components/permissions/rules/AddWorkspaceDirectory.tsx:32-50` 记住选项定义
- `src/components/permissions/rules/AddWorkspaceDirectory.tsx:125-141` 防抖补全

### 决策 3：FullscreenLayout 使用 useSyncExternalStore 订阅滚动状态避免重渲染

**实际机制：**
- ScrollBox 暴露订阅接口，供 useSyncExternalStore 监听滚动变化
- pillVisible 仅在视口底部高于分隔线 y 坐标时为 true，Object.is 比较布尔值
- 新消息药丸计算与渲染与主消息列表解耦，仅在布尔值翻转时重渲染
- ScrollChromeContext 提供 setStickyPrompt，避免回调层层传递

**为什么这样设计：**
- REPL 组件有 22+ 个 useAppState 选择器，每次滚动都重渲染会导致严重性能问题
- useSyncExternalStore 可以细粒度订阅仅需要的状态（pillVisible）
- 上下文传递回调避免 prop drilling，且回调引用稳定不会导致重渲染

**备选方案及不采用原因：**
- 方案 A：在 REPL 组件中用 useState 存 pillVisible → 被否决，每次滚动都重渲染整个 REPL
- 方案 B：用事件监听器 + forceUpdate → 被否决，React 18 推荐 useSyncExternalStore
- 方案 C：把所有状态都放到 FullscreenLayout → 被否决，组件职责过大

**代价：**
- 代码复杂度增加，需要理解 useSyncExternalStore 的使用
- ScrollBox 需要实现订阅接口，不是标准 React 模式

**证据：**
- `src/components/FullscreenLayout.tsx:326-338` pillVisible 订阅与计算
- `src/components/FullscreenLayout.tsx:40-42` ScrollChromeContext 定义
- `src/components/FullscreenLayout.tsx:99-214` useUnseenDivider 钩子设计

### 决策 4：CustomSelect 使用焦点管理而非悬停，支持键盘导航

**实际机制：**
- 用 `useSelectNavigation` 管理选中索引，响应上下方向键
- `useSelectState` 管理打开/关闭状态
- `useKeybindings` 在 Settings 上下文中注册快捷键，避免与其他组件冲突
- Enter 确认选中，Esc 取消，Tab 不处理（留给输入框）

**为什么这样设计：**
- 终端环境下鼠标可能不可用或不精确
- 键盘导航是 CLI 用户的主要交互方式
- 上下文相关的快捷键避免与全局快捷键冲突

**备选方案及不采用原因：**
- 方案 A：仅悬停高亮 → 被否决，终端环境下悬停支持不一致
- 方案 B：用数字键选择 → 被否决，选项多时难以记忆
- 方案 C：全局快捷键注册 → 被否决，可能与对话框的 Esc 冲突

**代价：**
- 需要管理焦点状态，复杂度增加
- 需要理解 useKeybindings 的上下文机制

**证据：**
- `src/components/CustomSelect/select.tsx` 主组件
- `src/components/CustomSelect/useSelectNavigation.ts` 导航逻辑
- `src/components/CustomSelect/useSelectState.ts` 状态管理

### 决策 5：SandboxSettings 根据依赖检查结果动态显示标签页

**实际机制：**
- `depCheck` 包含 errors 和 warnings
- 有 errors 时仅显示 Dependencies 标签页
- 有 warnings 时显示全部标签页（Mode、Dependencies、Overrides、Config）
- 无 errors/warnings 时显示 Mode、Overrides、Config

**为什么这样设计：**
- 依赖缺失时用户必须先解决才能配置沙箱，避免误操作
- 警告时仍允许配置，但让用户知道有潜在问题
- 无问题时隐藏不必要的 Dependencies 标签页，简化界面

**备选方案及不采用原因：**
- 方案 A：总是显示所有标签页 → 被否决，用户可能跳过依赖问题直接配置
- 方案 B：有错误时完全禁用命令 → 被否决，用户仍可能想查看配置选项
- 方案 C：用内联警告而非单独标签页 → 被否决，警告信息可能很长，占用太多空间

**代价：**
- 标签页数组构建逻辑较复杂
- 需要测试所有三种组合

**证据：**
- `src/components/sandbox/SandboxSettings.tsx:132-151` 标签页条件构建
- `src/components/sandbox/SandboxSettings.tsx:32-37` showSocketWarning 计算
- `src/components/sandbox/SandboxDependenciesTab.tsx` 依赖详情显示

### 决策 6：DiffFileList 只显示 5 个文件，用上下指示器表示更多

**实际机制：**
- MAX_VISIBLE_FILES = 5
- startIndex 计算：确保选中项大致居中
- 有更多文件时显示 "↑ N more files" 或 "↓ N more files"
- 文件路径用 `truncateStartToWidth` 截断以适应终端宽度

**为什么这样设计：**
- 终端高度有限，显示太多文件会占用过多空间
- 显示当前选中项周围的文件提供上下文
- 截断路径开头（而非结尾）保留文件名，更容易识别

**备选方案及不采用原因：**
- 方案 A：显示所有文件 → 被否决，变更多时会占满整个屏幕
- 方案 B：用分页（上一页/下一页） → 被否决，需要额外快捷键，增加学习成本
- 方案 C：截断路径结尾 → 被否决，用户更关心文件名而不是目录结构

**代价：**
- 需要计算可见窗口的 start/end 索引
- 用户只能看到部分文件，可能需要滚动多次

**证据：**
- `src/components/diff/DiffFileList.tsx:9` MAX_VISIBLE_FILES 常量
- `src/components/diff/DiffFileList.tsx:19-36` 可见窗口计算
- `src/components/diff/DiffFileList.tsx:53-74` 上下指示器显示

### 决策 7：未读分隔线使用 snapshot mtime + dividerIndex，支持 prepend 时偏移

**实际机制：**
- `dividerYRef` 存 scrollHeight 的 snapshot（不是 React state，避免重渲染）
- `dividerIndex` 是 messages 数组中分隔线的索引
- 滚动离开底部时 snapshot，滚动回来时清除
- prepend 消息时调用 `shiftDivider(indexDelta, heightDelta)` 调整位置
- `countUnseenAssistantTurns` 统计分隔线后的 assistant 轮次（跳过纯 tool-use 轮次）

**为什么这样设计：**
- 用户向上滚动阅读历史时，不应被新消息打断
- 分隔线位置需要稳定，不能因新消息到来而跳动
- 无限滚动（历史消息 prepend）时需要调整分隔线位置
- 纯 tool-use 轮次不应该触发新消息提示（用户不认为是新消息）

**备选方案及不采用原因：**
- 方案 A：新消息到达时自动滚动到底部 → 被否决，打断用户阅读
- 方案 B：仅用索引，不用 scrollHeight snapshot → 被否决，消息高度不同时分隔线位置不准
- 方案 C：所有新消息都触发提示 → 被否决，纯工具调用轮次用户不关心

**代价：**
- 需要在多个地方调用 onScrollAway/onRepin/shiftDivider
- 状态存储在多个地方（state + ref），复杂度增加

**证据：**
- `src/components/FullscreenLayout.tsx:99-214` useUnseenDivider 完整实现
- `src/components/FullscreenLayout.tsx:224-243` countUnseenAssistantTurns 实现
- `src/components/FullscreenLayout.tsx:265-286` computeUnseenDivider 实现

### 决策 8：添加目录后同时更新权限状态、bootstrap 状态和沙箱配置

**实际机制：**
- 三个步骤：
  1. `applyPermissionUpdate` 更新工具权限上下文
  2. `setAdditionalDirectoriesForClaudeMd` 更新 bootstrap 状态
  3. `SandboxManager.refreshConfig()` 刷新沙箱配置
- 持久化选项：remember=true 时调用 `persistPermissionUpdate` 写入本地设置

**为什么这样设计：**
- 工具需要权限才能访问新目录
- Bash 命令在沙箱中运行，需要沙箱也知道新目录
- Bootstrap 状态是会话中附加目录的真实来源
- 立即刷新避免竞态条件（用户立即尝试使用新目录）

**备选方案及不采用原因：**
- 方案 A：仅更新权限 → 被否决，沙箱命令无法访问新目录
- 方案 B：仅更新沙箱配置 → 被否决，文件工具无法访问新目录
- 方案 C：延迟刷新 → 被否决，用户可能立即尝试使用，导致失败

**代价：**
- 需要三个独立调用，代码较长
- 沙箱刷新是 async 但命令不等待，可能有边缘竞态

**证据：**
- `src/commands/add-dir/add-dir.tsx:62-93` handleAddDirectory 完整流程
- `src/commands/add-dir/add-dir.tsx:84-92` bootstrap + 沙箱更新注释

## 3. 目标与非目标

### 状态与生命周期

**目标：**
- DiffDialog 状态在组件内部管理（viewMode、selectedIndex、sourceIndex），不持久化
- FullscreenLayout 的 unseen divider 状态在会话中持续，直到用户滚动回底部
- AddWorkspaceDirectory 的输入状态仅在对话框打开期间存在，关闭即丢弃
- 沙箱设置立即写入配置，无撤销功能

**非目标：**
- 不持久化 diff 对话框的查看位置（关闭后重置）
- 不记录沙箱设置的历史版本（无法回滚）
- 不支持多个未读分隔线（仅一个当前位置）

### 接口与数据

**目标：**
- 所有命令组件返回 React.ReactNode，通过 onDone 回调退出
- Dialog 组件接受 title、onCancel、color 等通用参数
- Select 组件接受 options、onChange、onCancel，无业务逻辑
- DiffData 是统一格式，支持当前 git diff 和历史 turn diff 两种来源

**非目标：**
- 不提供通用的列表/详情视图框架（仅 DiffDialog 专用）
- 不保证 Select 选项标签的 HTML 渲染（仅纯文本）

### 执行与环境

**目标：**
- 对话框通过 useRegisterOverlay 注册为模态，禁用聊天快捷键
- 键盘快捷键使用 useKeybindings，指定上下文避免冲突
- add-dir 验证目录时不修改任何状态，仅在确认后才应用
- 全屏模式通过 isFullscreenEnvEnabled 检测，支持环境变量覆盖

**非目标：**
- 不支持鼠标点击选择 diff 文件（仅键盘）
- 不支持在对话框中直接编辑文件（仅查看）
- 不支持触摸设备交互

### 依赖边界

- **权限系统**（`src/utils/permissions/`）：本 spec 描述调用契约，主设计由权限 spec 负责
- **工具框架**（`src/Tool.ts`）：不相关，本 spec 纯 UI 命令
- **沙箱管理器**（`src/utils/sandbox/`）：本 spec 描述调用契约，主设计由沙箱 spec 负责
- **Git 集成**（`src/utils/git.ts`）：本 spec 仅描述 useDiffData 使用，不描述 Git 操作本身

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

#### /add-dir 命令入口

**真实入口签名：**
```typescript
// src/commands/add-dir/add-dir.tsx:53-56
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode>
```

**关键类型：**
```typescript
// 输入：可选的目录路径字符串（trimmed）
// 输出：React 节点或 AddDirError 组件（延迟 onDone）

// 核心内部类型
type PermissionUpdateDestination = 'localSettings' | 'session'
```

**输入输出：**
- 输入：`args?: string` - 可选的目录路径
- 输出：React.ReactNode - 渲染 AddWorkspaceDirectory 或 AddDirError

**调用流程：**
1. 解析 args，trim 处理得到 directoryPath
2. 获取当前 appState（包含 toolPermissionContext）
3. 如果无 args：直接返回 AddWorkspaceDirectory 输入框
4. 如果有 args：
   - 调用 `validateDirectoryForWorkspace` 验证路径
   - 验证成功：返回 AddWorkspaceDirectory 确认对话框（预填路径）
   - 验证失败：返回 AddDirError 组件（setTimeout 0 后调用 onDone）

**确认后流程（handleAddDirectory）：**
1. 根据 remember 选择 destination（'localSettings' 或 'session'）
2. 构建 `{type: 'addDirectories', directories: [path], destination}`
3. 调用 `applyPermissionUpdate` 更新 toolPermissionContext
4. 调用 `setAppState` 更新状态
5. 调用 `setAdditionalDirectoriesForClaudeMd` 更新 bootstrap 状态
6. 调用 `SandboxManager.refreshConfig()` 刷新沙箱配置（async 不等待）
7. 如果 remember=true，调用 `persistPermissionUpdate` 写入本地设置
8. 调用 `onDone(message)` 退出

**错误处理：**
- 目录不存在、无权限、不是目录 → validateDirectoryForWorkspace 返回错误
- persistPermissionUpdate 可能抛出异常 → 捕获并在 message 中提示
- AddDirError 使用 setTimeout 0 确保错误消息先渲染

**设计取舍：**
- why：沙箱刷新 async 但不等待 → 用户体验优先，避免阻塞
- alternative：await SandboxManager.refreshConfig() → 被否决，可能导致明显延迟
- cost：理论竞态窗口（用户在刷新完成前使用）→ 实际风险很低

**源码证据：**
- `src/commands/add-dir/add-dir.tsx:53-154` 完整 call 实现
- `src/commands/add-dir/add-dir.tsx:62-109` handleAddDirectory 内部函数
- `src/commands/add-dir/add-dir.tsx:24-51` AddDirError 组件

---

#### /diff 命令入口

**真实入口签名：**
```typescript
// src/commands/diff/diff.tsx:4-7
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const { DiffDialog } = await import('../../components/diff/DiffDialog.js')
  return <DiffDialog messages={context.messages} onDone={onDone} />
}
```

**关键类型：**
```typescript
// 输入：context.messages 用于提取历史轮次 diff
// 输出：React 节点（DiffDialog）

// DiffDialog 内部状态
type ViewMode = 'list' | 'detail'
type DiffSource = {type: 'current'} | {type: 'turn', turn: TurnDiff}
```

**输入输出：**
- 输入：`context.messages: Message[]` - 对话历史
- 输出：`React.ReactNode` - DiffDialog 组件

**调用流程：**
1. 动态 import DiffDialog（懒加载）
2. 返回 `<DiffDialog messages={context.messages} onDone={onDone} />`

**DiffDialog 内部流程：**
1. 调用 `useRegisterOverlay('diff-dialog')` 禁用聊天快捷键
2. 调用 `useDiffData()` 获取当前 git diff
3. 调用 `useTurnDiffs(messages)` 从历史提取轮次 diff
4. 构建 sources 数组：`[{type: 'current'}, ...turnDiffs]`
5. 初始 state：viewMode='list', selectedIndex=0, sourceIndex=0
6. 注册 view-mode 相关快捷键：
   - list 模式：←/→ 切换源，↑/↓ 选择文件，Enter 进入详情，Esc 关闭
   - detail 模式：←/Esc 返回列表
7. 渲染源选择器（如果多个源）、文件列表或 diff 详情

**UI 状态与焦点：**
- 列表模式：焦点在文件列表，selectedIndex 高亮
- 详情模式：焦点在 diff 视图，可滚动
- Esc 关闭：在详情模式下先返回列表，在列表模式下直接关闭

**双数据源处理：**
- sources 数组包含当前变更和历史轮次
- sourceIndex 变化时，selectedIndex 重置为 0
- currentTurn 存在时调用 `turnDiffToDiffData()` 统一格式
- 源选择器显示 "Current · T1 · T2" 格式，带左右箭头指示器

**设计取舍：**
- why：动态 import → 减少初始包体积
- alternative：静态 import → 被否决，diff 功能不是每次会话都用
- cost：首次打开稍有延迟

**源码证据：**
- `src/commands/diff/diff.tsx:4-7` call 入口
- `src/components/diff/DiffDialog.tsx:17-85` 组件 Props + 状态
- `src/components/diff/DiffDialog.tsx:105` useRegisterOverlay 调用
- `src/components/diff/DiffDialog.tsx:118-156` 快捷键处理

---

#### /sandbox-toggle 命令入口

**真实入口签名：**
```typescript
// src/commands/sandbox-toggle/sandbox-toggle.tsx:17-21
export async function call(
  onDone: (result?: string) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode | null>
```

**关键类型：**
```typescript
// 输入：可选的 exclude 子命令
// 输出：SandboxSettings 组件、null（直接 onDone）

// 沙箱依赖检查结果
type SandboxDependencyCheck = {
  errors: string[]
  warnings: string[]
}
```

**输入输出：**
- 输入：`args?: string` - 可选的子命令（如 "exclude npm run test:*"）
- 输出：`React.ReactNode | null` - SandboxSettings 或 null（直接调用 onDone）

**调用流程：**
1. 获取 settings 和 themeName
2. 检查平台支持：`SandboxManager.isSupportedPlatform()`
   - 不支持（如 WSL1）：调用 onDone 错误信息，返回 null
3. 获取 depCheck = `SandboxManager.checkDependencies()`
4. 检查 enabledPlatforms：`SandboxManager.isPlatformInEnabledList()`
   - 不允许：调用 onDone 错误信息，返回 null
5. 检查设置锁定：`SandboxManager.areSandboxSettingsLockedByPolicy()`
   - 锁定：调用 onDone 错误信息，返回 null
6. 解析 args：
   - 无 args：返回 `<SandboxSettings onComplete={onDone} depCheck={depCheck} />`
   - 有 "exclude"：提取模式，调用 `addToExcludedCommands()`，onDone 成功消息
   - 其他：调用 onDone 错误消息

**SandboxSettings 内部流程：**
1. 获取 currentEnabled、currentAutoAllow、settings
2. 计算 showSocketWarning（warnings 存在且未允许所有 Unix Socket）
3. 构建 tabs 数组（条件渲染）：
   - depCheck.errors 非空 → 仅 Dependencies 标签页
   - depCheck.warnings 非空 → Mode + Dependencies + Overrides + Config
   - 无问题 → Mode + Overrides + Config
4. 渲染 Pane + Tabs

**错误处理：**
- 平台不支持 → 立即 onDone
- 设置锁定 → 立即 onDone
- exclude 子命令无模式 → 立即 onDone
- 沙箱设置写入失败 → SandboxManager 内部处理

**设计取舍：**
- why：depCheck.errors 时仅显示 Dependencies → 强制用户先解决问题
- alternative：显示所有标签页但禁用 → 被否决，用户可能困惑为何无法操作
- cost：标签数组构建逻辑复杂

**源码证据：**
- `src/commands/sandbox-toggle/sandbox-toggle.tsx:17-127` call 入口
- `src/components/sandbox/SandboxSettings.tsx:15-160` SandboxSettings 组件
- `src/components/sandbox/SandboxSettings.tsx:132-151` 标签页条件构建

---

#### FullscreenLayout 入口

**真实入口签名：**
```typescript
// src/components/FullscreenLayout.tsx:300-313
export function FullscreenLayout({
  scrollable,
  bottom,
  overlay,
  bottomFloat,
  modal,
  modalScrollRef,
  scrollRef,
  dividerYRef,
  hidePill = false,
  hideSticky = false,
  newMessageCount = 0,
  onPillClick,
}: Props): React.ReactNode
```

**关键类型：**
```typescript
// 完整 Props
type Props = {
  scrollable: ReactNode           // 消息列表（可滚动内容）
  bottom: ReactNode               // 底部固定区域（提示输入框）
  overlay?: ReactNode             // 内联覆盖层（权限对话框）
  bottomFloat?: ReactNode         // 右下角浮动元素
  modal?: ReactNode               // 模态对话框内容
  modalScrollRef?: RefObject<ScrollBoxHandle>
  scrollRef?: RefObject<ScrollBoxHandle>
  dividerYRef?: RefObject<number | null>
  hidePill?: boolean
  hideSticky?: boolean
  newMessageCount?: number
  onPillClick?: () => void
}

// useUnseenDivider 返回值
type UnseenDividerReturn = {
  dividerIndex: number | null
  dividerYRef: RefObject<number | null>
  onScrollAway: (handle: ScrollBoxHandle) => void
  onRepin: () => void
  jumpToNew: (handle: ScrollBoxHandle | null) => void
  shiftDivider: (indexDelta: number, heightDelta: number) => void
}
```

**输入输出：**
- 输入：上述 Props
- 输出：React.ReactNode - 全屏布局或回退简单布局

**全屏模式流程（isFullscreenEnvEnabled=true）：**
1. 创建 ScrollChromeContext（提供 setStickyPrompt）
2. pillVisible 订阅：
   - useSyncExternalStore 订阅 scrollRef.current
   - snapshot 计算：scrollTop + pendingDelta + viewportHeight < dividerYRef.current
   - 仅布尔值翻转时重渲染
3. 注册超链接点击处理（file:// → openPath，其他 → openBrowser）
4. 渲染结构：
   - Box (flexGrow, flexDirection column)
     - 可选：StickyPromptHeader（1行高度，truncate-end）
     - ScrollBox (ref=scrollRef)
       - ScrollChromeContext.Provider
         - scrollable（消息列表）
       - overlay（内联对话框）
     - 可选：NewMessagesPill（count>0 显示 "N new messages"，否则 "Jump to bottom"）
     - 可选：bottomFloat（右下角浮动）
   - Box (flexShrink 0)
     - SuggestionsOverlay
     - DialogOverlay
     - Box（bottom 内容）
   - 可选：ModalContext.Provider + 模态对话框（底部锚定，▔ 分隔线）

**非全屏模式流程：**
- 直接渲染：`<> {scrollable} {bottom} {overlay} {modal} </>`

**UI 状态与焦点：**
- ScrollBox 管理滚动状态、订阅、pendingDelta
- StickyPrompt：用户滚动超过提示时显示，1行高度，点击跳回
- NewMessagesPill：用户向上滚动且有新消息时显示，居中在底部
- 模态对话框：底部锚定，maxHeight = terminalRows - MODAL_TRANSCRIPT_PEEK（保留2行历史）

**打开/导航/确认/关闭流程：**
- 模态打开：通过 modal prop 传入内容，ModalContext 提供尺寸
- 模态导航：Tabs 可使用 modalScrollRef
- 模态确认/关闭：modal 内容组件调用自身回调
- 内联 overlay：通过 overlay prop 传入，在 ScrollBox 内部渲染（保留滚动位置）

**错误处理：**
- ScrollBox 订阅回调抛出 → React 错误边界捕获（药丸不显示，核心功能不受影响）
- 超链接点击失败 → 静默捕获

**设计取舍：**
- why：dividerYRef 是 ref 而非 state → 避免 scroll 时重渲染 REPL
- why：onRepin 延迟清除 dividerYRef → 避免与 wheel 事件竞态
- why：粘性提示固定1行 → 避免内容跳动

**源码证据：**
- `src/components/FullscreenLayout.tsx:40-82` Props 类型 + ScrollChromeContext
- `src/components/FullscreenLayout.tsx:99-214` useUnseenDivider 钩子
- `src/components/FullscreenLayout.tsx:300-492` FullscreenLayout 实现
- `src/components/FullscreenLayout.tsx:326-338` pillVisible 订阅

---

#### useUnseenDivider 钩子

**真实入口签名：**
```typescript
// src/components/FullscreenLayout.tsx:99-116
export function useUnseenDivider(messageCount: number): {
  dividerIndex: number | null
  dividerYRef: RefObject<number | null>
  onScrollAway: (handle: ScrollBoxHandle) => void
  onRepin: () => void
  jumpToNew: (handle: ScrollBoxHandle | null) => void
  shiftDivider: (indexDelta: number, heightDelta: number) => void
}
```

**关键类型：**
```typescript
// 核心数据
type UnseenDivider = {
  firstUnseenUuid: string
  count: number
}

// countUnseenAssistantTurns 输入输出
function countUnseenAssistantTurns(
  messages: readonly Message[],
  dividerIndex: number
): number  // 返回非纯 tool-use 的 assistant 轮次数

// computeUnseenDivider 输入输出
function computeUnseenDivider(
  messages: readonly Message[],
  dividerIndex: number | null
): UnseenDivider | undefined
```

**输入输出：**
- 输入：`messageCount: number` - 当前消息总数
- 输出：上述返回值对象

**UI 状态与焦点：**
- dividerIndex：React state（变化时重渲染）- messages 数组中的索引
- dividerYRef：MutableRefObject（写入不重渲染）- scrollHeight snapshot
- countRef：MutableRefObject（在 render 中更新）- 当前 messageCount

**onScrollAway 流程：**
1. 检查是否真正离开底部：
   - `max = handle.getScrollHeight() - handle.getViewportHeight()`
   - `handle.getScrollTop() + handle.getPendingDelta() >= max` → 仍在底部，返回
2. 如果 dividerYRef.current 为 null（首次离开）：
   - `dividerYRef.current = handle.getScrollHeight()`（snapshot）
   - `setDividerIndex(countRef.current)`

**onRepin 流程：**
1. 仅调用 `setDividerIndex(null)`
2. 不直接清除 dividerYRef.current（避免与 wheel 事件竞态）
3. useEffect 在 dividerIndex 变为 null 后清除 dividerYRef.current

**jumpToNew 流程：**
1. `handle.scrollToBottom()`（不直接滚动到 dividerY）
2. 原因：scrollToBottom 会设置 stickyScroll=true，确保正确渲染

**shiftDivider 流程（prepend 历史消息）：**
1. `setDividerIndex(idx => idx === null ? null : idx + indexDelta)`
2. `dividerYRef.current += heightDelta`（ref 同步更新）

**countUnseenAssistantTurns 流程：**
1. 从 dividerIndex 开始遍历 messages
2. 跳过 type === 'progress' 的消息
3. 跳过 assistant 消息且无可见文本（纯 tool-use）
4. 统计非 assistant → assistant 转换次数

**设计取舍：**
- why：countRef 在 render 中更新 → 确保 wheel 事件看到最新 count
- alternative：useEffect 同步 → 被否决，wheel 可能在 effect 前到达
- cost：React Compiler 会 bail out（单例钩子，可接受）

**源码证据：**
- `src/components/FullscreenLayout.tsx:99-214` useUnseenDivider 完整实现
- `src/components/FullscreenLayout.tsx:224-251` countUnseenAssistantTurns + 辅助函数
- `src/components/FullscreenLayout.tsx:265-286` computeUnseenDivider

---

#### useRegisterOverlay 钩子

**真实入口签名：**
```typescript
// src/context/overlayContext.tsx:37-72
export function useRegisterOverlay(id: string, enabled = true): void
```

**关键类型：**
```typescript
// 内部状态
type AppStateOverlay = {
  activeOverlays: Set<string>
}

// 相关导出
export function useIsOverlayActive(): boolean
export function useIsModalOverlayActive(): boolean  // 排除 NON_MODAL_OVERLAYS
```

**输入输出：**
- 输入：`id: string, enabled = true`
- 输出：void

**UI 状态与焦点：**
- activeOverlays：Set<string>（存储在 AppState）
- NON_MODAL_OVERLAYS：Set(['autocomplete']) - 不禁用 TextInput 焦点

**打开/注册流程：**
1. useEffect 在 enabled=true 且 setAppState 存在时：
   - 如果 id 不在 activeOverlays 中，添加并更新 AppState
   - cleanup 函数：移除 id
2. useLayoutEffect（同步清理）在 enabled=true 时：
   - cleanup：调用 `instances.get(process.stdout)?.invalidatePrevFrame()`
   - 强制下一次渲染使用 full-damage diff 而非 blit，避免幽灵残留

**full-damage vs blit 设计：**
- why：invalidatePrevFrame → 高对话框关闭后不留下残影
- alternative：始终 full-damage → 被否决，性能差
- cost：需要 useLayoutEffect 确保 cleanup 在 scheduleRender 前运行

**源码证据：**
- `src/context/overlayContext.tsx:1-109` 完整实现
- `src/context/overlayContext.tsx:37-72` useRegisterOverlay
- `src/context/overlayContext.tsx:60-71` invalidatePrevFrame 注释

---

#### DiffDialog 组件

**真实入口签名：**
```typescript
// src/components/diff/DiffDialog.tsx:17-23
type Props = {
  messages: Message[]
  onDone: (
    result?: string,
    options?: {display?: CommandResultDisplay},
  ) => void
}

export function DiffDialog({messages, onDone}: Props): React.ReactNode
```

**关键类型：**
```typescript
// 内部状态
type ViewMode = 'list' | 'detail'
type DiffSource = {type: 'current'} | {type: 'turn', turn: TurnDiff}

// 转换函数
function turnDiffToDiffData(turn: TurnDiff): DiffData
```

**输入输出：**
- 输入：messages（用于提取历史轮次 diff）、onDone
- 输出：React.ReactNode（Dialog 包装的 diff 视图）

**UI 状态与焦点：**
- viewMode：'list' | 'detail' - 当前视图模式
- selectedIndex：number - 当前选中文件索引
- sourceIndex：number - 当前选中源索引
- prevSourceIndex：RefObject<number> - 检测源切换

**打开流程：**
1. 调用 `useRegisterOverlay('diff-dialog')` 禁用聊天快捷键
2. 调用 `useDiffData()` 获取当前 git diff
3. 调用 `useTurnDiffs(messages)` 获取历史轮次 diff
4. 构建 sources 数组：`[{type: 'current'}, ...turnDiffs]`
5. 初始化 state：viewMode='list', selectedIndex=0, sourceIndex=0
6. useEffect：sourceIndex >= sources.length 时钳制
7. useEffect：源切换时重置 selectedIndex=0

**导航流程：**
- list 模式：
  - ↑/↓：selectedIndex ±1（clamped）
  - ←：sourceIndex -1（如果 >0）
  - →：sourceIndex +1（如果 < sources.length-1）
  - Enter：viewMode='detail'（如果 selectedFile 存在）
  - Esc：调用 onDone
- detail 模式：
  - ←/Esc：viewMode='list'

**确认/关闭流程：**
- 无确认操作（仅查看）
- 关闭：list 模式下 Esc 调用 `onDone('Diff dialog dismissed', {display: 'system'})`
- 详情模式下 Esc 仅返回列表

**空状态处理：**
- diff.loading → 显示 "Loading diff…"
- currentTurn 且无文件 → "No file changes in this turn"
- 无文件但 stats.filesCount>0 → "Too many files to display details"
- 其他 → "Working tree is clean"

**双数据源设计：**
- why：统一 DiffData 格式 → 复用同一列表/详情视图
- why：左/右键在不同模式下行为不同 → 减少学习成本
- alternative：Tab 切换源 → 被否决，Tab 用于自动补全

**源码证据：**
- `src/components/diff/DiffDialog.tsx:59-289` 完整实现
- `src/components/diff/DiffDialog.tsx:67-76` sources 数组
- `src/components/diff/DiffDialog.tsx:105` useRegisterOverlay
- `src/components/diff/DiffDialog.tsx:118-156` 快捷键处理

---

#### DiffFileList 组件

**真实入口签名：**
```typescript
// 内部组件，仅 DiffDialog 使用
function DiffFileList({
  files,
  selectedIndex,
}: {
  files: Array<{path: string; linesAdded: number; linesRemoved: number; ...}>
  selectedIndex: number
}): React.ReactNode
```

**关键类型：**
```typescript
// 常量
const MAX_VISIBLE_FILES = 5
```

**输入输出：**
- 输入：files 数组、selectedIndex
- 输出：React.ReactNode（文件列表 + 上下指示器）

**UI 状态与焦点：**
- 无内部状态（纯展示）
- 仅 5 个可见文件，selectedIndex 居中

**可见窗口计算：**
1. startIndex = max(0, selectedIndex - floor(MAX_VISIBLE_FILES / 2))
2. endIndex = min(files.length, startIndex + MAX_VISIBLE_FILES)
3. 如果 endIndex - startIndex < MAX_VISIBLE_FILES，调整 startIndex 向左
4. 显示：files.slice(startIndex, endIndex)

**上下指示器显示：**
- startIndex > 0 → "↑ N more files"
- endIndex < files.length → "↓ N more files"

**路径截断：**
- 用 `truncateStartToWidth` 截断路径开头
- 保留文件名在末尾，更容易识别

**设计取舍：**
- why：MAX_VISIBLE_FILES=5 → 终端高度有限，避免占用过多空间
- alternative：显示所有 → 被否决，变更多时占满屏幕
- why：truncateStart → 文件名比目录更重要

**源码证据：**
- `src/components/diff/DiffFileList.tsx:9` MAX_VISIBLE_FILES
- `src/components/diff/DiffFileList.tsx:19-36` 可见窗口计算
- `src/components/diff/DiffFileList.tsx:53-74` 上下指示器

---

#### CustomSelect/Select 组件

**真实入口签名：**
```typescript
// src/components/CustomSelect/select.tsx:204-225
export function Select<T>({
  isDisabled = false,
  disableSelection = false,
  hideIndexes = false,
  visibleOptionCount = 5,
  highlightText,
  options,
  defaultValue,
  onCancel,
  onChange,
  onFocus,
  defaultFocusValue,
  layout = 'compact',
  inlineDescriptions = false,
  onUpFromFirstItem,
  onDownFromLastItem,
  onInputModeToggle,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage,
}: SelectProps<T>): React.ReactNode
```

**关键类型：**
```typescript
// 选项类型
type OptionWithDescription<T = string> =
  | {type?: 'text', label: ReactNode, value: T, description?: string, disabled?: boolean, dimDescription?: boolean}
  | {type: 'input', label: ReactNode, value: T, onChange: (value: string) => void, placeholder?: string, initialValue?: string, allowEmptySubmitToCancel?: boolean, showLabelWithValue?: boolean, labelValueSeparator?: string, resetCursorOnUpdate?: boolean}

// Props
type SelectProps<T> = {
  isDisabled?: boolean
  disableSelection?: boolean
  hideIndexes?: boolean
  visibleOptionCount?: number
  highlightText?: string
  options: OptionWithDescription<T>[]
  defaultValue?: T
  onCancel?: () => void
  onChange?: (value: T) => void
  onFocus?: (value: T) => void
  defaultFocusValue?: T
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  inlineDescriptions?: boolean
  onUpFromFirstItem?: () => void
  onDownFromLastItem?: () => void
  onInputModeToggle?: (value: T) => void
  onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void
  onImagePaste?: (...) => void
  pastedContents?: Record<number, PastedContent>
  onRemoveImage?: (id: number) => void
}
```

**输入输出：**
- 输入：上述 Props
- 输出：React.ReactNode（选项列表）

**UI 状态与焦点：**
- imagesSelected：boolean（图片粘贴选择模式）
- selectedImageIndex：number
- inputValues：Map<T, string>（input 类型选项的值）
- lastInitialValues：RefObject<Map<T, string>>（检测初始值变化）
- cursor：通过 useDeclaredCursor 声明在高亮项指示器上

**状态管理（useSelectState）：**
- 管理 visibleOptionCount、options、value、focusedValue、visibleFromIndex
- 处理 defaultValue、defaultFocusValue

**键盘导航（useSelectInput）：**
- ↑：focusedValue 上移（或调用 onUpFromFirstItem）
- ↓：focusedValue 下移（或调用 onDownFromLastItem）
- Enter：onChange（如果 !disableSelection）
- Esc：onCancel
- Tab：输入模式切换（如果有 input 选项）
- Ctrl+G：打开外部编辑器（如果有 onOpenEditor）

**布局模式：**
- 'compact'：单行，可选两列（label + description）
- 'expanded'：多行，空行分隔
- 'compact-vertical'：紧凑索引，描述在下一行

**输入选项处理：**
- 跟踪 inputValues 状态
- 同步 initialValue 变化（仅用户未编辑时）
- allowEmptySubmitToCancel：true 时空值也提交，否则取消
- resetCursorOnUpdate：选项获得焦点或值变化时重置光标到末尾

**高亮文本处理：**
- 如果 option.label 是字符串且包含 highlightText，高亮匹配部分

**设计取舍：**
- why：键盘导航优先 → 终端环境鼠标支持不一致
- why：三种布局 → 适应不同场景
- why：input 选项内置 → 减少额外组件
- alternative：分离 Select 和 InputSelect → 被否决，共享逻辑多

**源码证据：**
- `src/components/CustomSelect/select.tsx:26-225` 类型 + Select 组件
- `src/components/CustomSelect/select.tsx:204-909` 完整实现
- `src/components/CustomSelect/useSelectState.ts` 状态管理
- `src/components/CustomSelect/useSelectNavigation.ts` 导航逻辑

---

#### SandboxSettings 组件

**真实入口签名：**
```typescript
// src/components/sandbox/SandboxSettings.tsx:15-28
type Props = {
  onComplete: (
    result?: string,
    options?: {display?: CommandResultDisplay},
  ) => void
  depCheck: SandboxDependencyCheck
}

export function SandboxSettings({onComplete, depCheck}: Props): React.ReactNode
```

**关键类型：**
```typescript
// 内部类型
type SandboxMode = 'auto-allow' | 'regular' | 'disabled'

// 依赖检查
type SandboxDependencyCheck = {
  errors: string[]
  warnings: string[]
}
```

**输入输出：**
- 输入：onComplete、depCheck
- 输出：React.ReactNode（Pane + Tabs）

**UI 状态与焦点：**
- 无内部状态（从 SandboxManager 读取当前设置）
- currentEnabled、currentAutoAllow、currentMode 计算自 SandboxManager
- showSocketWarning：hasWarnings && !allowAllUnixSockets

**标签页动态构建：**
- depCheck.errors 非空 → [DependenciesTab]
- depCheck.warnings 非空 → [ModeTab, DependenciesTab, OverridesTab, ConfigTab]
- 无问题 → [ModeTab, OverridesTab, ConfigTab]

**ModeTab 内部：**
- 使用 SandboxModeTab 子组件
- 显示三个选项：
  - "Sandbox BashTool, with auto-allow" (currentIndicator if selected)
  - "Sandbox BashTool, with regular permissions"
  - "No Sandbox"
- 调用 SandboxManager.setSandboxSettings 更新配置
- showSocketWarning 时显示警告信息

**确认/关闭流程：**
- 选择模式选项 → 调用 SandboxManager.setSandboxSettings → onComplete
- Esc → onComplete(undefined, {display: 'skip'})

**设计取舍：**
- why：有 errors 时仅显示 Dependencies → 强制解决后才能配置
- why：warnings 时显示全部 → 让用户知道问题但仍可操作
- alternative：始终显示所有 → 被否决，用户可能跳过问题

**源码证据：**
- `src/components/sandbox/SandboxSettings.tsx:29-160` 完整实现
- `src/components/sandbox/SandboxSettings.tsx:132-151` 标签页构建
- `src/components/sandbox/SandboxSettings.tsx:162-211` SandboxModeTab

---

#### AddWorkspaceDirectory 组件

**真实入口签名：**
```typescript
// src/components/permissions/rules/AddWorkspaceDirectory.tsx
type Props = {
  directoryPath?: string
  permissionContext: ToolPermissionContext
  onAddDirectory: (path: string, remember: boolean) => void
  onCancel: () => void
}
```

**关键类型：**
```typescript
// 记住选项
type RememberOption =
  | {type: 'session', label: string}
  | {type: 'persist', label: string}
  | {type: 'cancel', label: string}

// 输入状态
type InputState = {
  directoryInput: string
  error: string | null
  suggestions: string[]
  selectedSuggestion: number
}
```

**输入输出：**
- 输入：directoryPath（可选）、permissionContext、onAddDirectory、onCancel
- 输出：React.ReactNode（输入框或确认对话框）

**UI 状态与焦点：**
- directoryInput：string - 用户输入
- error：string | null - 验证错误
- suggestions：string[] - Tab 补全建议
- selectedSuggestion：number - 当前选中建议索引

**两种渲染分支：**
1. 无 directoryPath：
   - 显示输入框 + Tab 补全
   - Enter 验证 → 成功调用 onAddDirectory(path, false)
2. 有 directoryPath：
   - 显示确认对话框 + 三个选项
   - "Yes, for this session" → onAddDirectory(path, false)
   - "Yes, and remember this directory" → onAddDirectory(path, true)
   - "No" → onCancel

**Tab 补全流程：**
- 100ms debounce 的 getDirectoryCompletions
- 显示建议列表
- ↑/↓ 选择，Tab 接受，Esc 关闭建议

**设计取舍：**
- why：同一组件处理两种场景 → 减少重复
- why：debounce 100ms → 平衡响应性和性能
- why：记住选项显式确认 → 避免意外持久化

**源码证据：**
- `src/components/permissions/rules/AddWorkspaceDirectory.tsx` 完整实现
- `src/components/permissions/rules/AddWorkspaceDirectory.tsx:267-288` 条件渲染
- `src/components/permissions/rules/AddWorkspaceDirectory.tsx:32-50` 记住选项
- `src/components/permissions/rules/AddWorkspaceDirectory.tsx:125-141` 防抖补全

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|------|-----------|---------|------------|----------------|
| add-dir 命令 | 无（状态在 AddWorkspaceDirectory） | 验证路径、应用权限更新、刷新沙箱 | 权限裁决逻辑 | onAddDirectory(path, remember) |
| diff 命令 | 无 | 渲染 DiffDialog | Git diff 计算 | useDiffData(), useTurnDiffs() |
| sandbox-toggle 命令 | 无 | 检查依赖、显示设置 | 沙箱执行本身 | SandboxManager.setSandboxSettings() |
| AddWorkspaceDirectory | directoryInput、error、suggestions、selectedSuggestion | 路径输入、自动补全、记住选项选择 | 目录内容操作 | getDirectoryCompletions() |
| DiffDialog | viewMode、selectedIndex、sourceIndex | 源切换、文件选择、详情查看 | Diff 解析 | useDiffData(), useTurnDiffs() |
| DiffFileList | 无（纯展示） | 渲染文件列表、上下指示器 | 文件选择逻辑 | files、selectedIndex |
| FullscreenLayout | stickyPrompt、pillVisible | 滚动订阅、粘性提示、新消息药丸 | 消息渲染 | ScrollChromeContext.setStickyPrompt() |
| useUnseenDivider | dividerIndex、dividerYRef（ref） | snapshot 位置、检测未读、跳转到底部 | 消息内容解析 | onScrollAway(handle)、onRepin() |
| CustomSelect | 内部状态（useSelectState）+ inputValues | 键盘导航、选项选择 | 业务逻辑 | options、onChange、onCancel |
| SandboxSettings | 无（状态在沙箱管理器） | 显示标签页、设置模式 | 沙箱隔离实现 | SandboxManager.setSandboxSettings() |
| useRegisterOverlay | 无（状态在 AppState.activeOverlays） | 注册/注销模态、invalidatePrevFrame | 快捷键裁决本身 | useIsOverlayActive()、useIsModalOverlayActive() |

### 4.3 主控制流

#### 完整的 /add-dir 交互流程

```
用户输入 /add-dir
  → 命令 call()
    → 无路径 → 返回 AddWorkspaceDirectory 输入框
      → 用户输入路径 + Tab 补全（debounced 100ms）
      → 用户按 Enter → validateDirectoryForWorkspace
        → 成功 → onAddDirectory(path, false)
          → applyPermissionUpdate（权限上下文）
          → setAdditionalDirectoriesForClaudeMd（bootstrap）
          → SandboxManager.refreshConfig()
          → onDone(message)
        → 失败 → 显示错误信息

用户输入 /add-dir /some/path
  → 命令 call()
    → validateDirectoryForWorkspace
      → 成功 → 返回 AddWorkspaceDirectory 确认对话框（预填路径）
        → 用户选择记住选项 → onAddDirectory(path, true)
          → applyPermissionUpdate
          → setAdditionalDirectoriesForClaudeMd
          → SandboxManager.refreshConfig()
          → persistPermissionUpdate（写入本地设置）
          → onDone(message)
      → 失败 → 返回 AddDirError 组件 → setTimeout 0 后 onDone
```

#### 完整的 /diff 交互流程

```
用户输入 /diff
  → 命令 call()
    → 动态 import DiffDialog
    → 返回 <DiffDialog messages={context.messages} onDone={onDone} />
      → useRegisterOverlay('diff-dialog') 禁用聊天快捷键
      → useDiffData() 获取当前 git diff
      → useTurnDiffs(messages) 获取历史轮次 diff
      → 构建 sources 数组
      → 初始视图：列表模式，选中第 0 个文件，当前源

用户按 ↓ → selectedIndex + 1
用户按 Enter → viewMode = 'detail'
用户按 ← → viewMode = 'list'（如果在详情模式）或 sourceIndex - 1（如果在列表模式且有多个源）
用户按 → → sourceIndex + 1（如果在列表模式且有多个源）
用户按 Esc → onDone（如果在列表模式）或 viewMode = 'list'（如果在详情模式）
```

#### 完整的新消息检测流程

```
新消息到达
  → REPL 计算 newMessageCount（通过 computeUnseenDivider）
  → 用户向上滚动（触发 wheel 事件）
    → ScrollBox 调用 onScroll(false, ...)
    → REPL 调用 onScrollAway(handle)
      → 检查 scrollTop + pendingDelta < max
      → snapshot dividerYRef = handle.getScrollHeight()
      → setDividerIndex = current message count
  → FullscreenLayout pillVisible 变为 true
    → 渲染新消息药丸

用户点击药丸（或按快捷键）
  → onPillClick → handle.scrollToBottom()
  → 新消息到达时 REPL 调用 onRepin()
    → setDividerIndex(null)
    → useEffect 清除 dividerYRef（延迟到状态提交后）
  → pillVisible 变为 false
    → 隐藏药丸
```

#### 自定义选择组件流程

```
<Select options={...} onChange={...} onCancel={...}>
  → useSelectState 管理 isOpen/selectedValue
  → useSelectNavigation 管理 highlightedIndex，响应 ↑/↓
  → useKeybindings 注册 Enter/Esc 快捷键（Settings 上下文）
  → 用户按 ↑/↓ → highlightedIndex 更新
  → 用户按 Enter → onChange(options[highlightedIndex].value)
  → 用户按 Esc → onCancel()
```

#### 覆盖层注册与 full-damage 流程

```
对话框打开
  → useRegisterOverlay('dialog-id', enabled=true)
  → useEffect 添加 id 到 activeOverlays
  → 聊天快捷键禁用（通过 useIsOverlayActive）

对话框关闭
  → useLayoutEffect cleanup 调用 invalidatePrevFrame()
  → 下一次渲染使用 full-damage diff（而非 blit）
  → 避免高对话框留下的残影
  → useEffect cleanup 从 activeOverlays 移除 id
```

#### 沙箱异步刷新竞态处理

```
用户确认添加目录
  → applyPermissionUpdate（同步，更新权限）
  → setAdditionalDirectoriesForClaudeMd（同步，更新 bootstrap）
  → SandboxManager.refreshConfig()（async，不等待）
  → onDone(message)（立即调用，不等待沙箱刷新）

设计：async 不等待
  → why：用户体验优先，避免阻塞
  → 代价：理论竞态窗口（用户在刷新完成前使用）
  → 缓解：刷新很快，实际风险很低
```

### 4.4 数据结构与持久化

#### 核心数据结构

```typescript
// Diff 数据（统一格式，支持当前和历史）
type DiffData = {
  stats?: { filesCount: number; linesAdded: number; linesRemoved: number }
  files: Array<{
    path: string
    linesAdded: number
    linesRemoved: number
    isBinary: boolean
    isLargeFile: boolean
    isTruncated: boolean
    isNewFile: boolean
  }>
  hunks: Map<string, StructuredPatchHunk[]>
  loading: boolean
}

// 历史轮次 Diff
type TurnDiff = {
  turnIndex: number
  userPromptPreview: string | null
  files: Map<string, { filePath: string; hunks: StructuredPatchHunk[]; ... }>
  stats: { filesChanged: number; linesAdded: number; linesRemoved: number }
}

// 未读分隔线
type UnseenDivider = {
  firstUnseenUuid: string  // 消息 uuid，用于渲染定位
  count: number            // 未读助理轮次数（最小为 1）
}

// 自定义选择选项
type SelectOption<T> = {
  value: T
  label: string
}

// 沙箱依赖检查
type SandboxDependencyCheck = {
  errors: string[]
  warnings: string[]
}
```

#### 持久化与恢复

- **附加目录**：remember=true 时写入本地设置（`persistPermissionUpdate`），否则仅会话中存在
- **沙箱设置**：立即写入配置文件，无撤销
- **未读分隔线**：仅内存中存在，会话结束丢失
- **对话框状态**：不持久化，关闭即重置

### 4.5 跨子系统依赖

| 依赖 | 用途 | 本 spec 中的使用点 | 负责的 spec |
|-----|------|------------------|------------|
| applyPermissionUpdate | 更新工具权限 | add-dir 命令 | 权限 spec |
| persistPermissionUpdate | 持久化权限设置 | add-dir 命令（remember=true） | 权限 spec |
| getAdditionalDirectoriesForClaudeMd | 获取会话附加目录 | add-dir 命令 | bootstrap spec |
| setAdditionalDirectoriesForClaudeMd | 设置会话附加目录 | add-dir 命令 | bootstrap spec |
| SandboxManager.refreshConfig | 刷新沙箱配置 | add-dir 命令 | 沙箱 spec |
| SandboxManager.checkDependencies | 检查沙箱依赖 | sandbox-toggle 命令 | 沙箱 spec |
| SandboxManager.setSandboxSettings | 更新沙箱设置 | SandboxSettings 组件 | 沙箱 spec |
| useDiffData | 获取 git diff | DiffDialog | Git 集成 spec |
| useTurnDiffs | 获取历史轮次 diff | DiffDialog | 消息渲染 spec |
| useRegisterOverlay | 注册模态对话框 | DiffDialog、AddWorkspaceDirectory | 覆盖层 spec |
| useKeybindings | 键盘快捷键 | 所有对话框组件 | 快捷键 spec |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|---------------|--------------|-------------|
| 目录验证失败（不存在、无权限等） | validateDirectoryForWorkspace | 返回 {resultType: 'error', message: ...} | 否 | 无（验证阶段不修改状态） | add-dir 命令显示帮助信息 |
| 沙箱平台不支持 | sandbox-toggle.call | 立即 onDone 错误信息 | 否 | 无 | 用户看到平台不支持提示 |
| 沙箱设置被锁定 | SandboxManager.areSandboxSettingsLockedByPolicy | 立即 onDone 错误信息 | 否 | 无 | 用户看到设置被锁定提示 |
| 沙箱依赖缺失 | depCheck.errors 非空 | 仅显示 Dependencies 标签页 | 否 | 无 | 用户看到依赖问题但无法配置 |
| 对话框 Esc 取消 | Dialog 内置 useKeybindings('confirm:no') | 调用 onCancel 回调 | 否 | 无（对话框关闭） | diff/sandbox-toggle 返回 "dismissed"，add-dir 返回 "did not add" |
| 沙箱 exclude 子命令无参数 | sandbox-toggle.call | 立即 onDone 错误信息 | 否 | 无 | 用户看到要求提供模式的提示 |
| Git diff 加载中 | useDiffData.loading | 显示 "Loading diff…" | 否 | 无 | 用户看到加载状态 |
| 无变更文件 | diffData.files 为空 | 显示 "Working tree is clean" 或 "No file changes in this turn" | 否 | 无 | 用户看到空状态提示 |
| 文件太多无法显示详情 | diffData.stats.filesCount > 0 但 diffData.files 为空 | 显示 "Too many files to display details" | 否 | 无 | 用户看到提示但无文件列表 |
| ScrollBox 订阅回调抛出异常 | useSyncExternalStore | 无显式处理（React 错误边界会捕获） | 否 | 无（药丸可能不显示，但不影响核心功能） | 无（用户可见的回退是不显示药丸） |
| persistPermissionUpdate 抛出异常 | add-dir handleAddDirectory | 捕获并在 message 中提示 | 否 | 权限和沙箱已更新（部分成功） | 用户看到 "Added ... but failed to save" |

### 工程取舍说明

**取舍 1：AddDirError 使用 setTimeout 0 调用 onDone**
- 理由：React 会在返回 null 时立即卸载组件，导致错误消息来不及渲染
- 代价：需要额外组件包装，逻辑复杂
- 证据：`src/commands/add-dir/add-dir.tsx:24-51` AddDirError 组件

**取舍 2：DiffDialog 列表/详情模式复用同一组方向键**
- 理由：减少快捷键数量，避免冲突
- 代价：用户需要学习上下文相关的行为
- 证据：`src/components/diff/DiffDialog.tsx:118-156` 视图模式相关的快捷键处理

**取舍 3：FullscreenLayout pillVisible 使用 useSyncExternalStore 而不是 prop drilling**
- 理由：避免每次滚动都重渲染整个 REPL（有 22+ 个 useAppState 选择器）
- 代价：代码复杂度增加，ScrollBox 需要实现订阅接口
- 证据：`src/components/FullscreenLayout.tsx:326-338` pillVisible 订阅逻辑

**取舍 4：AddWorkspaceDirectory 用同一个组件处理输入和确认两种场景**
- 理由：减少代码重复，共享路径验证逻辑
- 代价：组件内部有条件分支，复杂度增加
- 证据：`src/components/permissions/rules/AddWorkspaceDirectory.tsx:267-288` 条件渲染

**取舍 5：countUnseenAssistantTurns 跳过纯 tool-use 的 assistant 轮次**
- 理由：用户不认为纯工具调用是"新消息"，不应该触发药丸计数
- 代价：需要检查消息内容，不是仅检查类型
- 证据：`src/components/FullscreenLayout.tsx:224-251` 跳过逻辑

**取舍 6：dividerYRef 是 ref 而不是 state，onRepin 时延迟清除**
- 理由：避免与 wheel 事件竞态（状态更新是异步的，ref 是同步的）
- 代价：需要 useEffect 在状态提交后清除 ref
- 证据：`src/components/FullscreenLayout.tsx:187-194` 延迟清除注释

**取舍 7：沙箱 refreshConfig 是 async 但不等待**
- 理由：用户体验优先，避免阻塞
- 代价：理论竞态窗口（用户在刷新完成前使用）
- 缓解：刷新很快，实际风险很低
- 证据：`src/commands/add-dir/add-dir.tsx:84-92` 注释

**取舍 8：useRegisterOverlay 的 invalidatePrevFrame 使用 useLayoutEffect**
- 理由：同步清理，确保在 scheduleRender 前运行
- 代价：需要理解 React effect 顺序
- 证据：`src/context/overlayContext.tsx:60-71` 注释

**取舍 9：DiffFileList 只显示 5 个文件**
- 理由：终端高度有限，避免占用过多空间
- 代价：用户需要滚动，可能看不到全部文件
- 证据：`src/components/diff/DiffFileList.tsx:9` MAX_VISIBLE_FILES

**取舍 10：CustomSelect 支持三种布局模式**
- 理由：适应不同场景需求
- 代价：组件复杂度增加
- 证据：`src/components/CustomSelect/select.tsx` 多分支渲染

## 6. 现状验收标准

### /add-dir 验收

1. 给定无参数调用 `/add-dir`，当用户输入路径按 Enter 时，系统必须验证目录并添加到会话，不持久化。
2. 给定 `/add-dir /some/path`，当命令执行时，系统必须显示确认对话框（预填路径），提供三个选项：会话/记住/取消。
3. 给定用户在输入框中按 Tab，当有多个匹配目录时，系统必须显示建议列表，支持上下选择，Tab 接受建议。
4. 给定用户选择 "Yes, and remember this directory"，当确认后，系统必须同时更新权限、bootstrap 状态、沙箱配置，并写入本地设置。
5. 给定目录验证失败，当显示错误时，系统必须使用 setTimeout 0 延迟调用 onDone，确保错误消息先渲染。

### /diff 验收

1. 给定调用 `/diff`，当打开时，系统必须显示当前 git diff（如果有），支持列表/详情两种视图。
2. 给定对话历史中有文件变更轮次，当打开 diff 时，系统必须显示源选择器（Current、T1、T2...），支持左右键切换。
3. 给定用户在列表模式按 Enter，当有选中文件时，系统必须切换到详情模式显示该文件的 diff。
4. 给定用户在详情模式按 Esc，当执行时，系统必须返回列表模式；在列表模式按 Esc，必须关闭对话框。
5. 给定有超过 5 个文件，当显示列表时，系统必须只显示 5 个，带有上下指示器，支持滚动。
6. 给定无变更文件，当打开时，系统必须显示 "Working tree is clean"（当前）或 "No file changes in this turn"（历史）。

### /sandbox-toggle 验收

1. 给定在 WSL1 上调用 `/sandbox-toggle`，当执行时，系统必须立即报错，不显示设置界面。
2. 给定沙箱依赖有 errors，当打开时，系统必须仅显示 Dependencies 标签页，不允许配置。
3. 给定沙箱依赖有 warnings 但无 errors，当打开时，系统必须显示全部标签页，但在 Mode 标签页显示警告。
4. 给定用户选择模式选项，当确认时，系统必须立即调用 SandboxManager.setSandboxSettings 并退出。
5. 给定调用 `/sandbox-toggle exclude "npm run test:*"`，当执行时，系统必须添加到排除列表并写入本地设置。

### FullscreenLayout 验收

1. 给定用户向上滚动，当有新消息到达时，系统必须显示新消息药丸（或 "Jump to bottom" 如果还没有新消息）。
2. 给定用户向上滚动阅读历史，当滚动超过一个提示时，系统必须在顶部显示粘性提示（truncate-end，1 行高度）。
3. 给定用户点击粘性提示，当执行时，系统必须滚动回该提示位置并隐藏粘性提示。
4. 给定用户滚动回到底部，当执行时，系统必须隐藏药丸并清除未读分隔线。
5. 给定新消息 prepend（历史加载），当执行时，系统必须调用 shiftDivider 调整分隔线位置。
6. 给定显示模态对话框，当打开时，系统必须在底部显示带有 ▔ 分隔线的对话框，保留几行历史预览。

### CustomSelect 验收

1. 给定打开 Select，当按上下方向键时，系统必须高亮显示选项，支持循环。
2. 给定高亮一个选项，当按 Enter 时，系统必须调用 onChange 并关闭。
3. 给定按 Esc，当执行时，系统必须调用 onCancel 并关闭。
4. 给定有 useTabHeaderFocus 的集成，当按 ↑ 从第一个选项时，系统必须聚焦到标签头。

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| /add-dir 同时更新权限、bootstrap 状态、沙箱配置 | `src/commands/add-dir/add-dir.tsx:62-109` | snapshotUpdateDialog.test.tsx（部分相关） | 沙箱刷新是 async 但命令不等待 |
| AddWorkspaceDirectory 支持输入和确认两种模式 | `src/components/permissions/rules/AddWorkspaceDirectory.tsx:267-288` | snapshotUpdateDialog.test.tsx | 仅 snapshot 测试，无交互测试 |
| AddDirError 用 setTimeout 0 调用 onDone | `src/commands/add-dir/add-dir.tsx:24-51` | 无直接测试 | 注释说明 |
| DiffDialog 支持双数据源（当前/历史） | `src/components/diff/DiffDialog.tsx:67-76` | 无直接测试 | useTurnDiffs 来自消息历史 |
| DiffDialog 视图模式相关的方向键行为 | `src/components/diff/DiffDialog.tsx:118-156` | 无直接测试 | 注释说明视图模式相关 |
| DiffFileList 只显示 5 个文件，带上下指示器 | `src/components/diff/DiffFileList.tsx:9, 53-74` | 无直接测试 | MAX_VISIBLE_FILES = 5 |
| FullscreenLayout pillVisible 用 useSyncExternalStore | `src/components/FullscreenLayout.tsx:326-338` | 无直接测试 | 订阅 ScrollBox，非标准 React 模式 |
| useUnseenDivider snapshot scrollHeight，支持 shift | `src/components/FullscreenLayout.tsx:99-214` | 无直接覆盖 | dividerYRef 是 ref，dividerIndex 是 state |
| countUnseenAssistantTurns 跳过纯 tool-use 轮次 | `src/components/FullscreenLayout.tsx:224-251` | 无直接覆盖 | 检查 message.content 块 |
| onRepin 延迟清除 dividerYRef 避免竞态 | `src/components/FullscreenLayout.tsx:187-194` | 无直接覆盖 | useEffect 在状态提交后清除 |
| SandboxSettings 根据依赖检查动态显示标签页 | `src/components/sandbox/SandboxSettings.tsx:132-151` | 无直接覆盖 | errors → 仅 Dependencies；warnings → 全部；无问题 → 无 Dependencies |
| CustomSelect 支持键盘导航、Enter 确认、Esc 取消 | `src/components/CustomSelect/select.tsx` 及相关 hooks | 无直接覆盖 | Settings 上下文的快捷键 |
| useRegisterOverlay 禁用聊天快捷键 | `src/components/diff/DiffDialog.tsx:105, src/context/overlayContext.tsx:37-72` | 无直接覆盖 | useRegisterOverlay 注册活动覆盖层，在 overlay 活动时禁用聊天快捷键，关闭时强制下一次渲染使用 full-damage diff 而非 blit 避免幽灵残留 |
| 未读分隔线支持 prepend shift | `src/components/FullscreenLayout.tsx:197-214` | 无直接覆盖 | 无限滚动历史消息时使用 |
| useRegisterOverlay invalidatePrevFrame 用 useLayoutEffect | `src/context/overlayContext.tsx:60-71` | 无直接覆盖 | 同步清理确保在 scheduleRender 前 |
| 沙箱 refreshConfig async 不等待 | `src/commands/add-dir/add-dir.tsx:84-92` | 无直接覆盖 | 注释说明竞态风险 |
| CustomSelect 三种布局模式 | `src/components/CustomSelect/select.tsx:312-909` | 无直接覆盖 | compact/expanded/compact-vertical |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/workspace-ui.yaml)

### 覆盖分组职责说明

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|------|-----------|------------------|----------------|
| add-dir-command | /add-dir 命令实现、路径验证、权限应用 | snapshotUpdateDialog.test.tsx | 权限裁决逻辑 |
| diff-command | /diff 命令实现、DiffDialog 渲染 | 无直接测试 | Git diff 计算 |
| sandbox-toggle-command | /sandbox-toggle 命令实现、依赖检查 | 无直接测试 | 沙箱隔离实现 |
| diff-components | DiffDialog、DiffFileList、DiffDetailView | 无直接测试 | Git diff 解析 |
| add-workspace-directory | AddWorkspaceDirectory 对话框组件 | snapshotUpdateDialog.test.tsx | 权限持久化 |
| fullscreen-layout | FullscreenLayout、useUnseenDivider、新消息药丸 | 无直接测试 | 消息渲染 |
| custom-select | CustomSelect 及相关 hooks | 无直接测试 | 业务逻辑 |
| sandbox-components | SandboxSettings、各标签页组件 | 无直接测试 | 沙箱管理器 |
| ui-components | OrderedList、TreeSelect | 无直接测试 | |
| overlay-context | useRegisterOverlay、useIsOverlayActive | 无直接测试 | 快捷键系统本身 |

### 相关子系统

- **权限系统**：负责目录访问控制，本 spec 仅描述 add-dir 如何调用 applyPermissionUpdate/persistPermissionUpdate
- **沙箱系统**：负责 Bash 命令隔离，本 spec 仅描述如何刷新配置和设置模式
- **Git 集成**：负责 diff 计算，本 spec 仅描述 useDiffData 的使用
- **覆盖层系统**：负责模态对话框管理，本 spec 仅描述 useRegisterOverlay 的使用，具体实现在 `src/context/overlayContext.tsx`
- **快捷键系统**：负责全局快捷键注册，本 spec 仅描述上下文相关的快捷键使用
- **消息渲染**：负责渲染对话消息，本 spec 仅描述 useTurnDiffs 的使用和未读分隔线计算

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|---------|-------|-------|
| P2 | DiffDialog 当前仅支持键盘导航，不支持鼠标点击选择文件 | 添加鼠标点击支持（终端 mouse tracking） | 低：作为可选增强 | 用户可以用鼠标点击选择文件、切换源、返回列表 | M | 待运行验证 |
| P2 | 当前无测试覆盖工作区 UI 的交互逻辑 | 添加对话框交互的集成测试 | 低：仅添加测试 | 测试可以模拟键盘输入，验证视图切换、选项选择、关闭等 | M | 待运行验证 |
| P2 | FullscreenLayout 粘性提示在有 overlay（如权限对话框）时被隐藏 | 在有 overlay 时仍显示粘性提示 | 低：仅条件调整 | 权限对话框打开时顶部仍能看到粘性提示 | S | 待运行验证 |
| P3 | DiffDialog 无搜索/过滤功能，文件多时难以找到 | 添加简单的按路径过滤功能 | 低：作为新增功能 | 用户可以输入过滤字符串，仅显示匹配的文件 | M | 待运行验证 |
| P3 | CustomSelect 无快捷键提示（如 "↑/↓ 选择，Enter 确认，Esc 取消"） | 在底部添加快捷键提示 | 低：仅 UI 添加 | 用户可以在 Select 底部看到快捷键提示 | S | 待运行验证 |
| P3 | add-dir 记住选项后无法在界面中查看或删除已记住的目录 | 添加目录管理界面 | 中：需要新的命令/对话框 | 用户可以通过 `/add-dir list` 或类似命令查看和删除已记住的目录 | L | 设计推断 |
| P3 | 沙箱 refreshConfig 不等待的竞态窗口 | 添加刷新状态，或在沙箱命令中检查是否需要等待 | 中：改变异步时序 | 沙箱命令执行前确认配置已刷新 | M | 待运行验证 |
| P3 | CustomSelect 输入选项的初始值同步逻辑复杂 | 简化状态管理，考虑使用受控组件模式 | 中：重构核心逻辑 | input 选项行为一致，无边界情况 | M | 待运行验证 |

### 优先级说明

- **P2**：局部可维护性、体验改进、测试缺口。不影响核心正确性，但能提升效率或可测试性。
- **P3**：可选体验、功能增强。明确非紧急，可延后处理。
