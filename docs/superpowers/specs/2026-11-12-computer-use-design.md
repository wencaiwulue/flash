---
id: computer-use
batch: 2
title: Computer Use 浏览器与桌面自动化后端设计
date: 2026-11-12
status: draft
---

# Computer Use 浏览器与桌面自动化后端设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Computer Use 是 Claude Code 提供的桌面与浏览器自动化能力，支持两种后端实现：
- **Native Adapter**：基于 Swift + Rust 原生实现的 macOS 桌面控制
- **Zavora MCP**：基于 MCP 协议的第三方实现

本设计文档描述 Computer Use 的架构、后端抽象、安全机制与设计决策。

核心约束：
- 同一台主机不能由多个会话并发控制，必须通过跨进程锁明确持有者并处理进程死亡、锁损坏和过期恢复。
- 截图、输入、剪贴板和系统组合键具有不同隐私边界；应用授权必须精确匹配，TCC 缺失必须在动作前失败。
- Native Adapter 当前依赖 macOS Swift/Rust 与 CFRunLoop，Zavora 通过 MCP 提供另一后端；统一接口不能掩盖两者能力和清理方式差异。
- 坐标必须保留显示器原点、物理像素与缩放元数据，归一化输入限制在 `[0,1]`，避免多显示器下误操作。
- 回合自然结束、流式中止和工具中止都必须恢复隐藏应用、注销 ESC、关闭后端并释放锁；单个清理步骤失败不得阻断其余步骤。

## 2. 设计理由与备选方案

### 决策 1：双后端架构（Native vs Zavora）

| 维度 | Native Adapter | Zavora MCP |
|------|----------------|------------|
| 平台 | macOS only | 多平台 |
| 实现 | Swift + Rust | 第三方 MCP |
| ESC 中止 | CGEventTap | Zavora 控制 |
| 截图过滤 | 原生 | 依赖后端 |
| 速度 | 快 | 稍慢 |

**决策理由**：Native 提供最佳 macOS 体验，Zavora 提供跨平台能力和未来扩展。

### 决策 2：文件锁而非内存锁

| 选项 | 优点 | 缺点 |
|------|------|------|
| 文件锁 | 跨进程、持久化 | 需要处理过期 |
| 内存锁 | 简单 | 仅单进程 |

**决策理由**：支持多 Claude Code 会话，防止并发控制冲突。

**替代方案**：命名信号量。未选择，因为文件锁更简单且支持检查锁持有者。

**证据**：`computerUseLock.ts` 的 O_EXCL 创建 + PID 存活检查。

### 决策 3：终端作为 Surrogate Host

| 选项 | 优点 | 缺点 |
|------|------|------|
| Surrogate Host | 终端不被隐藏 | 需要检测终端 Bundle ID |
| 固定 Host | 简单 | 终端可能被隐藏 |

**决策理由**：用户需要看到 Claude Code 的输出，不能被隐藏。

**替代方案**：将终端加入白名单。未选择，因为白名单应用会被截图，可能暴露敏感信息。

**证据**：`executor.ts` 的 `withoutTerminal` 过滤 + `surrogateHost` 传递。

### 决策 4：JSON Lines 协议

| 选项 | 优点 | 缺点 |
|------|------|------|
| JSON Lines | 简单、人类可读、流式 | 二进制效率低 |
| Protocol Buffers | 高效 | 需要编译 schema |
| IPC Channel | 原生 | Node.js 侧复杂 |

**决策理由**：Native Helper 调用频率低，JSON 足够，开发效率优先。

**证据**：`nativeHelper.ts` 的 `NativeHelperClient` 实现。

### 决策 5：drainRunLoop 包装

| 选项 | 优点 | 缺点 |
|------|------|------|
| drainRunLoop | 窗口事件正常处理 | 30s 超时限制 |
| 不包装 | 简单 | 窗口闪烁、事件堆积 |

**决策理由**：Electron 持续运行 CFRunLoop，CLI 需要手动泵。

**替代方案**：使用 N-API 主线程回调。未选择，因为复杂度高，当前方案足够。

**证据**：`drainRunLoop.ts` + `executor.ts` 中所有 Swift 调用的包装。

## 3. 目标与非目标

### 目标

- 以 `ComputerUseBackend` 统一 Native 与 Zavora 的工具枚举、调用分发、AbortSignal 和关闭语义。
- 以 `ComputerExecutor`、`ComputerUseHostAdapter` 和 `ComputerUseSessionContext` 隔离平台动作、宿主能力与会话状态。
- 提供截图、缩放、输入、剪贴板、应用管理、显示器选择及应用隐藏能力，并记录坐标转换所需元数据。
- 在每次动作前执行 OS 权限、应用授权、子门控和会话锁检查，提供用户可按 ESC 中止的控制路径。
- 动态加载原生模块并限制工具 schema，非 Computer Use 回合不承担相关加载成本。

### 非目标

- 不在本文实现 Swift/Rust 内部算法或第三方 Zavora 服务端，也不承诺 Native Adapter 跨平台运行。
- 不允许多会话同时控制桌面，不把内存锁当作跨进程互斥方案。
- 不将应用白名单等同于截图安全保证；终端 Surrogate Host 与截图可见性必须分别处理。
- 不在后台会话结束后保留隐藏应用、热键或文件锁，不在线验证真实桌面环境之外的服务能力。

## 4. 架构、模块与数据流

### 4.1 后端抽象

#### 4.1.1 后端接口

```typescript
type ComputerUseBackendKind = 'zavora' | 'native-adapter';

type ComputerUseBackend = {
  kind: ComputerUseBackendKind;
  listTools(): Promise<ComputerUseTool[]>;
  dispatch(
    name: string,
    args: unknown,
    context: ComputerUseSessionContext,
    signal: AbortSignal,
  ): Promise<CuCallToolResult>;
  close(): Promise<void>;
};
```

#### 4.1.2 执行器抽象

`ComputerExecutor` 定义了与平台无关的桌面控制接口：

```typescript
type ComputerExecutor = {
  capabilities: ComputerUseCapabilities & { hostBundleId: string };
  
  // 截图相关
  screenshot(opts: { allowedBundleIds: string[]; displayId?: number }): Promise<ScreenshotResult>;
  zoom(region: { x: number; y: number; w: number; h: number }, ...): Promise<...>;
  resolvePrepareCapture(opts: { ... }): Promise<ResolvePrepareCaptureResult>;
  
  // 输入相关
  key(keySequence: string, repeat?: number): Promise<void>;
  holdKey(keyNames: string[], durationMs: number): Promise<void>;
  type(text: string, opts: { viaClipboard: boolean }): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: 'left' | 'right' | 'middle', count: 1 | 2 | 3, modifiers?: string[]): Promise<void>;
  drag(from: { x: number; y: number } | undefined, to: { x: number; y: number }): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  
  // 剪贴板
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  
  // 应用管理
  prepareForAction(allowlistBundleIds: string[], displayId?: number): Promise<string[]>;
  getFrontmostApp(): Promise<FrontmostApp | null>;
  listInstalledApps(): Promise<InstalledApp[]>;
  listRunningApps(): Promise<RunningApp[]>;
  openApp(bundleId: string): Promise<void>;
  
  // 显示管理
  getDisplaySize(displayId?: number): Promise<DisplayGeometry>;
  listDisplays(): Promise<DisplayGeometry[]>;
};
```

#### 4.1.3 Host Adapter 接口

`ComputerUseHostAdapter` 是 Native Adapter 的核心接口，连接 MCP 包与具体实现：

```typescript
type ComputerUseHostAdapter = {
  serverName: string;
  logger: Logger;
  executor: ComputerExecutor;
  ensureOsPermissions(): Promise<OsPermissionState>;
  isDisabled(): boolean;
  getSubGates(): CuSubGates;
  getAutoUnhideEnabled(): boolean;
  cropRawPatch(...args: unknown[]): Buffer | null;
};
```

#### 4.1.4 Session Context 接口

`ComputerUseSessionContext` 定义了工具执行期间与 Claude Code 会话状态交互的接口：

```typescript
type ComputerUseSessionContext = {
  // 读取
  getAllowedApps(): readonly AppGrant[];
  getGrantFlags(): CuGrantFlags;
  getUserDeniedBundleIds(): readonly string[];
  getSelectedDisplayId(): number | undefined;
  getDisplayPinnedByModel(): boolean;
  getDisplayResolvedForApps(): string | undefined;
  getLastScreenshotDims(): ScreenshotDims | undefined;
  
  // 写入
  onPermissionRequest(request: CuPermissionRequest, dialogSignal: AbortSignal): Promise<CuPermissionResponse>;
  onAllowedAppsChanged(apps: readonly AppGrant[], flags: CuGrantFlags): void;
  onAppsHidden(bundleIds: readonly string[]): void;
  onResolvedDisplayUpdated(displayId: number): void;
  onDisplayPinned(displayId: number | undefined): void;
  onDisplayResolvedForApps(key: string | undefined): void;
  onScreenshotCaptured(dims: ScreenshotDims): void;
  
  // 锁
  checkCuLock(): Promise<{ holder: string | undefined; isSelf: boolean }>;
  acquireCuLock(): Promise<void>;
  formatLockHeldMessage(holder: string): string;
};
```

### 4.2 截图与输入

#### 4.2.1 截图流程

1. **Prepare Capture**：`resolvePrepareCapture` 执行权限检查、显示解析、应用隐藏
2. **Screenshot Capture**：`screenshot` 调用 Swift 端的 `captureExcluding`
3. **Resize**：使用 `targetImageSize` 将物理像素缩放到 API 目标尺寸（max 1568x1568, 1.15M pixels）
4. **Metadata Recording**：`onScreenshotCaptured` 记录显示原点、尺寸、缩放因子

#### 4.2.2 坐标系统

支持两种坐标模式：

- **Normalized**：`[0, 1]` 范围的归一化坐标，原点在左上角
- **Pixels**：物理像素坐标，带显示原点偏移

坐标转换公式（Native Adapter）：
```
logical_x = (pixel_x - origin_x) / width
logical_y = (pixel_y - origin_y) / height
```

#### 4.2.3 输入执行

输入操作通过 `drainRunLoop` 包装，确保 CFRunLoop 正常运转：

- **Key Sequence**：`key` 方法支持 `ctrl+shift+a` 格式，8ms 间隔
- **Type via Clipboard**：保存剪贴板 → 写入文本 → 验证 → Cmd+V → 恢复
- **Mouse Move**：`moveAndSettle` 立即移动 + 50ms 等待
- **Mouse Drag**：`animatedMove` 使用 ease-out-cubic 缓动，60fps，最长 0.5s

#### 4.2.4 Native Helper

Swift 二进制通过 JSON Lines 协议与 Node.js 通信：

```typescript
class NativeHelperClient {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(event: 'escape', listener: () => void): () => void;
  close(): Promise<void>;
}
```

每请求 30s 超时，支持 AbortSignal，事件驱动接收 Escape 按键。

### 4.3 应用隐藏与显示

#### 4.3.1 隐藏白名单

`prepareForAction` 接收 `allowlistBundleIds`，隐藏所有不在白名单的应用。终端作为 Surrogate Host 被豁免：

```typescript
const surrogateHost = terminalBundleId ?? CLI_HOST_BUNDLE_ID;
const withoutTerminal = (allowed: readonly string[]): string[] => 
  terminalBundleId === null ? [...allowed] : allowed.filter(id => id !== terminalBundleId);
```

#### 4.3.2 Sentinel Apps

`SENTINEL_APPS` 定义了敏感应用，包括 Terminal、Finder、System Settings 等，用于权限对话框的特殊提示。

#### 4.3.3 显示解析

`autoResolve` 模式：
1. 查找目标应用窗口所在的显示器
2. 如果找不到，使用主显示器
3. 记录 `displayResolvedForApps` 键

### 4.4 锁与 ESC 中止

#### 4.4.1 文件锁

使用 O_EXCL 原子创建的文件锁，位于 `~/.claude/computer-use.lock`：

```typescript
type ComputerUseLock = {
  sessionId: string;
  pid: number;
  acquiredAt: number;
};
```

锁获取流程：
1. 尝试 `wx` 模式创建
2. 如果存在，检查是否为自己或过期
3. 过期则删除重试

#### 4.4.2 Escape 热键

Native Adapter 注册 CGEventTap 监听 Escape 按键：

- 用户按下 Escape → 触发 `abortController.abort()`
- 模型合成的 Escape → 通过 `notifyExpectedEscape` 豁免

#### 4.4.3 通知

- **Enter**："Claude is using your computer · press Esc to stop"
- **Exit**："Claude is done using your computer"

### 4.5 权限与隐私

#### 4.5.1 OS 权限检查

TCC 权限预检查：
- Accessibility（辅助功能）
- Screen Recording（屏幕录制）

失败返回 `tcc_denied` 结构化错误。

#### 4.5.2 应用授权

`ComputerUseApproval` 对话框显示：
- 请求的应用列表
- 权限标志（剪贴板读写、系统组合键）
- TCC 状态
- 将被隐藏的应用预览

#### 4.5.3 权限标志

```typescript
type CuGrantFlags = {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  systemKeyCombos: boolean;
};
```

#### 4.5.4 子门控

```typescript
type CuSubGates = {
  pixelValidation: boolean;
  clipboardPasteMultiline: boolean;
  mouseAnimation: boolean;
  hideBeforeAction: boolean;
  autoTargetDisplay: boolean;
  clipboardGuard: boolean;
};
```

### 4.6 Native 与 Stub 边界

#### 4.6.1 外部存根

`src/external-stubs/computer-use-*.ts` 提供：
- `computer-use-types.ts`：类型定义
- `computer-use-native.ts`：Native 后端工厂
- `computer-use-mcp.ts`：Zavora 后端工厂
- `computer-use-swift.ts`：Swift 加载器
- `computer-use-input.ts`：输入加载器
- `computer-use-sentinel-apps.ts`：敏感应用目录

#### 4.6.2 动态加载

Native 模块按需动态导入：
- 截图不加载输入模块
- 非 CU 回合不加载任何 CU 模块
- Swift 二进制首次使用时 spawn

#### 4.6.3 边界检查

- 所有工具输入 schema 禁用 `additionalProperties`
- 像素坐标验证范围
- 归一化坐标验证 [0,1]
- 目标应用精确匹配（非前缀）

## 5. 失败语义与工程取舍

### 5.1 回合结束清理

`cleanupComputerUseAfterTurn` 在三个位置调用：
1. 自然回合结束（`stopHooks.ts`）
2. 流式期间中止（`query.ts`）
3. 工具执行期间中止（`query.ts`）

清理步骤：
1. **Unhide**：恢复隐藏的应用，5s 超时
2. **Close Backend**：Zavora 后端关闭
3. **Unregister Hotkey**：取消注册 ESC 热键
4. **Release Lock**：释放文件锁

### 5.2 退出清理

`registerLockCleanup` 注册进程退出时的清理，确保锁被释放。

### 5.3 损坏恢复

- 锁文件解析失败视为过期
- PID 不存在（进程已死）视为过期
- 即使 unhide 失败也继续释放锁

### 5.4 失败传播与工程取舍

| 触发条件 | 语义与清理 | 调用方可见结果 |
|---|---|---|
| Accessibility 或 Screen Recording 缺失 | 在执行截图/输入前结束，不尝试绕过 TCC | 返回结构化 `tcc_denied` |
| 目标应用未授权或指针下应用未授权 | 精确 bundle ID 检查在 prepare/input 前拒绝 | 返回权限工具错误，不执行桌面动作 |
| Native Helper 请求超过 30s 或收到 abort | 请求取消并向上传播；Escape 用户事件中止当前控制器 | 结构化工具错误或保留 Abort 语义 |
| 输入序列中途失败 | executor 逆序释放已成功按下的键/修饰键，drag 释放鼠标按钮 | 原始错误向上传播，尽量避免卡键 |
| 锁文件损坏、PID 死亡或锁过期 | 视为可回收并删除重试；活锁持有者不被抢占 | 获取锁或返回持锁提示 |
| unhide、后端 close 或热键清理失败 | 各清理步骤相互隔离，仍继续释放文件锁 | 记录清理错误，回合不被清理异常二次阻断 |

工程取舍：文件锁带来过期判断和异常清理成本，但提供跨进程互斥；JSON Lines 牺牲二进制效率换取可调试协议；`drainRunLoop` 增加 30s 调用边界，却避免 CLI 中窗口事件堆积；严格 schema 与精确授权减少误操作面，也要求后端能力演进时同步更新类型和验证。

## 6. 现状验收标准

1. 分别选择 Native 和 Zavora 后端，工具枚举必须来自各自 catalog/schema；Native 路径不得隐式依赖 Zavora，结构化错误和 `isError` 必须在 wrapper 中保留。
2. 给定缺少任一 TCC 权限组合，Native 必须在截图或输入前返回 `tcc_denied`；未授权目标、大小写变体和指针下未授权应用均不得触发 prepare 或输入。
3. 给定多显示器截图，normalized 与 pixel 坐标转换必须保留显示原点，截图结果必须包含真实图片 block 并记录尺寸、缩放和显示元数据；`targetImageSize` 同时遵守宽高与总像素上限。
4. 给定 `holdKey`、带修饰键 click 或 drag 中途失败，必须只释放已成功按下的键并按逆序清理，鼠标按钮最终释放；错误不得被清理异常吞掉。
5. 给定用户 ESC 与模型合成 ESC，前者必须 abort，后者经 `notifyExpectedEscape` 豁免；热键注册失败和注销路径不得泄漏监听器。
6. 给定自然结束、流式中止和工具中止三种路径，必须依次尝试 unhide、后端关闭、热键注销和锁释放；即使 unhide 失败，锁仍须释放。
7. 给定损坏锁文件、死亡 PID 和活跃其他会话，前两者可按过期恢复，最后一种必须拒绝并发控制并报告持有者。

## 7. 代码与测试证据

| 设计陈述 | 代码证据 | 测试证据 |
|---|---|---|
| 双后端、坐标、授权、TCC、截图与结构化错误 | `src/utils/computerUse/hostAdapter.ts`、`mcpServer.ts`、`wrapper.tsx`、`executor.ts` | `tests/computerUseBackends.test.ts` 覆盖 Native/Zavora 工厂、显示原点、全部 TCC 组合、精确授权、独立剪贴板/组合键门控、截图元数据和 Abort 边界；`computerUseWrapper.test.ts` 覆盖结果转换。 |
| Native Helper JSON Lines 与输入/截图转发 | `nativeHelper.ts`、`swiftLoader.ts`、`inputLoader.ts`、`drainRunLoop.ts` | `tests/computerUseNativeHelper.test.ts` 覆盖平台检测、鼠标键盘 Unicode、Swift 方法转发、热键事件及响应/事件/abort/close 协议。 |
| 输入失败清理与有界 runloop drain | `executor.ts`、`drainRunLoop.ts` | `tests/computerUseExecutor.test.ts` 覆盖 holdKey 部分失败、逆序释放、drag 失败释放、click 修饰键清理及并发 capture。 |
| 锁、ESC 与回合清理 | `computerUseLock.ts`、`escHotkey.ts`、`cleanup.ts` | 相关单元和共享测试提供局部证据；真实多进程锁竞争、用户 ESC 与 macOS 桌面 unhide 仍需独立桌面环境验收。 |
| 原生构建与敏感应用边界 | `native/OpenComputerUseHelper.swift`、`native/build.sh`、`appNames.ts` | `computerUseBackends.test.ts` 验证 sentinel catalog 和严格 schema；Swift 二进制真实 TCC 行为不能由 mock 测试替代。 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/computer-use.yaml)

| 文件分组 | 主拥有职责 | 相关子系统与边界 |
|---|---|---|
| `src/utils/computerUse/executor.ts`、`hostAdapter.ts`、`mcpServer.ts` | 平台无关执行、宿主适配与 MCP 工具服务 | SessionContext 连接 AppState、权限对话框与会话锁 |
| `nativeHelper.ts`、`swiftLoader.ts`、`inputLoader.ts`、`drainRunLoop.ts` | Native 动态加载、JSON Lines、输入与 runloop | Swift/Rust 实现位于 native helper，不由 TypeScript 层复制 |
| `computerUseLock.ts`、`escHotkey.ts`、`cleanup.ts` | 互斥、用户中止和资源释放 | query/stopHooks 提供三个回合结束调用点 |
| `wrapper.tsx`、`toolRendering.tsx`、`gates.ts`、`common.ts`、`setup.ts` | 结果转换、渲染、门控、共享类型与设置 | 外部 `computer-use-*` stubs 定义可替换后端和类型边界 |
| `native/OpenComputerUseHelper.swift`、`native/build.sh` | macOS 原生截图、输入、权限与应用控制 | 需要 macOS/TCC 实机验证 |

测试文件由 `tests/computerUseBackends.test.ts`、`computerUseExecutor.test.ts`、`computerUseNativeHelper.test.ts` 和 `computerUseWrapper.test.ts` 覆盖。外部存根包括 `computer-use-types.ts`、`computer-use-native.ts`、`computer-use-mcp.ts`、`computer-use-swift.ts`、`computer-use-input.ts` 与 `computer-use-sentinel-apps.ts`。

## 9. 改进建议

1. **真实桌面验收分层**：将 mock 已覆盖的协议/权限不变量与 macOS TCC、窗口隐藏、ESC、剪贴板恢复和多显示器实机测试分开报告，避免以单元测试冒充桌面可用性。
2. **锁恢复可观测性**：记录锁过期、损坏解析和 PID 回收原因，并提供只读诊断命令，减少异常退出后的排查成本。
3. **清理结果聚合**：为 unhide、close、hotkey、lock 四步分别记录结果，在锁释放成功但应用恢复失败时给出明确警告。
4. **后端能力协商**：将 Native/Zavora 的 ESC、截图过滤、平台与输入能力显式暴露为 capability，而不是依赖调用方假设。
5. **取消与超时测试**：补充 30s helper 超时、runloop 取消、锁竞争和重复 cleanup 的故障注入，验证幂等和无资源泄漏。
