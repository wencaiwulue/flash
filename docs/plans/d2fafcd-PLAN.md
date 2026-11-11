---
commit: d2fafcde7d75171be093fd40ec8d954c0f326d21
title: "Implement daemon and remote control server lifecycle"
date: 2026-11-10T20:11:39+08:00
status: implemented
kind: component
---

# 实施计划：Implement daemon and remote control server lifecycle

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把既有 CLI 入口变成可启动、查询、停止的 supervisor，并让 worker 失效时按有界退避重启、收到信号时终止活动 worker；同时让 assistant 与 remote-control worker 进入同一个 SDK Remote Control query 路径。交互命令还要复用已启动的服务、展示 session_url，并在停止时关闭远控、输入流和 query。提交内证据只覆盖 fake/mock 生命周期、编译特性档和 daemon status，真实 Cloud 建连及完整 OS 进程往返仍需单独验证。

- 确认父提交 daemonMain/runDaemonWorker 为 unavailable stub，而 cli.tsx 的 daemon 与 --daemon-worker 路由、commands.ts 的双 feature 命令注册已经存在。
- 确认父提交 agentSdkTypes.query 返回 InternalQuery，enableRemoteControl(true/false) 与 query.return 足以承载远控启停，不需要新增传输契约。
- 确认 cleanupRegistry、getClaudeConfigHomeDir、sleep 和本地命令类型可复用，DAEMON 尚未进入外部 build 与特性夹具。
- 将离线 fake 生命周期验证与真实 Cloud、真实进程信号验证分开，历史结果只能引用 at-commit STATUS/RELEASE。

## 复用与兼容处理

### 复用现有实现

- 复用 cli.tsx 的 DAEMON 快速入口与 commands.ts 的 DAEMON+BRIDGE_MODE 注册，不为 daemon 或命令增加第二条路由。
- 复用 query、InternalQuery.enableRemoteControl、sdkQuery remoteController 和 sdkRemoteControl，保持 SDK 远控消息与权限路径。
- 复用 registerCleanup/runCleanupFunctions，将 RunningServer 停止纳入现有退出清理。
- 复用 getClaudeConfigHomeDir 和现有文件系统 Promise API，集中 supervisor 记录路径、目录权限和文件权限。
- 复用 sleep 作为退避实现，同时通过 SupervisorOptions.spawn/wait 与 worker dependencies.start/wait 保留离线可控测试接缝。
- 复用现有 local-jsx/onDone、Bun feature 构建和 FEATURE_PROFILE 特性档，不添加新的命令框架或测试输出协议。

### 兼容、迁移与生命周期

- 保持既有 daemon [start|run|stop|status] [assistant|remote-control] 参数形态和 --daemon-worker 内部入口，原 stub 位置变为实现。
- 保持 InternalQuery.enableRemoteControl 和 RemoteControlServerInfo 的 session_url/connect_url/environment_id 数据形状，不要求 SDK 调用方迁移。
- remote-control-server 只在 DAEMON 与 BRIDGE_MODE 同时编译开启时注册，availability 继续限制为 claude-ai。
- DAEMON 加入 CLI/SDK 构建没有改变工具集合，特性档继续固定 34 个非空工具。
- 重复 start 返回已有 info、无运行实例时 stop/wait 安全返回，使命令、worker 和 cleanup 可共享同一模块 API。

## 文件级实施步骤

### 1. 先实现共享 Remote Control server 生命周期

在 server.ts 定义三项 ServerInfo 与最小 ServerQuery 接口，先写可关闭的 pendingInput，再实现 start 的单例检查、query 创建、enable(true)、失败清理和 RunningServer 发布。随后加入 getInfo、done/wait、cleanup 注册及 stop 的 running 撤销、enable(false)、input close、query.return 和 finally finish，使 worker 与交互命令能共享同一生命周期。

涉及位置：`src/commands/remoteControlServer/server.ts`

### 2. 接入交互命令外观

在 index.ts 以 local-jsx 命令包装 server API：优先显示已有 info，否则启动后显示 session_url，异常经 onDone 返回失败文本；声明 claude-ai availability 和恒定 isEnabled，把编译门控继续留给既有 commands.ts。

涉及位置：`src/commands/remoteControlServer/index.ts`

### 3. 建立有界 supervisor 状态机

在 supervisor.ts 定义最小 worker process 接口和可注入 spawn/wait 参数，实现 run 的重复调用保护、活动子进程事件等待、正常/主动停止、非零退出与 error 的重启上限及指数延迟。补上 getState、stop(SIGTERM) 和 finally 状态清理，让 main 只负责进程适配而不复制重启逻辑。

涉及位置：`src/daemon/supervisor.ts`

### 4. 实现 PID 记录和 daemon 子命令

在 main.ts 先实现 kind 文件名清理、记录读写、kill(pid,0) 与 stale cleanup，再实现 detached supervisor start、0600/0700 记录及写失败终止，随后实现 status/stop。最后以 --daemon-worker spawn 适配 DaemonSupervisor，连接 SIGINT/SIGTERM，并按 start/run/stop/status 分派输出和退出码。

涉及位置：`src/daemon/main.ts`

### 5. 把 worker registry 接到 server

在 workerRegistry.ts 用 switch 取代 unavailable stub，让 assistant 和 remote-control 顺序执行 start/wait；保留可注入依赖供离线测试，undefined 与未知 kind 分别给出确定错误。此步骤复用第一步的 server，不产生另一套 Remote Control 协议。

涉及位置：`src/daemon/workerRegistry.ts`

### 6. 启用构建并增加编译特性断言

在 build.ts 的共享 builds 循环 feature 列表加入 DAEMON，使 CLI 和 SDK 使用同一启用集合；在独立特性夹具加入相同标志并输出 hasRemoteControlServerCommand，在组合测试断言命令存在且工具总数仍为 34、nullCount 为 0。

涉及位置：`scripts/build.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 7. 补齐可控离线生命周期回归

在 daemon.test.ts 用 mock ServerQuery 验证顺序重复 start、enable true/false、return 和 wait，用注入 start/wait 验证 registry，用 EventEmitter FakeWorker 验证退避、上限和 stop，再在临时目录写死 PID 记录验证 status 删除文件；afterEach 调 stop 清理模块单例。测试不把这些替身结果描述为 Cloud 或真实进程证据。

涉及位置：`tests/daemon.test.ts`

### 8. 记录实际范围和执行结果

最后更新 STATUS 的全量计数与两个 offline lifecycle/build 能力行，并从后续实现列表移除 daemon；在 RELEASE 增加本组件段，准确记录 91 tests、390 assertions、typecheck、build/declarations、daemon status 和 34-tool profile，同时保留 lifecycle fakes、no live Cloud session 的限定。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- PID 复用或两个 start 并发写同一 JSON 可能造成误杀、误报或多个 supervisor；当前实现只有 kill(pid,0) 和普通 writeFile，没有身份验证或锁。
- 退避期间 stop 没有取消 wait，等待结束后循环仍可能创建 worker；测试只覆盖活动 worker 存在时的 stop。
- start 在 enable await 期间尚未发布 running，并发调用可能各自创建 query；当前幂等断言是顺序 await 后再 start。
- teardown 的 disable 失败会阻断 closeInput/query.return，虽然 finish 会执行，资源关闭并不完整；启动失败清理也可能受首个清理异常影响。
- fake query/FakeWorker 只能证明调用顺序和状态转换，不能覆盖 OAuth、Cloud 网络、真实 detached 进程、OS 信号或 SDK 远端权限行为。

## 验证顺序

1. 运行 daemon/server 定向测试，核对 createQuery 仅一次、enable 调用序列 true/false、query.return、info 清除和 wait 释放。
2. 用可控 worker 分别触发 code=1、code=0、连续失败和主动 stop，核对注入延迟、重启计数、上限异常及 running/active 清理。
3. 在临时 registryDir 写入不存在进程的 PID，执行 getDaemonStatus 并确认 running=false 与记录文件删除。
4. 执行独立 verify-enabled-features 构建，读取 FEATURE_PROFILE，核对 remote-control-server=true、toolCount=34、nullCount=0。
5. 依据 at-commit STATUS 引用 bun test 的 91 tests/390 assertions、typecheck 零错误和 build CLI/SDK/declarations；依据 RELEASE 引用 daemon status 与 34-tool profile。
6. 真实 daemon start/run/stop、worker 重启和 SIGINT/SIGTERM 应在隔离进程环境另做端到端验证，不能从 FakeWorker 结果补写为已通过。
7. 真实 Cloud Remote Control 建连、消息和权限往返只在授权环境验证，并单独记录来源；本提交明确没有该结果。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- daemonMain 的四个子命令、supervisor PID 记录、detached spawn 和 stale cleanup 已实现。
- DaemonSupervisor 的活动状态、有界指数重启、正常退出和 SIGTERM 停止已实现，runForeground 已连接 SIGINT/SIGTERM。
- assistant/remote-control worker 已统一分发到 SDK Remote Control server，未知类型会报错。
- 共享 query、pending input、启动失败清理、cleanup 注册、等待与正常 stop teardown 已实现。
- /remote-control-server 已实现并通过 DAEMON+BRIDGE_MODE 既有注册点进入外部构建。
- 六个离线 daemon/server 测试和独立特性档命令断言已加入，工具池约束保持 34。
- STATUS/RELEASE 已记录 91/390、typecheck、build/declarations、daemon status 和特性档结果及其离线边界。

### 未完成或后续工作

- live Cloud session、真实远端消息/权限以及 OAuth/组织环境交互未验证。
- 真实 detached start/stop、worker spawn 和 OS 信号往返未由新增测试执行。
- PID 复用、并发 daemon start、enable 阶段并发 server start 仍缺少互斥与回归覆盖。
- 退避期间停止不能唤醒 wait，disable 异常也可能跳过 input/query 的后续关闭步骤。
- RemoteControlServerInfo 只在进程内保存，重启后不能从 supervisor PID 文件恢复旧 query 或 session_url。
