---
commit: 301a3e7fb8da14c45f1bac77ead288302b7f2466
title: Monitor 与调试工具的实施顺序
date: 2026-11-10
retrospective: true
---

# Monitor 与调试工具的实施顺序

## 1. 先写行切分测试

在 `tests/internalTools.test.ts` 为 reporter 准备输入：

```ts
const lines: string[] = []
const reporter = createMonitorOutputReporter(line => lines.push(line))
reporter.push('first')
reporter.push(' line\nsecond\r\nthird')
reporter.push(' part')
reporter.finish()
reporter.finish()
expect(lines).toEqual(['first line', 'second', 'third part'])
```

再覆盖空 chunk、单 chunk 多行、最后空 pending 和 finish 后 push。

## 2. 实现 reporter 与 Monitor 任务连接

**文件：** `src/tools/MonitorTool/MonitorTool.ts`。

实现 pending 行缓冲和幂等 finish。`call()` 先创建 earlyLines，再启动 `exec()`，让 onStdout 直接 push reporter；`shellCommand.result.then()` 中 finish。取得 taskId 后先 flush earlyLines，再调用 `spawnShellTask({kind:'monitor'})`。

权限检查动态加载 `bashToolHasPermission()`，输入附加 `run_in_background:true`；sandbox 使用 `shouldUseSandbox(input)`。通知文本经 `escapeXml()` 后进入 `enqueuePendingNotification()`。

**集成验收：** `tests/monitorToolIntegration.test.ts` 用真实 shell 产生分块输出和最后 partial line，检查事件顺序与结束通知：

```bash
bun test tests/monitorToolIntegration.test.ts
```

## 3. 实现三个独立调试工具

- `CtxInspectTool.ts`：`call()` 动态加载 collectContextData，`formatContextInspection()` 只序列化现有数据与 getStats。
- `OverflowTestTool.ts`：`pattern.repeat(Math.ceil(size/pattern.length)).slice(0,size)`，schema 限制 1–2,000,000。
- `TerminalCaptureTool.ts`：调用 `getTerminalPanel().capture(lines)`，空字符串返回 0 行，否则按换行计数；不创建终端。

`src/utils/terminalPanel.ts` 提供实际 capture 状态，Monitor 权限组件只负责展示既有请求，不另开权限旁路。

验收：

```bash
bun test tests/internalTools.test.ts
```

## 4. 接入 feature profile

`scripts/build.ts` 只添加 `MONITOR_TOOL`、`OVERFLOW_TEST_TOOL`、`TERMINAL_PANEL`。同步更新 `tests/fixtures/verify-enabled-features.ts` 的注册断言和 `enabledFeatures.test.ts` 的工具集合，不硬凑其他 feature。

最终执行：

```bash
bun test tests/internalTools.test.ts tests/monitorToolIntegration.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

若早期输出丢失，优先检查 taskId 分配前的 earlyLines；若通知结构损坏，检查 escape；若工具未注册，检查 feature 与 registry 两层，不能仅增加工具数量断言。
