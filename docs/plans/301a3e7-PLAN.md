---
commit: 301a3e7fb8da14c45f1bac77ead288302b7f2466
title: "Implement monitoring and simple internal tools"
date: 2026-11-10T19:13:06+08:00
status: implemented
kind: component
---

# 实施计划：Implement monitoring and simple internal tools

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本提交要把禁用的 Monitor 变成可执行的后台 shell 事件源，在任意 stdout chunk 边界下按完整行通知、保留早期输出并在结束时交付最后半行，同时沿用 Bash 权限、沙箱和本地任务协议。外围工具分别承担既有 tmux pane 的只读读取、确定性超大结果生成、可中止睡眠和上下文 JSON 报告；它们必须复用已有基础设施，不能把 OverflowTest 当作新截断器、把 CtxInspect 当作 context-collapse 实现，或把 mock tmux 测试写成真实终端验证。

- 确认父提交 Monitor/OverflowTest 为禁用 stub，Sleep、CtxInspect、TerminalCapture 实现文件缺失而条件注册插槽已存在。
- 确认 exec 支持真实 onStdout、spawnShellTask 接受 monitor kind、Bash 权限函数可复用相同 ToolUseContext。
- 确认 terminal panel 使用每 session 专用 tmux socket，capture 可以只读复用现有 panel 而不触发 toggle。
- 确认 Sleep settings/abort helper 与 /context collectContextData 可直接复用，context-collapse 和 proactive 仍是独立功能组。

## 复用与兼容处理

### 复用现有实现

- 复用 Shell.ts 的 exec、pipe、TaskOutput 和 abort，LocalShellTask 的任务状态、输出文件及通知。
- 复用 bashToolHasPermission、shouldUseSandbox、getMaxTimeoutMs 和 BashPermissionRequest 保持 shell 授权一致。
- 复用 getTerminalPanel、getTerminalPanelSocket、hasSession 与 checkTmux，生产 runner 默认为 spawnSync。
- 复用 Sleep prompt/settings/sleep helper、CtxInspect 的 collectContextData/getStats 及 src/tools.ts 条件插槽。
- 复用独立 feature-profile fixture 和 STATUS/RELEASE 的历史验证格式，区分测试新增与命令通过。

### 兼容、迁移与生命周期

- Monitor 原路径从未可用，因此严格 schema 替换宽松 record 不破坏已有可执行调用；任务与通知继续使用 local_bash 协议。
- duration_ms 保留为 deprecated alias，但双参数会明确拒绝；Sleep 的 settings 和 abort 行为沿用现有契约。
- TerminalPanel 默认 runner 与单例不变，交互 toggle 继续负责创建/附加，capture 只是新增只读方法。
- 工具名称和既有条件插槽不变，仅外部 feature 集增加三项，未启用构建仍可排除相应实现。
- CtxInspect 复用 /context 数据口径，输出选择 JSON 而非改变现有 Markdown 命令。

## 文件级实施步骤

### 1. 实现 Monitor 分行 reporter 与真实 shell 任务

先以 pending/finished 编写 createMonitorOutputReporter，处理跨 chunk、多行、CRLF、最终半行和幂等 finish。再用严格 schema 替换 Monitor stub，把 exec onStdout 接入 reporter，result 后 flush；以 earlyLines 暂存 task ID 前的完整行，取得 ID 后依序通知，最后交给 spawnShellTask(kind=monitor) 管理后台生命周期。

涉及位置：`src/tools/MonitorTool/MonitorTool.ts`、`src/utils/Shell.ts`、`src/tasks/LocalShellTask/LocalShellTask.tsx`

### 2. 接通 Bash 权限与沙箱边界

在 checkPermissions 中将 Monitor 输入转为 run_in_background=true 的 Bash 输入并调用既有权限函数，在执行前复用 shouldUseSandbox。权限 React 组件只代理 BashPermissionRequest，使自动拒绝 stub 消失且不产生第二套授权界面。

涉及位置：`src/tools/MonitorTool/MonitorTool.ts`、`src/components/permissions/MonitorPermissionRequest/MonitorPermissionRequest.tsx`

### 3. 加入只读 TerminalCapture 路径

导出 TerminalPanel 并注入默认 spawnSync，将既有同步调用改为该 runner；新增 capture(lines)，依次检查 tmux 和既有 session，再以 capture-pane -p -J -S 读取专用 panel。TerminalCaptureTool 只负责严格行数输入、调用 capture 和空结果展示，不在缺失 panel 时创建或附加 session。

涉及位置：`src/tools/TerminalCaptureTool/TerminalCaptureTool.ts`、`src/utils/terminalPanel.ts`

### 4. 完成三个简单内部工具

OverflowTest 用固定 pattern 生成有界精确长度输出；Sleep 校验 duration/duration_ms、解析设置上下限并链接 abort 与 interruptible 状态；CtxInspect 调用 collectContextData 后格式化 JSON。明确 Overflow 仅提供调试输入、CtxInspect 不实现 collapse，且后两者注册门控不变。

涉及位置：`src/tools/OverflowTestTool/OverflowTestTool.ts`、`src/tools/SleepTool/SleepTool.ts`、`src/tools/CtxInspectTool/CtxInspectTool.ts`、`src/services/contextCollapse/index.ts`

### 5. 启用外部画像中的三个可用工具

在正式 build 和验证 fixture 中同步 MONITOR_TOOL、OVERFLOW_TEST_TOOL、TERMINAL_PANEL，让 src/tools.ts 既有插槽生效。画像预期更新为 30 个非空工具并检查 Monitor、OverflowTest、TerminalCapture，Sleep 和 CtxInspect 不因源码实现而被加入当前外部预期。

涉及位置：`scripts/build.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`、`src/tools.ts`

### 6. 补充分行、工具与本地 shell 回归

internalTools.test.ts 用纯 chunk 输入验证拼接/burst/CRLF/final flush，用 mock runner 核对 capture 参数和缺 session 错误，并覆盖另外三个工具。monitorToolIntegration.test.ts 用真实本地 printf 和任务队列观察两行及完成通知，同时注明它未覆盖权限 UI、timeout 和 tmux。

涉及位置：`tests/internalTools.test.ts`、`tests/monitorToolIntegration.test.ts`

### 7. 记录验证结果与功能边界

STATUS/RELEASE 更新 73/288、30 工具和本地 shell Monitor 结果，记录 typecheck/build/declarations/CLI smoke；Sleep/CtxInspect 标为 feature-gated，真实模型 perpetual、context-collapse、真实 tmux 和后续独立功能不被写成已完成。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 进程 result 与 stdout 最后 data/close 的事件顺序可能影响最终 flush，finished 后忽略迟到 chunk 是已明确的边界。
- 后台化清理 foreground timeout 后，Monitor 输入 timeout 不等同于独立后台看门狗，长期运行语义需另测。
- 早期行和通知队列涉及异步注册顺序，必须保持先缓冲、后按序排空，避免输出乱序或丢失。
- 终端 scrollback 与 shell 输出可能含敏感或标记文本；只读捕获和 XML escape 不能替代权限与内容审查。
- mock tmux、预中止 Sleep、构造 ContextData 无法覆盖真实外部依赖，文档必须保留这些验证缺口。

## 验证顺序

1. 以多种 chunk 切分运行 reporter 单元测试，精确比较完整行、150 行 CRLF burst、最终半行和重复 finish。
2. 运行本地 Monitor 集成测试，观察真实 task_id、输出文件、first/second 通知及 completed 最终状态。
3. 分别检查 bashToolHasPermission 调用参数与 BashPermissionRequest 代理；授权交互需在支持权限提示的环境另测。
4. 用 mock runner 核对 capture-pane 参数及无 new-session/attach-session，再在真实 tmux 环境单独验收 scrollback。
5. 验证 Overflow 精确长度、Sleep alias/min/max/abort 和 CtxInspect JSON；不要把空 collapse stats 当作 collapse 测试。
6. 构建独立特性包并核对 30 个非空工具及三个新增名称，同时确认 Sleep/CtxInspect 未被误纳入。
7. 依据 at-commit STATUS/RELEASE 引用 73/288、typecheck、build 和 CLI smoke；当前记录校验不作为历史执行替代。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- Monitor 已由禁用 stub 变为真实后台 shell 工具，stdout 分行、早期行、最终半行和通知链已经接通。
- Bash 权限函数、沙箱判断和权限 UI 已被 Monitor 复用。
- TerminalCapture 与可注入 TerminalPanel.capture 已实现，调用链不包含创建或附加 session。
- OverflowTest、Sleep、CtxInspect 的局部工具实现已完成，各自输入和输出契约明确。
- 三个外部 feature 已进入正式构建和画像 fixture，30 工具断言已更新。
- 九项新测试及 at-commit 73/288、类型检查、构建和 CLI smoke 记录已有对应文件与文档来源。

### 未完成或后续工作

- 真实 tmux、Monitor 权限交互、后台 timeout 和 exit/close 极端事件序列尚未验证。
- Sleep 所属 proactive 功能组与 CtxInspect 所属 context-collapse 功能组仍未激活完成。
- CtxInspect 当前只报告空 collapse 统计，不能观察真实折叠效果。
- Monitor stderr、失败/杀死、长会话背压和通知时序没有完整覆盖。
