---
commit: a8c8b90fd2e7b5fa14ebb2bc6beff3f5c2904346
title: "Add lifecycle regressions and race fixes"
date: 2026-11-11T00:06:18+08:00
status: implemented
kind: component
---

# Add lifecycle regressions and race fixes

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 STATUS 仍把 changed-file offset/limit、cron recurring/aging 和 LSP restart/shutdown 列为验证缺口。changed-files 虽已在 getChangedFiles 中按缓存范围重读，但没有真实文件系统回归；cron 文件任务删除后依赖 chokidar reload 才清除内存项，磁盘已删而 watcher 未到的窗口可能再次触发；LSPClient 在崩溃后的 restart 中仍尝试向已关闭连接发送 shutdown，maxRestarts 超限路径也可能留下 stopped 状态或旧错误，而不是可观察的 error 终态。

需要以真实文件、真实调度器/锁和真实 stdio JSON-RPC 子进程固定这些生命周期语义，而不是只检查配置字段。修复必须落在正确竞态点：one-shot 删除成功后立即驱逐内存任务，连接关闭后跳过无响应的 shutdown 握手但仍完整清理，所有重启上限路径统一写入 error/lastError。提交内的 151/643 是文档记录的本地命令结果，不能自动等同于目标 SHA 的远端 CI 全绿；后续修复树的全绿也只能作为带完整 SHA 的 later evidence。

## 目标与非目标

### 目标

- 用真实临时文件验证 offset/limit 范围内重读、范围外变化抑制、全读兼容和 ENOENT 缓存驱逐。
- 为 cron 注入时间源，验证 one-shot 单次触发与删除、recurring 重排/老化及项目锁接管。
- 在磁盘删除 Promise 成功后同步清除内存任务，关闭 watcher reload 前的重复触发窗口。
- 跟踪 LSP 连接关闭状态，崩溃后跳过 shutdown/exit 握手并无条件释放连接、监听器和进程。
- 让 maxRestarts 的两条超限路径都设置 error 与准确的 lastError，并以真实 JSON-RPC fixture 验证生命周期。
- 区分测试新增、提交内命令记录和后续 CI 证据，不把不同 revision 的结果混写。

### 非目标

- 不修改 changed-files 的生产读取算法；本提交以真实文件回归证明既有 offset/limit 语义。
- 不覆盖图片、PDF、notebook、临时 stat 错误或完整模型附件消费链，新增范围测试聚焦文本文件。
- 不实现真实第三方 language server、socket transport 或所有异常帧场景的兼容测试。
- 不把 maxRestarts=0 的一次崩溃测试描述为多轮连续成功重启后超限。
- 不把 at-commit 文档中的本地 151/643 或后续 e31ff8f 的绿色 CI 反向标记为目标 SHA 的 GitHub CI 全绿。

## 方案架构与数据流

changed-files 继续由 FileReadTool 将 content、timestamp、offset、limit 写入 readFileState，getChangedFiles 在 mtime 更新后按原范围重建 FileReadTool 输入，经 isFileReadDenied 与 validateInput 的 deny/path 校验后直接调用 FileReadTool.call，再用旧/新局部内容生成 edited_text_file snippet；它不经过 checkPermissions 的完整权限协商。测试在真实临时目录写文件并以 utimes 推进 mtime：范围内修改只返回局部片段，重读后再次查询为空，范围外变化不报告；全读仍工作，删除文件只在 ENOENT 时驱逐缓存。

cronScheduler.ts 新增可选 now 函数，默认 Date.now，load 的 missed 判定与 check 的 tick 统一使用 nowFn，使测试可以精确推进六十秒而不改系统时钟。recurring 任务从当前时间计算下一触发并批量持久化 lastFiredAt；isRecurringTaskAged 保持 maxAgeMs=0 和 permanent 永不老化。文件任务仍只由项目锁 owner 执行，显式 dir 路径不读取 bootstrap session 状态。

文件型 one-shot 或 aged recurring 触发时先进入 inFlight，再异步 removeCronTasks。关键修复是在删除 Promise 成功后立即执行 tasks=tasks.filter(...)，随后 finally 才移除 inFlight；这样即使 chokidar 尚未 reload，旧内存项也不能再次触发。nextFireAt 同步删除，getNextFireTime 不再被已完成任务占据。该修复针对实际提交点，而不是单纯延长等待来掩盖竞态。

LSPClient 在闭包中增加 connectionClosed，每次 start 前置 false，子进程 exit 与 JSON-RPC onClose 都置 true。stop 只在 connection 存在且尚未关闭时发送 shutdown request 和 exit notification，崩溃后的 restart 不再等待永远无法响应的对端。无论握手跳过还是失败，finally 都清 timer、dispose connection、移除 process/stdin/stderr listeners、kill 并清空 process，同时复位 initialized/capabilities/isStopping。

LSPServerInstance 的 crash callback 将 state 置 error、记录 lastError、增加 crashRecoveryCount，并按 restartOnCrash 调 restart。restart 在 stop 后累计 restartCount，超过 maxRestarts 时现在同时写 lastError 和 state=error；start 的 crash-recovery 超限保护也明确 error。成功 start 会清 crashRecoveryCount，但累计 restartCount 不被隐式重置，健康状态仍要求 running 且 client.isInitialized。

fake-lsp-server.ts 是实际 Bun 子进程，通过 stdin 缓冲和 Content-Length 帧解析支持 initialize、x-echo、x-crash、shutdown。x-crash 以退出码 1 模拟异常，shutdown 先响应再按环境变量延迟退出。lspLifecycle.test.ts 因而经过真正的 vscode-jsonrpc 编解码和进程生命周期，覆盖 echo、一次崩溃重启、零重启上限及延迟退出时 stop 快速返回和 stopped 状态，而不是 mock sendRequest 的表面状态；该 shutdown 用例没有直接观察 connection/listener dispose 或子进程退出。

证据分为三层：测试源码说明覆盖被加入，at-commit STATUS/RELEASE 记录 151 tests/643 assertions、typecheck、build/declarations 和 42-tool profile，后续 271cf757 的 RELEASE 才记录 e31ff8f 的 CI 42861258902。三者不能互相替代，尤其后续树包含额外 cron/测试隔离修正和其他功能变化。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/RELEASE.md`，符号 `## Lifecycle regressions` | 记录 changed-files、cron、LSP 的修复范围和 151/643 本地验证声明。 |
| 变更 | `docs/STATUS.md`，符号 `Changed-file partial reads` | 把三项生命周期能力标为 Verified，更新测试总数并保留其他授权环境边界。 |
| 变更 | `src/services/lsp/LSPClient.ts`，符号 `connectionClosed` | 跟踪进程/连接关闭，崩溃后跳过握手并保证连接、监听器和进程清理。 |
| 变更 | `src/services/lsp/LSPServerInstance.ts`，符号 `createLSPServerInstance` | 在两类重启上限路径统一写入 error 和 lastError。 |
| 变更 | `src/utils/cronScheduler.ts`，符号 `const nowFn` | 注入时间源，并在磁盘删除成功后同步驱逐内存任务以修复重复触发竞态。 |
| 变更 | `tests/changedFiles.test.ts`，符号 `describe('changed-file offset/limit reads'` | 以真实文件和 mtime 固定局部重读、范围外变化、全读和删除驱逐。 |
| 变更 | `tests/cronLifecycle.test.ts`，符号 `describe('cron scheduler lifecycle'` | 覆盖 one-shot、recurring/aging 与真实项目锁接管。 |
| 变更 | `tests/fixtures/fake-lsp-server.ts`，符号 `process.stdin.on('data'` | 提供 Content-Length 帧解析、initialize/echo、异常退出和可延迟 shutdown 的真实子进程。 |
| 变更 | `tests/lspLifecycle.test.ts`，符号 `describe('LSP process lifecycle'` | 通过真实 JSON-RPC 子进程验证启动、请求、崩溃重启、上限和停止清理。 |
| 复用 | `src/utils/attachments.ts`，符号 `getChangedFiles` | 复用按缓存 offset/limit 重读、deny/path 校验、直接 FileReadTool.call、snippet 生成和 ENOENT 驱逐逻辑；不经过 checkPermissions。 |
| 复用 | `src/tools/FileReadTool/FileReadTool.ts`，符号 `readFileState.set` | 复用实际文件读取和 content/timestamp/offset/limit 缓存写入。 |
| 复用 | `src/utils/cronTasks.ts`，符号 `removeCronTasks` | 复用任务文件读取、删除和 lastFiredAt 持久化实现。 |
| 复用 | `src/utils/cronTasksLock.ts`，符号 `tryAcquireSchedulerLock` | 复用原子项目锁、PID 存活探测、stale 回收和 owner release 协议。 |

## 关键决策与工程取舍

- changed-files 用生产 FileReadTool 与真实文件做回归，而不是重新实现 diff 逻辑，确保测试证明的是实际附件路径。
- cron 只注入时间源，不注入整个调度器 fake；文件、watcher、锁和持久化仍参与测试。
- 内存驱逐放在 removeCronTasks 成功之后、inFlight 清理之前，使磁盘与内存在同一删除完成点对齐。
- LSP 以连接是否已关闭决定能否握手，而不是给崩溃 shutdown 再增加盲等超时；清理始终执行。
- maxRestarts 超限统一 error/lastError，避免 stopped 外表掩盖永久失败并误导后续健康检查。
- 历史验证按 revision 分层引用，后续绿色 CI 不用于粉饰目标提交原树的时序问题。

### 备选方案与回溯分析

- 回溯性比较：可以仅断言 FileReadTool 收到 offset/limit，但无法证明片段和缓存行为；实际用真实文件验证范围内外变化和 ENOENT。
- 回溯性比较：可以完全 mock cron 文件与锁以获得快速测试，但会漏掉删除/watch/接管竞态；实际保留真实调度基础设施并只控制时间。
- 回溯性比较：可以让 LSP stop 无论状态都发送 shutdown，协议表面统一却会在崩溃后悬挂；实际先检查连接关闭，再选择握手或直接清理。
- 回溯性比较：可以把所有验证结果写成同一组 passed，但会隐藏逐提交 CI 差异；实际将 at-commit 本地记录和后续完整 SHA 的 CI 分开。

## 安全与协议边界

- changed-file 自动重读经过 isFileReadDenied 和 FileReadTool.validateInput 的 deny/path 校验后直接调用 FileReadTool.call；不会执行 FileReadTool.checkPermissions，新增测试也未覆盖完整权限协商流程。
- 只有 ENOENT 会驱逐读取缓存，EACCES 等非 ENOENT 临时错误会保留既有状态；原子保存间隙若表现为 ENOENT，仍会触发驱逐。
- cron 文件任务仍受项目锁约束，session-only 任务与显式 dir 的 daemon/test 路径分离，避免共享目录重复执行。
- LSP 使用 spawn(command,args) 而非 shell，shutdown 后移除监听器并 kill 子进程，降低悬挂进程和迟到回调风险。
- LSP 环境由 subprocessEnv 与 config.env 合并，后者可以覆盖前者，不能把该实现描述为不可重新注入敏感变量的沙箱。
- 所有验证证据按提交和后续 revision 标注，防止以错误的执行状态驱动发布判断。

## 验收标准

- 局部读取后，范围内修改产生含新内容且不含范围外文本的 edited_text_file，重读后无变化查询为空。
- 范围外修改不产生附件，全读修改仍能报告，文件删除后返回空且 readFileState 对应项被移除。
- one-shot 推进到触发时间后只执行一次，磁盘记录和 nextFireAt 均清除；recurring 写 lastFiredAt 并保留下一触发时间。
- maxAgeMs=0 与 permanent 永不老化，普通 recurring 可按年龄过期；owner stop 后另一 scheduler 能按锁协议接管。
- LSP initialize/x-echo 正常，异常退出可重启一次，maxRestarts=0 时首次超限进入 error 并记录明确错误。
- 连接已关闭时 stop 不发送 shutdown，所有路径都释放连接、监听器和进程；延迟退出不会拖住 stop 状态清理。
- at-commit 文档记录 151/643 与构建结果，后续 e31ff8f 的 CI 仅作为 271cf757 提供的后续证据。

## 实现状态与剩余范围

- 状态：**implemented**
- 目标提交原树的 cron lock 接管和测试隔离仍有时序风险，后续 e31ff8f 的 stop/reset 与测试调整及其绿色 CI 是独立后续工作。
- cron 删除竞态测试没有显式暂停 watcher 来确定性复现窗口，aging 也只直接验证纯函数，没有覆盖最后一次触发后删除全链路。
- LSP maxRestarts 用例只验证 maxRestarts=0 的一次崩溃；shutdown 用例只断言 stop 在 500ms 内返回且 state=stopped，未直接验证 connection dispose、process/stdin/stderr listener 移除或子进程退出，也未单独证明 25ms timer 是唯一 killer。
- 真实第三方 language server、signal 退出、socket transport、startup timeout 和异常 JSON-RPC 帧仍未覆盖。
- changed-files 未覆盖非文本格式、deny rule、临时 stat 错误和端到端模型附件流程。
