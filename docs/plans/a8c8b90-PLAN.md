---
commit: a8c8b90fd2e7b5fa14ebb2bc6beff3f5c2904346
title: "Add lifecycle regressions and race fixes"
date: 2026-11-11T00:06:18+08:00
status: implemented
kind: component
---

# 实施计划：Add lifecycle regressions and race fixes

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要以真实文件、真实调度器/锁和真实 stdio JSON-RPC 子进程固定这些生命周期语义，而不是只检查配置字段。修复必须落在正确竞态点：one-shot 删除成功后立即驱逐内存任务，连接关闭后跳过无响应的 shutdown 握手但仍完整清理，所有重启上限路径统一写入 error/lastError。提交内的 151/643 是文档记录的本地命令结果，不能自动等同于目标 SHA 的远端 CI 全绿；后续修复树的全绿也只能作为带完整 SHA 的 later evidence。

- 确认 changed-files 的生产代码已支持 offset/limit，本提交主要缺真实文件回归而非另写算法。
- 确认 cron 的文件删除、chokidar reload、inFlight 和项目锁可以共同构造真实生命周期场景。
- 确认 LSPClient/LSPServerInstance 的 stop/restart 分工，修复必须保证已关闭连接不再等待握手。
- 分别保存 at-commit 本地结果和后续 CI 结果，验证文档不得跨 revision 借用过绿状态。

## 复用与兼容处理

### 复用现有实现

- 复用 FileReadTool、getChangedFiles 和真实 FileStateCache，不建立平行附件实现。
- 复用 readCronTasks/removeCronTasks/markCronTasksFired、chokidar 和 cronTasksLock。
- 复用 vscode-jsonrpc、createMessageConnection 和实际 Bun child_process.spawn。
- 复用 createCronScheduler/createLSPServerInstance 的公开生命周期接口，避免测试专用状态旁路。
- 复用 STATUS/RELEASE 的历史证据格式，并用后续完整 SHA 标明 later evidence。

### 兼容、迁移与生命周期

- changed-files 生产 API 和附件结构不变，只增加真实回归；全读路径保持既有行为。
- CronSchedulerOptions.now 为可选参数，未提供时继续使用 Date.now，现有 REPL/daemon 调用无需修改。
- cron 文件、锁和 lastFiredAt 格式不变，内存驱逐只修正删除后的调度视图。
- LSPClient.stop 与 LSPServerInstance 公共接口不变，正常活跃连接仍按 shutdown/exit 协议关闭。
- maxRestarts 默认值和计数方式保持，只有超限后的可观察状态和错误信息被补齐。

## 文件级实施步骤

### 1. 用真实文件固定局部变更读取

新增 changedFiles.test.ts，在临时目录通过 FileReadTool 写入实际 readFileState，再修改文件并用 utimes 推进 mtime。依次断言范围内 snippet、重读去重、范围外抑制、全读兼容和 ENOENT 驱逐，直接验证 getChangedFiles 的既有生产路径。

涉及位置：`tests/changedFiles.test.ts`

### 2. 注入 cron 时间并修复删除竞态

在 cronScheduler.ts 增加 now 选项并统一 load/check 的时间读取。文件任务触发后保留 inFlight，removeCronTasks 成功时立即过滤内存 tasks 和清理 nextFireAt，finally 再解除 inFlight；recurring 仍按 now 重排并持久化 lastFiredAt。

涉及位置：`src/utils/cronScheduler.ts`

### 3. 覆盖 cron 单次、重排、老化和锁接管

新增 cronLifecycle.test.ts，使用真实任务文件和两个调度器。通过注入时间验证 one-shot 只触发一次且删除、recurring 持久化并重排，再直接检查普通老化、maxAgeMs=0 和 permanent；最后停止 owner 并等待另一调度器接管，保留真实锁与 watcher 参与。

涉及位置：`tests/cronLifecycle.test.ts`

### 4. 实现 LSP 关闭感知和重启终态

在 LSPClient.ts 跟踪 connectionClosed，start 重置、exit/onClose 置位，stop 仅对活连接发送 shutdown/exit，并在 finally 完成全部资源清理。LSPServerInstance.ts 随后在 restartCount 和 crashRecoveryCount 超限分支统一写 lastError/state=error，避免永久失败看似 stopped。

涉及位置：`src/services/lsp/LSPClient.ts`、`src/services/lsp/LSPServerInstance.ts`

### 5. 以真实 JSON-RPC 子进程验证生命周期

先实现 fake-lsp-server.ts 的 Content-Length 缓冲解析及 initialize/x-echo/x-crash/shutdown，再用 lspLifecycle.test.ts 驱动正常 echo、一次崩溃重启、maxRestarts=0 和延迟退出。测试收口调用 stop，验证状态与耗时，同时不把 fake server 外推为第三方 LSP 兼容证明。

涉及位置：`tests/fixtures/fake-lsp-server.ts`、`tests/lspLifecycle.test.ts`

### 6. 记录本地结果并隔离后续 CI 证据

STATUS/RELEASE 将三项能力改为 Verified 并记录 151/643、typecheck、build/declarations 和 42-tool profile，但不写入目标 SHA 的虚构 CI 状态。后续 271cf757 的 RELEASE 仅作为 later evidence 记录 e31ff8f 的 CI 42861258902，通过完整 SHA 明确其包含额外修复。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 若只依赖 watcher 清理，one-shot 会在磁盘删除后再次触发；内存过滤必须与删除 Promise 的成功点绑定。
- 真实 watcher/锁测试可能受时序影响，目标原树的接管风险不能被后续绿色 CI 隐去。
- 崩溃连接若仍发送 shutdown 会悬挂 restart，但无条件跳过正常握手又会破坏协议；connectionClosed 区分两类状态。
- 进程清理若遗漏监听器或 timer 会产生迟到回调和资源泄漏，因此必须放在 finally。
- 真实 fake LSP 只覆盖所选协议路径，测试名称中的 force-kill 不应被过度解释为 timer 路径已被独立证明。
- 本地命令记录、测试新增和后续 CI 是不同证据等级，混写会造成错误发布结论。

## 验证顺序

1. 运行 changed-files 定向测试，检查范围内 snippet、范围外空结果、再次查询去重和删除缓存驱逐。
2. 推进 cron 注入时间，观察 one-shot 单次触发、磁盘删除、nextFireTime=null，以及 recurring lastFiredAt 和重排。
3. 分别检查普通 recurring 老化、maxAgeMs=0、permanent，并运行两个 scheduler 的锁接管场景。
4. 运行 LSP 定向测试，核对真实 echo、一次 crash 后 restartCount=1、maxRestarts=0 的 error/lastError。
5. 以延迟 shutdown fixture 检查 stop 快速返回和 stopped 状态，并确认 afterEach 再次 stop 不重启。
6. 依据 at-commit STATUS 引用 151/643、typecheck、build/declarations；后续 CI 42861258902 只能按 271cf757 的 later evidence 引用。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- changed-files 的真实 offset/limit、范围外、全读和 ENOENT 回归已经加入。
- cron 时间注入、one-shot/recurring/aging/锁测试及删除后内存驱逐修复已经完成。
- LSP 关闭感知、崩溃清理和 maxRestarts error/lastError 终态已经实现。
- 真实 stdio JSON-RPC fake server 与四项生命周期测试已经加入。
- at-commit 文档记录 151/643 和构建结果，后续全绿 CI 已按完整后代 SHA 单独标注。

### 未完成或后续工作

- 目标提交原树的 cron 接管与测试隔离仍需后续 e31ff8f 等修正才能获得已记录的全绿 CI。
- watcher 延迟确定性注入、aged recurring 最终删除全链路和多轮 LSP 崩溃上限尚未覆盖。
- 第三方语言服务器、非 stdio 传输、非文本 changed-files 和完整模型附件链未在该提交验证。
