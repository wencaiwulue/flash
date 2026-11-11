---
commit: 301a3e7fb8da14c45f1bac77ead288302b7f2466
title: Monitor 流式事件与上下文/终端调试工具设计
date: 2026-11-10
retrospective: true
---

# Monitor 流式事件与上下文/终端调试工具设计

## Monitor 控制流

`MonitorTool` 复用 Bash 权限和 sandbox 判断启动后台 shell，不把 watch 命令伪装成一次性 Bash 输出。

`createMonitorOutputReporter()` 用 pending 保存不完整行：每次 chunk 与 pending 拼接后按换行拆分，只报告完整行并去掉末尾 `\r`；进程结束时 flush 最后的 partial line，finished 后忽略新输入。

taskId 在 shellCommand 返回前可能尚不存在，因此 reporter 先把行放入 earlyLines；取得 taskId 后按原顺序发送，再注册 shell task。通知通过 `enqueuePendingNotification` 进入现有任务消息通道，description 和输出文本分别做 XML escape。

## 调试工具边界

| 工具 | 行为 | 边界 |
|---|---|---|
| `CtxInspect` | 复用 `collectContextData()`，输出 model/token/categories/messageBreakdown/apiUsage 和 context-collapse stats | 只读，不重新计算另一套 token 统计 |
| `OverflowTest` | 用固定十六进制 pattern 生成精确 size 的字符串，size 1–2,000,000 | 只用于 overflow 路径，不读取文件或 shell |
| `TerminalCapture` | 从现有 terminal panel capture 最近 lines，默认 200、最大 10,000 | 不创建或 attach 终端；空 panel 返回 0 行 |
| `Sleep` | 提供可中断的 duration/duration_ms 等待 | 是否启用由 proactive 状态和 feature gate 决定 |

构建只新增 `MONITOR_TOOL`、`OVERFLOW_TEST_TOOL`、`TERMINAL_PANEL` 三个 feature；工具 `isEnabled` 与最终 feature profile 分别核对。

## 验收标准

1. 任意 chunk 切分、CRLF、连续多行和最后无换行输入都产生完整且顺序一致的事件，finish 幂等。
2. taskId 尚未分配时产生的行不会丢失或越过早期通知；XML 特殊字符不会破坏通知结构。
3. Monitor 权限输入转为 `run_in_background:true` 的 Bash 权限检查，并沿用 sandbox 选择。
4. CtxInspect 字段来自现有 context collector；OverflowTest 长度精确且可并发；TerminalCapture 行数、空内容和 lines 上限正确。
5. `internalTools.test.ts`、`monitorToolIntegration.test.ts` 与 feature-profile 测试分别覆盖工具行为、真实 shell 行事件和构建注册。
