# Computer Use Backends 契约

日期：2026-11-11。状态：目标设计，尚未实现；Zavora 结果不等于私有 Swift/Enigo 兼容证据。

## 1. 现状与入口

- `/Users/fengcaiwen/GolandProjects/claude-code/src/external-stubs/computer-use-mcp.ts` 使用真实 `@zavora-ai/computer-use-mcp` 创建 desktop server 和 in-memory MCP client；`listOpenComputerUseTools()` 与 `bindSessionContext()` 确实可枚举/调用 Zavora。
- 同一文件也把 `_adapter`、`_coordinateMode` 全部忽略：`createComputerUseMcpServer()` 无论传入什么都返回 Zavora，`bindSessionContext()` 无论 adapter 是什么都调用 Zavora。这把原生 adapter 与开放后端错误合并。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/external-stubs/computer-use-types.ts` 定义了原生 `ComputerExecutor`、app grants、TCC flags、display/screenshot dims 和 `ComputerUseSessionContext`，是原生路径的接口，不是 Zavora 的接口。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/external-stubs/computer-use-input.ts` 固定 `isSupported=false`，`computer-use-swift.ts` 固定 unavailable；external 没有私有原生模块，不能伪造其能力。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/computerUse/hostAdapter.ts`、`executor.ts` 是真实 CLI 原生适配层：Swift 负责 ScreenCaptureKit/apps/TCC/hotkey，input 负责鼠标键盘，macOS run loop、clipboard、resize、modifier release 等已有实现可复用。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/computerUse/wrapper.tsx` 持有 AppState、权限对话框、锁、Escape 注册与 tool result 转换；`mcpServer.ts` 负责 ListTools；`cleanup.ts` 负责 unhide、hotkey unregister 和锁释放。
- 当前 `bindSessionContext()` 只按 `MUTATING_TOOLS` 和少量 flags 做粗粒度授权，没有使用 adapter，也丢弃 `structuredContent`；`wrapper.tsx` 也没有把后端 `isError` 明确传播给工具结果。
- 已安装 Zavora 7.8 的真实 API 提供 `createComputerUseServer({profile:'desktop', authorizeToolCall, elicitApproval, …})`、`Session.dispatch(tool,args,signal)`、`callMutates()`、结构化错误与 desktop status card/stop 控制。这些是 Zavora 自己的契约，不能用 `CoordinateMode/ComputerExecutor` 强行模拟。

## 2. 目标与非目标

### 目标

1. 建立显式 `zavora` 与 `native-adapter` 两条后端；factory、tool listing、dispatch、权限、坐标和生命周期按后端选择，禁止参数被忽略或互相冒充。
2. external 默认开放实现使用 Zavora desktop profile；同时提供基于公开桌面能力的 `open-native` host adapter，替换固定 `isSupported=false` 和 Swift unavailable 占位。请求私有 ABI 时不伪造兼容，请求开放原生路径时必须执行真实 display/apps/input/TCC/hotkey 操作。
3. 明确定义物理/逻辑/归一化坐标、截图元数据、应用授权、clipboard/system keys、Abort/Escape 和错误传播。
4. 保留 wrapper 的会话权限、锁与 UI；复用 Zavora 自带 OS 权限检查、结构化结果和 operator control，不重复伪造。
5. 任一后端不可用都明确失败，不能回退另一后端后宣称请求的后端成功。

### 非目标

- 不实现私有 `@ant/computer-use-swift` 或 `@ant/computer-use-input` 的 ABI，也不声称 Zavora 与其 wire/native-module 兼容。
- 不把 Zavora 的平台相关坐标单位自动套进原生 `pixels/normalized`，也不伪造缺失的 `ScreenshotDims`。
- 不在默认 desktop profile 开启 `run_script`、任意 filesystem、process/admin/full 高权限工具。
- 不把 MCP annotation 当授权，不在权限失败时继续执行动作。
- 不让全局 Escape 同时被两套 hotkey/operator-control 状态机消费。

## 3. 后端选择与公开 API

### 3.1 显式后端接口

```ts
type ComputerUseBackendKind = 'zavora' | 'native-adapter'

type ComputerUseBackend = {
  kind: ComputerUseBackendKind
  listTools(): Promise<ComputerUseTool[]>
  dispatch(
    name: string,
    args: unknown,
    context: ComputerUseSessionContext,
    signal: AbortSignal,
  ): Promise<CuCallToolResult>
  close(): Promise<void>
}

function createZavoraComputerUseBackend(options?: {
  serverOptions?: ZavoraServerOptions  // profile 固定 desktop
}): ComputerUseBackend

function createNativeComputerUseBackend(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
): ComputerUseBackend
```

- `createComputerUseMcpServer(adapter, coordinateMode)` 若保留兼容签名，只能构造 native-adapter server，不能返回 Zavora cast。`listOpenComputerUseTools/getOpenComputerUseClient` 只属于 Zavora，并改名或增加明确 aliases。
- `bindSessionContext(adapter, coordinateMode, context)` 属于 native；Zavora 使用独立 `bindZavoraSessionContext(context)`。上层 `wrapper.tsx` 根据已配置 backend 绑定一次，不通过空 adapter 猜测。
- `createComputerUseMcpServerForCli()` 根据后端 factory 建 server 和 ListTools；`adapter.isDisabled()` 只用于 native，Zavora 有独立 enabled/health 检查。
- `CuCallToolResult` 增加可选 `structuredContent`，保留 `content/isError/telemetry`。MCP text/image/resource_link 均按真实结果转换，不把 resource 静默变成空文本。

### 3.2 Zavora 路径

- `createComputerUseServer({profile:'desktop'})` 是开放默认；工具 schema/description 来自它自己的 `listTools()`，删除 `buildComputerUseTools()` 返回宽松 `additionalProperties:true` 假 schema 的成功路径。
- 使用 `ServerOptions.authorizeToolCall` 在每次 handler 前执行宿主授权；结合 `callMutates(name,args)` 识别 read-only mode，而不是仅按名称判断。
- 需要宿主批准时通过 Zavora `elicitApproval`/MCP elicitation 映射到现有 `ComputerUseApproval`，批准范围绑定 tool、args、target app 和单次调用。Zavora approval token 不得出现在模型 schema、日志或 AppState。
- `Session.dispatch` 或 client call 的 AbortSignal 必须来自当前 `ToolUseContext.abortController`；Zavora 自己负责 native focus、PID delivery、operator pause/stop、截图临时文件和 structured errors。
- 保持 desktop profile 的 OS allow/block app 配置。现有 `AppGrant/flags` 是宿主额外边界，与 Zavora 配置取交集，不得一方授权后绕过另一方。

### 3.3 原生 adapter 路径

- factory 必须真实使用 `adapter.executor`、`adapter.ensureOsPermissions()`、`getSubGates()`、`isDisabled()` 与 coordinateMode。external 注入的开放 adapter 必须通过公开桌面/NAPI 能力实现 display、apps、input、TCC 和 hotkey；`computer-use-input.ts` 与 `computer-use-swift.ts` 的固定占位不再进入运行时。
- 复用 `createCliExecutor()` 的 display/app/keyboard/mouse 编排，将其底层私有调用替换为开放 adapter 方法；不重新宣称私有 Swift/Enigo ABI。平台或 OS 权限不足是明确的运行时健康检查结果，不是编译期固定 `false`。
- native tool catalog 可按现有工具名包装 executor，但 input schema 必须严格，不能用全宽松 object 代替；每个 action 映射到一个真实 executor 方法，健康检查与动作测试必须证明对应 OS 调用发生。
- `cropRawPatch()=>null` 只表示 pixel validation skipped，不能写成 pixel validation passed；prepareForAction 失败只允许按现有注释降级，frontmost/target 校验失败仍必须中止输入。

## 4. 坐标、截图与输入契约

### 4.1 坐标

| 后端/模式 | 输入 x/y | display origin 与缩放 | 禁止行为 |
|---|---|---|---|
| Zavora | 严格遵循其工具 schema 和截图返回的 `screen_x/screen_y` 映射；macOS/Linux 使用逻辑屏幕坐标，Windows 默认 per-monitor DPI aware 时使用全局**物理像素**，窗口/pid 坐标按该工具声明解释 | 多显示器与缩放由 Zavora 处理；Windows 仅在显式 `COMPUTER_USE_WINDOWS_DPI_AWARENESS=unaware` 时采用其 96-DPI 虚拟坐标；宿主不再次乘 scaleFactor | 不跨平台假定统一单位，不套 native normalized 或另行猜测图片缩放公式 |
| native `pixels` | macOS 全局逻辑点；x/y 包含所选 display 的 `originX/originY` | `DisplayGeometry.width/height` 是逻辑尺寸，`scaleFactor` 仅用于截图像素目标尺寸 | 不把传输图片像素直接当输入逻辑点 |
| native `normalized` | 有限数 `[0,1]`，相对当前解析 display 的逻辑矩形 | `x=originX+nx*displayWidth`，`y=originY+ny*displayHeight`，校验边界后再调用 executor | 不接受 NaN/Infinity、越界或跨屏隐式猜测 |

`coordinateMode` 进程启动时冻结（现有 `getChicagoCoordinateMode()` 已实现），工具描述与转换使用同一值。目标 display 未解析、pin 失效或截图/display 不匹配时先重新截图/解析，不能沿用旧坐标点击。

### 4.2 截图

- native 复用 `API_RESIZE_PARAMS` 和 `targetImageSize()`：先 `logical * scaleFactor` 得物理尺寸，再限制 maxWidth/maxHeight/maxPixels。`ScreenshotResult.width/height` 是实际返回图片像素，`displayWidth/displayHeight/displayId/originX/originY` 是捕获时 display 元数据；每次成功截图调用 `onScreenshotCaptured(dims)`。
- 模型坐标映射必须基于**最近一次截图的 dims**，不是当前另一个 display 的尺寸。zoom region 使用同一 display/逻辑坐标，JPEG MIME 与 base64 必须真实。
- native 截图只捕获授权 app allowlist 和选中 display，host/terminal 按 `createCliExecutor()` 规则排除；TCC screenRecording 缺失时失败，不返回黑图当成功。
- Zavora 截图保留其 content blocks、`computer://screenshot/latest` cache 语义和 structuredContent；宿主仅在元数据真实存在时更新 `lastScreenshotDims`，不得根据 base64 猜测 display origin。Zavora 的截图/OS 权限错误原样传播。

### 4.3 输入、权限与清理

- 所有 click/drag/scroll/type/key/hold_key 先验证 schema、坐标、target app grant、frontmost/focus（若后端要求）和锁，再发送输入。
- `clipboardRead` 控制 read_clipboard，`clipboardWrite` 控制 write_clipboard/经 clipboard type，`systemKeyCombos` 控制 key/hold_key 中系统组合键；flags 只能增授不能借一次响应意外撤销已有授权，撤销由显式用户操作完成。
- app grant 必须匹配本次 `target_app`/解析后的 target，而不是 `allowedApps.length > 0` 就允许任意应用。截图和 clipboard 等观察操作也需要相应授权，不能因不在 `MUTATING_TOOLS` 就无限制读取。
- native 在 finally 释放鼠标/ modifiers，turn 结束 unhide `hiddenDuringTurn`、注销 hotkey、释放锁；Zavora 依赖其 session close/operator control，并仍执行宿主锁与 AppState 清理。
- 用户物理输入导致 Zavora pause 时返回其后端状态，不能 busy-loop 自动继续；native frontmost 改变时按现有 gate 中止。

## 5. 安全、Escape、Abort 与错误传播

### 5.1 Escape 与取消

**native**：

1. fresh lock acquire 注册全局裸 Escape；用户 Escape 被消费并调用当前 turn 的 `abortController.abort()`，防止 prompt injection 用 Escape 关闭权限对话框。
2. 模型合成的裸 `escape/esc` 在 executor 发键前调用 `notifyExpectedEscape()`，使用短时 hole-punch；组合键不触发 abort。
3. hotkey 注册失败时工具可继续但必须通知“Ctrl+C 停止”；cleanup 注销并释放 run-loop pump。Abort 不吞成普通成功。

**Zavora**：

1. 使用其 status card 的 Pause/Stop、`ctrl+alt+escape` 和用户活动 guard；不要注册 native 裸 Escape tap。
2. 当前 CLI abort signal 接入每次 dispatch，取消后不再发后续输入，并关闭/释放本 call 的资源。
3. 若 status card 不可用，至少保留 MCP cancellation 和 CLI Ctrl+C；不能声称裸 Escape 在 Zavora 路径有效。

### 5.2 错误模型

- 后端返回 `{isError:true}` 时 wrapper 必须保留工具错误，并保留 `structuredContent` 中的 `error/remediation/focus_failed` 等字段；不得只取 text 后当正常结果。
- adapter/native throw、MCP transport throw 和非法参数转为带稳定 `error_kind` 的工具错误；AbortError 按取消传播，不改成 permission denied。
- 权限拒绝、TCC 缺失、锁被占、display 失效、focus 失败、截图失败、输入失败和后端断开是不同错误类别，日志记录类别，不记录 clipboard、文本、截图 base64 或 token。
- 清理错误单独记录，不能覆盖原始 action 错误；release 失败需要用户可见诊断。任何异常都不能返回“动作已完成”。

## 6. 状态机

```text
disabled/unconfigured
  → select explicit backend
  → load backend + enumerate real tools
  → OS/backend permission preflight
       ├─ unavailable/denied → failed（不切换后端）
       └─ ready → acquire/check lock → resolve target/display
            → permission request（每次按 scope）
                 ├─ denied/aborted → cleanup → ready/failed
                 └─ granted → screenshot/action dispatch
                      ├─ success + metadata → ready
                      ├─ structured error → cleanup → ready with error
                      └─ user Escape/abort → cancel → cleanup → ready
turn end → unhide native apps / close Zavora session resources
         → unregister native hotkey / stop backend controls → release lock
```

App grant、display pin、last screenshot 和 hidden apps 存在于当前进程会话；后端 reconnect 不得把旧截图当作新 display 的证明。工具调用串行化，避免共享 cursor/focus/clipboard 竞争。

## 7. 关键文件与复用点

- 拆分 `/Users/fengcaiwen/GolandProjects/claude-code/src/external-stubs/computer-use-mcp.ts`：Zavora factory/client 与 native factory/binder 不再互调；保留纯 `targetImageSize()` helper并补边界测试。
- 继续使用 `/Users/fengcaiwen/GolandProjects/claude-code/src/external-stubs/computer-use-types.ts` 作为 native/session 公共类型，扩展 result 的 `structuredContent`，不要冒充 Zavora 官方类型。
- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/computerUse/mcpServer.ts` 和 `wrapper.tsx`：显式 backend 选择、权限交集、AbortSignal、完整错误/内容传播。
- 原生复用 `hostAdapter.ts`、`executor.ts`、`escHotkey.ts`、`cleanup.ts`、`drainRunLoop.ts`，并新增公开桌面能力 adapter 取代 `computer-use-input.ts`/`computer-use-swift.ts` 的固定实现；adapter 只承诺本文语义，不伪装私有模块 ABI。
- Zavora 复用包内 `createComputerUseServer`、`callMutates`、`authorizeToolCall`、`elicitApproval` 和 `Session.dispatch`，只写 host integration，不复制桌面驱动。
- `/Users/fengcaiwen/GolandProjects/claude-code/tests/openBackends.test.ts` 增加两个 factory 的 spy，断言传入 native adapter 时绝不调用 Zavora，反之亦然。
- `/Users/fengcaiwen/GolandProjects/claude-code/scripts/live-desktop-validation.ts` 增加显式 backend 参数、截图/输入/取消和结果校验，不再只以 screenshot 非 error 代表全部能力。

## 8. 测试矩阵

| 层 | 用例 | 必须断言 |
|---|---|---|
| factory | native factory + spy adapter；Zavora factory | 各自由对应实现消费参数；绝不跨后端调用或回退 |
| schema | desktop listTools、原生各 action | schema 来自真实后端且严格；full/scripting/admin 不暴露 |
| 坐标 | pixels 多屏 origin、normalized 0/1/边界、NaN/Infinity/越界、scaleFactor、旧截图 | 转换精确；非法输入在 OS 调用前拒绝；不错误二次缩放 |
| resize | 非有限/零/负尺寸、宽图、长图、maxPixels、rounding | 保留现有 helper 语义，输出不超过三项上限 |
| 截图 | allowed apps、TCC deny、dims 回写、Zavora structuredContent/cache | 内容/MIME/dims 真实；无伪造元数据；截图错误可观察 |
| 权限 | 不同 target app、clipboard flags、system key、只读 action、deny/abort | 精确 scope；deny 后零 OS 调用；授权不越权/不串 app |
| 输入 | click/type/key/modifiers/drag 中途 throw | finally 释放按键/按钮；frontmost/focus 失败不继续 |
| Escape | native 用户 Esc、模型 Esc、组合键、注册失败；Zavora stop/pause | 两后端机制不混用；abort 传播；无假 hotkey 成功 |
| 锁与清理 | 锁竞争、turn end、abort、unhide/unregister/release throw | 不泄漏锁；清理不覆盖原错误；Zavora 不调用 Swift cleanup |
| 错误 | isError、structured focus error、transport throw、AbortError | 全部保留类别和 structuredContent；不变成成功或空文本 |
| Web/CLI 集成 | MCP ListTools→wrapper.call→结果转换 | 后端选择与 AppState、当前 ToolUseContext、signal 一致 |

## 9. dist 与 live 验收

1. 完成双 factory 单元/集成测试后，执行 `bun run typecheck`、`bun run build` 和 `bun dist/main.js --help`。dist 检查必须证明开放 native adapter 不会在 Zavora 路径被加载，native 请求也不会由 Zavora 静默代答。
2. 用打包后的 CLI 显式选择 Zavora，在授权交互桌面执行 `doctor/list displays/screenshot`；断言图像非空、MIME/尺寸有效、structuredContent 未丢失。随后在一个专用测试应用完成 click、type、key、scroll，并从截图/readback 验证效果，不能只看工具返回成功。
3. 在测试应用验证授权交集：未授权 target、clipboard read/write、system combo 均在 OS 动作前拒绝；另一 app 的 grant 不能复用。桌面必须是非生产测试会话，避免真实用户输入干扰。
4. 分别验证 Zavora `ctrl+alt+escape`/status card stop 与 CLI AbortSignal：长动作取消后无后续输入，锁/session 清理完成。Zavora 路径不要求私有裸 Escape。
5. 对开放 native adapter 单独执行 live：验证 TCC deny/allow、多屏坐标、截图 dims、鼠标键盘、用户 Esc、模型 Esc 和 unhide，证明这些动作来自公开 adapter 而不是 Zavora 或私有包。若另有私有模块兼容构建，其 ABI 验证是独立证据，不能替代开放 adapter 验收。
6. 记录实际 backend、OS、显示器 scale、权限状态和动作证据。Zavora 与开放 native adapter 分别标记验证状态；没有执行对应路径或没有交互桌面时，该路径 live 必须标 skipped，不能用另一后端结果补齐。
