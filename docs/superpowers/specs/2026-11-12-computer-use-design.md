---
id: computer-use
batch: 6
title: Computer Use 浏览器与桌面自动化后端设计
date: 2026-11-12
status: draft
---

## 1. 概述

Computer Use 是 Claude Code 提供的桌面与浏览器自动化能力，支持两种后端实现：
- **Native Adapter**：基于 Swift + Rust 原生实现的 macOS 桌面控制
- **Zavora MCP**：基于 MCP 协议的第三方实现

本设计文档描述 Computer Use 的架构、后端抽象、安全机制与设计决策。

## 2. 后端抽象

### 2.1 后端接口

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

### 2.2 执行器抽象

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

### 2.3 Host Adapter 接口

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

### 2.4 Session Context 接口

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

## 3. 截图与输入

### 3.1 截图流程

1. **Prepare Capture**：`resolvePrepareCapture` 执行权限检查、显示解析、应用隐藏
2. **Screenshot Capture**：`screenshot` 调用 Swift 端的 `captureExcluding`
3. **Resize**：使用 `targetImageSize` 将物理像素缩放到 API 目标尺寸（max 1568x1568, 1.15M pixels）
4. **Metadata Recording**：`onScreenshotCaptured` 记录显示原点、尺寸、缩放因子

### 3.2 坐标系统

支持两种坐标模式：

- **Normalized**：`[0, 1]` 范围的归一化坐标，原点在左上角
- **Pixels**：物理像素坐标，带显示原点偏移

坐标转换公式（Native Adapter）：
```
logical_x = (pixel_x - origin_x) / width
logical_y = (pixel_y - origin_y) / height
```

### 3.3 输入执行

输入操作通过 `drainRunLoop` 包装，确保 CFRunLoop 正常运转：

- **Key Sequence**：`key` 方法支持 `ctrl+shift+a` 格式，8ms 间隔
- **Type via Clipboard**：保存剪贴板 → 写入文本 → 验证 → Cmd+V → 恢复
- **Mouse Move**：`moveAndSettle` 立即移动 + 50ms 等待
- **Mouse Drag**：`animatedMove` 使用 ease-out-cubic 缓动，60fps，最长 0.5s

### 3.4 Native Helper

Swift 二进制通过 JSON Lines 协议与 Node.js 通信：

```typescript
class NativeHelperClient {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(event: 'escape', listener: () => void): () => void;
  close(): Promise<void>;
}
```

每请求 30s 超时，支持 AbortSignal，事件驱动接收 Escape 按键。

## 4. 应用隐藏与显示

### 4.1 隐藏白名单

`prepareForAction` 接收 `allowlistBundleIds`，隐藏所有不在白名单的应用。终端作为 Surrogate Host 被豁免：

```typescript
const surrogateHost = terminalBundleId ?? CLI_HOST_BUNDLE_ID;
const withoutTerminal = (allowed: readonly string[]): string[] => 
  terminalBundleId === null ? [...allowed] : allowed.filter(id => id !== terminalBundleId);
```

### 4.2 Sentinel Apps

`SENTINEL_APPS` 定义了敏感应用，包括 Terminal、Finder、System Settings 等，用于权限对话框的特殊提示。

### 4.3 显示解析

`autoResolve` 模式：
1. 查找目标应用窗口所在的显示器
2. 如果找不到，使用主显示器
3. 记录 `displayResolvedForApps` 键

## 5. 锁与 ESC 中止

### 5.1 文件锁

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

### 5.2 Escape 热键

Native Adapter 注册 CGEventTap 监听 Escape 按键：

- 用户按下 Escape → 触发 `abortController.abort()`
- 模型合成的 Escape → 通过 `notifyExpectedEscape` 豁免

### 5.3 通知

- **Enter**："Claude is using your computer · press Esc to stop"
- **Exit**："Claude is done using your computer"

## 6. 权限与隐私

### 6.1 OS 权限检查

TCC 权限预检查：
- Accessibility（辅助功能）
- Screen Recording（屏幕录制）

失败返回 `tcc_denied` 结构化错误。

### 6.2 应用授权

`ComputerUseApproval` 对话框显示：
- 请求的应用列表
- 权限标志（剪贴板读写、系统组合键）
- TCC 状态
- 将被隐藏的应用预览

### 6.3 权限标志

```typescript
type CuGrantFlags = {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  systemKeyCombos: boolean;
};
```

### 6.4 子门控

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

## 7. Native 与 Stub 边界

### 7.1 外部存根

`src/external-stubs/computer-use-*.ts` 提供：
- `computer-use-types.ts`：类型定义
- `computer-use-native.ts`：Native 后端工厂
- `computer-use-mcp.ts`：Zavora 后端工厂
- `computer-use-swift.ts`：Swift 加载器
- `computer-use-input.ts`：输入加载器
- `computer-use-sentinel-apps.ts`：敏感应用目录

### 7.2 动态加载

Native 模块按需动态导入：
- 截图不加载输入模块
- 非 CU 回合不加载任何 CU 模块
- Swift 二进制首次使用时 spawn

### 7.3 边界检查

- 所有工具输入 schema 禁用 `additionalProperties`
- 像素坐标验证范围
- 归一化坐标验证 [0,1]
- 目标应用精确匹配（非前缀）

## 8. 失败清理

### 8.1 回合结束清理

`cleanupComputerUseAfterTurn` 在三个位置调用：
1. 自然回合结束（`stopHooks.ts`）
2. 流式期间中止（`query.ts`）
3. 工具执行期间中止（`query.ts`）

清理步骤：
1. **Unhide**：恢复隐藏的应用，5s 超时
2. **Close Backend**：Zavora 后端关闭
3. **Unregister Hotkey**：取消注册 ESC 热键
4. **Release Lock**：释放文件锁

### 8.2 退出清理

`registerLockCleanup` 注册进程退出时的清理，确保锁被释放。

### 8.3 损坏恢复

- 锁文件解析失败视为过期
- PID 不存在（进程已死）视为过期
- 即使 unhide 失败也继续释放锁

## 9. 设计决策

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

---

[Coverage](../../architecture/coverage/computer-use.yaml)
