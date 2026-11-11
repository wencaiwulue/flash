---
commit: 301a3e7fb8da14c45f1bac77ead288302b7f2466
title: "Implement monitoring and simple internal tools"
date: 2026-11-10T19:13:06+08:00
status: implemented
kind: component
---

# Implement monitoring and simple internal tools

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交中的 Monitor 输入只是宽松 record，工具固定禁用并在调用时抛出 unavailable，权限组件会自动拒绝；OverflowTest 也只有名称和禁用的占位对象，TerminalCapture 与 Sleep/CtxInspect 的实现文件尚不存在。terminalPanel 能交互式创建和附加 tmux panel，却没有只读 capture 入口，TerminalPanel 类与同步进程执行器也不便于独立测试。src/tools.ts 已预留五个工具的条件注册插槽，但外部构建只缺 MONITOR_TOOL、OVERFLOW_TEST_TOOL、TERMINAL_PANEL 三个开关，因此需要区分源码实现与编译后实际可见性。

本提交要把禁用的 Monitor 变成可执行的后台 shell 事件源，在任意 stdout chunk 边界下按完整行通知、保留早期输出并在结束时交付最后半行，同时沿用 Bash 权限、沙箱和本地任务协议。外围工具分别承担既有 tmux pane 的只读读取、确定性超大结果生成、可中止睡眠和上下文 JSON 报告；它们必须复用已有基础设施，不能把 OverflowTest 当作新截断器、把 CtxInspect 当作 context-collapse 实现，或把 mock tmux 测试写成真实终端验证。

## 目标与非目标

### 目标

- 以真实 exec onStdout 数据流实现 Monitor，跨 chunk 拼接完整行、处理 CRLF 和突发多行，并幂等 flush 最终 partial line。
- 把 Monitor 接入 spawnShellTask、早期行缓冲、XML 安全任务通知和完成状态，复用 Bash 权限检查与权限 UI。
- 提供只读取现有专用 tmux pane 的 TerminalCapture，不创建、附加或销毁 session，并允许注入同步 runner 做离线测试。
- 实现有界确定性 OverflowTest、设置约束及 abort 感知的 Sleep、基于 collectContextData 的 CtxInspect JSON 报告。
- 同步外部构建和测试 fixture 的三个特性开关，固定 30 个非空工具及三个新可见工具名称。
- 用单元与本地 shell 集成测试覆盖关键语义，并在 STATUS/RELEASE 中区分离线验证、特性门控和未运行边界。

### 非目标

- 不恢复或发明 MCP Monitor 协议、条件规则引擎，也不以 Monitor 替代一次性 Bash(run_in_background=true)。
- 不为 TerminalCapture 提供打开 panel、附加 tmux、无 session 的 shell fallback 或真实 tmux 端到端验证。
- 不在 OverflowTest 内实现新的输出截断、持久化或渲染机制，工具只产生既有管线的调试输入。
- 不实现 proactive 调度或 context-collapse 本体，Sleep 与 CtxInspect 的既有编译门控继续保留。
- 不把新增测试文件视为独立执行证据，不把 mock runner、构造 ContextData 或空 collapse 统计解释为在线结果。

## 方案架构与数据流

MonitorTool 采用严格 command/description/timeout/dangerouslyDisableSandbox 输入，输出启动消息和 task_id。checkPermissions 将输入展开为 run_in_background=true 的 BashToolInput 并调用 bashToolHasPermission，call 继续以 shouldUseSandbox 决定沙箱；MonitorPermissionRequest 仅渲染 BashPermissionRequest。工具标记非只读、非并发安全，权限责任与实际 shell 执行保持一致。

真实输出链由 exec(command, signal, bash, {onStdout}) 进入 pipe mode，子进程 stdout data 被转成字符串并交给 createMonitorOutputReporter。reporter 把 pending 与新 chunk 合并后按换行拆分，保留最后一段，依序发出此前所有完整行并去掉 CRLF 的尾部回车；finish 只在 pending 非空时补发最后半行，随后忽略迟到 push，重复 finish 不重复通知。shellCommand.result 完成后触发 finish。

task ID 在 exec 返回后才可取得，因此 reporter 的完整行先进入 earlyLines；获得 taskOutput.taskId 后按原顺序排空，再把后续行送入 notifyMonitorOutput。通知携带 task/tool-use/output_file/agent 信息，description 与输出行均 XML escape，并以 next 优先级进入既有队列。spawnShellTask 以 kind=monitor 注册 local_bash 任务，负责后台化、输出文件、完成/失败/停止状态和最终通知，Monitor.call 本身立即返回。

TerminalCaptureTool 只接受默认 200、范围 1 至 10000 的整数 lines，调用 getTerminalPanel().capture。TerminalPanel 先检查 tmux -V 与专用 socket 上既有 panel session，再执行 capture-pane -p -J -t panel -S -<lines>；缺失 panel 或非零退出直接抛错。类被导出且构造函数默认注入 spawnSync，使测试能检查参数而不启动 tmux，生产单例、socket 隔离和交互 toggle 逻辑不变。

OverflowTestTool 用固定 0123456789abcdef 周期生成并截取 1 至 2,000,000 字符，默认 100,000，maxResultSizeChars 仅略大于上限；它是只读且并发安全的确定性压力源。SleepTool 要求 duration 与 deprecated duration_ms 恰好一个，按设置先应用 minimum 再以 maximum 截断，负数 maximum 表示不限；abort 会结束等待并在 finally 复位 interruptible 状态，返回 requested/effective/elapsed/interrupted。

CtxInspectTool 复用 collectContextData 的 compact boundary、可选 projectView、microcompact 与 analyzeContextUsage 路径，formatContextInspection 输出模型、token 上限/比例、分类、messageBreakdown、apiUsage 和 contextCollapse getStats 的 JSON，不复制 /context 的 Markdown 表格或 grid。当前 context-collapse 服务仍禁用且统计为空，所以报告字段存在不等于 collapse 已执行。

注册层复用 src/tools.ts 既有条件插槽：Sleep 属 PROACTIVE/KAIROS，CtxInspect 属 CONTEXT_COLLAPSE；本提交只在正式 build 与独立画像 fixture 中加入 MONITOR_TOOL、OVERFLOW_TEST_TOOL、TERMINAL_PANEL。外部工具池由 27 变为 30，新增名称恰为 Monitor、OverflowTest、TerminalCapture，另两个源码工具仍不进入该外部画像。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/tools/MonitorTool/MonitorTool.ts`，符号 `createMonitorOutputReporter` | 实现严格工具契约、Bash 权限/沙箱复用、真实 stdout 分行、早期行、任务注册和 XML 安全通知。 |
| 变更 | `src/components/permissions/MonitorPermissionRequest/MonitorPermissionRequest.tsx`，符号 `BashPermissionRequest` | 移除自动拒绝 stub，将 Monitor 权限 UI 直接委托给既有 Bash 权限组件。 |
| 变更 | `src/tools/TerminalCaptureTool/TerminalCaptureTool.ts`，符号 `TerminalCaptureTool` | 提供 1 至 10000 行的只读、并发安全 pane 捕获工具和空 panel 结果提示。 |
| 变更 | `src/utils/terminalPanel.ts`，符号 `export class TerminalPanel` | 导出可注入 runner 的 TerminalPanel，并实现专用 socket 上 capture-pane 的只读路径。 |
| 变更 | `src/tools/OverflowTestTool/OverflowTestTool.ts`，符号 `makeOverflowOutput` | 把禁用占位对象替换为有界、确定性的完整大结果生成工具。 |
| 变更 | `src/tools/SleepTool/SleepTool.ts`，符号 `resolveSleepDuration` | 实现 duration 别名互斥、设置上下限、abort 响应及 interruptible 状态清理；注册仍受既有门控。 |
| 变更 | `src/tools/CtxInspectTool/CtxInspectTool.ts`，符号 `formatContextInspection` | 复用 collectContextData 生成包含 token、usage 和 collapse 统计的 JSON 报告，不包含可视化 grid。 |
| 变更 | `scripts/build.ts`，符号 `MONITOR_TOOL` | 为外部 CLI/SDK 构建启用 Monitor、OverflowTest 和 terminal panel 三项特性。 |
| 变更 | `tests/internalTools.test.ts`，符号 `does not drop bursts or carriage-return line endings` | 新增八项单元测试，覆盖 reporter、Sleep、Overflow、CtxInspect 格式和 mock TerminalPanel。 |
| 变更 | `tests/monitorToolIntegration.test.ts`，符号 `Monitor streams real shell output and completion notifications` | 新增真实本地 printf shell、任务状态及输出/完成通知集成测试。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `toolCount` | 把外部画像固定为 30 个非空工具，并加入三个新工具名称。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `TERMINAL_PANEL` | 让独立特性构建夹具与正式构建同步启用三个新特性。 |
| 变更 | `docs/STATUS.md`，符号 `Monitor streaming` | 记录 73/288、30 工具、本地 shell Monitor 验证和 Sleep/CtxInspect feature-gated 边界。 |
| 变更 | `docs/RELEASE.md`，符号 `## Monitor, terminal capture, and simple tool implementations` | 记录五个工具的发布范围及 73/288、类型检查、构建和 CLI smoke 验证。 |
| 复用 | `src/utils/Shell.ts`，符号 `onStdout` | 复用 pipe mode、stdout data 转换、TaskOutput 与 ShellCommand，不伪造 chunk。 |
| 复用 | `src/tasks/LocalShellTask/LocalShellTask.tsx`，符号 `spawnShellTask` | 复用 local_bash 注册、后台化、输出文件、monitor 完成摘要和最终通知。 |
| 复用 | `src/tools.ts`，符号 `feature('MONITOR_TOOL')` | 复用五个工具既有条件导入与注册插槽，本提交无需修改工具注册表。 |
| 复用 | `src/commands/context/context-noninteractive.ts`，符号 `collectContextData` | 复用 /context 与 SDK usage 的数据收集和 token 分析口径。 |
| 复用 | `src/services/contextCollapse/index.ts`，符号 `getStats` | 复用现有统计接口；该 revision 仍是禁用 stub，提供空统计而非真实 collapse。 |
| 复用 | `src/tools/SleepTool/prompt.ts`，符号 `SLEEP_TOOL_NAME` | 复用既有工具名称、说明和提示，不另建 Sleep 外部契约。 |
| 复用 | `src/tools/TerminalCaptureTool/prompt.ts`，符号 `TERMINAL_CAPTURE_TOOL_NAME` | 复用 TerminalCapture 既有名称和提示，新增实现文件与之对应。 |
| 复用 | `src/utils/permissions/classifierDecision.ts`，符号 `TerminalCapture` | 复用既有 auto-mode 安全 allowlist 中只读工具及 Sleep 的分类规则。 |

## 关键决策与工程取舍

- 把 chunk 重组封装为独立 reporter，而不是在每个 stdout data 回调中直接通知；这样换行边界、CRLF、burst 和最终半行有单一确定性算法，也能用无进程单元测试覆盖。
- 早期行按顺序暂存而非丢弃或伪造 task ID，保持通知协议需要真实任务身份的约束；代价是必须仔细在注册后及时排空缓冲。
- Monitor 复用 Bash 权限与沙箱而不是新增一套监控授权，权限 UI 也只做代理；这避免相同 shell 命令因工具名称不同获得不同授权语义。
- TerminalCapture 在 panel 不存在时明确失败，不为满足工具调用而隐式创建用户终端；runner 注入只改变可测试性，默认生产执行器仍为 spawnSync。
- Sleep 保留 duration_ms 兼容别名但禁止双参数歧义，设置约束在真正等待前解析；CtxInspect 则复用 /context 数据收集，避免两份 token 统计口径漂移。
- 只启用三个已具备完整外部能力的 feature，Sleep/CtxInspect 保持门控；源码 isEnabled=true 不被误当作外部 bundle 已注册。

### 备选方案与回溯分析

- 回溯性比较：可以按 stdout chunk 原样发送通知，实现更简单但会把一行拆成多条或把多行合并，且无法保证最终 partial-line 语义；实际引入 pending 缓冲和幂等 finish。
- 回溯性比较：可以为 Monitor 另写后台任务与授权协议，但会重复 ShellCommand、输出文件和完成通知；实际复用 exec/spawnShellTask/Bash 权限，仅添加 monitor 类型及逐行事件。
- 回溯性比较：可以在 TerminalCapture 缺 session 时自动打开 panel，操作更方便却产生用户可见副作用并违背只读属性；实际要求用户先用既有 Meta+J 打开 panel。
- 回溯性比较：可以为 CtxInspect 独立遍历消息并计算 token，但会与 /context 的 compact 和 usage 规则分叉；实际复用 collectContextData，仅更换 JSON 展示层。
- 回溯性比较：可以同时打开 PROACTIVE 与 CONTEXT_COLLAPSE 以暴露所有新工具，但那会扩大到未完成的调度与 collapse 服务；实际只注册三个可独立交付的外部工具。

## 安全与协议边界

- Monitor 能执行任意 shell，故保留非只读/非并发安全标记，并复用 bashToolHasPermission、shouldUseSandbox 与既有 dangerouslyDisableSandbox policy。
- 逐行通知的 summary 和 shell 输出均 escapeXml，避免输出内容破坏 task_notification 标签；agentId 与 toolUseId 继续用于原有路由。
- TerminalCapture 只读取每 session 专用 socket 上的既有 pane，不发送按键或创建 session；scrollback 本身可能含敏感信息，调用仍应受工具权限约束。
- OverflowTest 的 size 有硬上限，Sleep 的时长受设置约束且可中止，避免无界内存分配或不可中断等待。
- 测试集成命令使用本地 printf；新增权限 UI 与 checkPermissions 源码接线并未由该集成测试单独执行，不能据此宣称所有授权交互已现场验证。

## 验收标准

- Monitor 在任意 chunk 分割下按顺序交付每条完整行，CRLF 不残留回车，burst 不丢行，结束仅补发一次非空最终半行。
- task ID 尚未取得时的输出不会丢失；启动结果返回真实 task_id，输出文件与最终任务通知继续由 LocalShellTask 管理。
- Monitor 权限检查和 React 权限请求都进入 Bash 对应实现，沙箱选择与 Bash 输入语义一致。
- TerminalCapture 只对现有 panel 执行 capture-pane -p -J 和请求行数，不调用 new-session/attach-session，缺失 panel 时抛出明确错误。
- OverflowTest 输出精确长度和固定 pattern；Sleep 校验别名、应用 min/max 并响应 abort；CtxInspect 输出无 visualization grid 的 JSON。
- 外部画像加载 30 个非空工具并包含 Monitor、OverflowTest、TerminalCapture，Sleep/CtxInspect 仍保持各自 feature gate。
- 执行通过结论只引用 at-commit STATUS/RELEASE；新增测试存在本身不单独作为通过证据。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | createMonitorOutputReporter 以 pending 合并 chunk、逐行拆分、清理 CR，并由幂等 finish 补发最后半行；call 将真实 exec onStdout 接入该 reporter。 | `src/tools/MonitorTool/MonitorTool.ts`，符号 `createMonitorOutputReporter`，revision `commit` |
| diff-observed | TerminalPanel.capture 只经过 tmux 检查、既有 session 检查和 capture-pane，不包含 new-session 或 attach-session；构造器可注入 runner。 | `src/utils/terminalPanel.ts`，符号 `capture(lines: number)`，revision `commit` |
| test-added | 新增 internalTools 测试覆盖 Sleep 设置/中止、Overflow 精确输出、Monitor 跨 chunk/CRLF/burst/final flush、CtxInspect JSON 和 mock tmux 捕获；此项只声明测试被加入。 | `tests/internalTools.test.ts`，符号 `joins chunks into complete lines and flushes the final partial line`，revision `commit` |
| test-added | 新增 Monitor 本地 shell 集成测试以 printf 产生 first/second，观察任务 completed 及输出/完成通知；它不覆盖权限 UI、stderr、timeout、kill 或真实 tmux。 | `tests/monitorToolIntegration.test.ts`，符号 `Monitor streams real shell output and completion notifications`，revision `commit` |
| test-added | 特性画像回归把外部工具总数更新为 30，新增 Monitor、OverflowTest、TerminalCapture 名称断言，并在 fixture 同步三个 feature。 | `tests/enabledFeatures.test.ts`，符号 `TerminalCapture`，revision `commit` |
| recorded-command-pass | 提交内 STATUS 的 Verified evidence 记录 bun test 已通过 73 tests、288 assertions；该数字是 at-commit 历史记录，不是本次文档校验重新运行所得。 | `docs/STATUS.md`，符号 ``bun test``，revision `commit` |
| recorded-command-pass | 提交内 STATUS 记录 bun run typecheck 零 TypeScript 错误、bun run build 完成 CLI/SDK/declarations；RELEASE 另记录 CLI startup smoke checks 通过。 | `docs/STATUS.md`，符号 ``bun run typecheck``，revision `commit` |
| recorded-command-pass | RELEASE 的 Monitor, terminal capture, and simple tool implementations 段记录 73/288、typecheck、build、declarations 与 CLI startup smoke 通过。 | `docs/RELEASE.md`，符号 `## Monitor, terminal capture, and simple tool implementations`，revision `commit` |
| not-recorded | 没有真实 tmux pane 捕获、Monitor 权限交互/timeout 极端事件、Sleep 正常长等待或 context-collapse 实际运行证据；STATUS 将后两者所在功能组保留为后续工作。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- TerminalCapture 的测试使用 mock runner，真实 tmux 安装、scrollback 内容和跨平台终端行为仍需现场验证。
- Monitor timeout 传给 exec，但既有 background 会清 foreground timeout；没有新增后台 runtime timer，也没有相关超时测试。
- 最终 finish 挂在进程 result 而非显式 stdout close 上，finish 后迟到 chunk 会被忽略；exit/close 极端顺序未被新增测试模拟。
- Sleep 与 CtxInspect 未进入当前外部画像，CtxInspect 的 collapse 统计仍来自禁用服务；相应功能组需另行完成和激活。
- Monitor 权限决策与 BashPermissionRequest 的真实交互、stderr 分行、失败/杀死及长时间流式行为未由新增集成测试覆盖。
