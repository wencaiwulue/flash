---
commit: d2fafcde7d75171be093fd40ec8d954c0f326d21
title: "Implement daemon and remote control server lifecycle"
date: 2026-11-10T20:11:39+08:00
status: implemented
kind: component
---

# Implement daemon and remote control server lifecycle

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交中的 daemonMain 与 runDaemonWorker 都只是抛出 unavailable 错误的 stub；CLI 的 daemon、--daemon-worker 快速入口以及 commands.ts 中同时受 DAEMON 与 BRIDGE_MODE 控制的 remote-control-server 注册点已经存在，但外部构建尚未启用 DAEMON，目标命令实现文件也不存在。另一方面，SDK query、InternalQuery.enableRemoteControl、sdkQuery 中的 remoteController 生命周期、cleanupRegistry 和 sleep 均可复用。因此本提交面对的是进程监督、PID 记录、worker 分发和 query 持有/ teardown 尚未接通，而不是缺少一套新的远控传输协议。

需要把既有 CLI 入口变成可启动、查询、停止的 supervisor，并让 worker 失效时按有界退避重启、收到信号时终止活动 worker；同时让 assistant 与 remote-control worker 进入同一个 SDK Remote Control query 路径。交互命令还要复用已启动的服务、展示 session_url，并在停止时关闭远控、输入流和 query。提交内证据只覆盖 fake/mock 生命周期、编译特性档和 daemon status，真实 Cloud 建连及完整 OS 进程往返仍需单独验证。

## 目标与非目标

### 目标

- 实现 daemon start、run、stop、status 四个子命令，以 supervisor PID 记录支撑幂等启动、运行查询、陈旧记录清理和信号停止。
- 建立独立 DaemonSupervisor，提供活动 worker 状态、默认五次有界重启、指数退避、正常退出传播及 SIGINT/SIGTERM 停止链接。
- 让 workerRegistry 接受 assistant 与 remote-control，拒绝缺失或未知类型，并统一启动和等待 SDK Remote Control server。
- 以模块级 RunningServer 共享一个 query，提供启动、查询信息、等待和停止 API，串接 enableRemoteControl、pending input、cleanup registry 与 query.return。
- 提供 /remote-control-server 的 claude-ai local-jsx 命令，并在外部 CLI/SDK 构建及独立特性夹具中启用 DAEMON。
- 加入离线 supervisor/server/PID 回归与命令注册断言，在 STATUS/RELEASE 中记录 91 tests、390 assertions 及构建结果，同时保留 fake 与无 live Cloud session 的边界。

### 非目标

- 不另写 WebSocket、权限或 Remote Control wire protocol；worker 与命令都进入既有 query.enableRemoteControl 及其 SDK controller。
- 不修改 InternalQuery.enableRemoteControl 的公共契约或 sdkQuery/sdkRemoteControl 的底层实现，本提交只消费既有能力。
- 不宣称完成真实 Cloud、OAuth、组织策略或远端会话往返；示例 URL 和 createQuery 均为离线测试替身。
- 不建立可跨进程查询的 RemoteControlServerInfo 注册表；running 只在模块内保存，磁盘 DaemonRecord 只描述 supervisor 的 pid/kind/startedAt。
- 不加入并发 start 锁、PID 启动身份校验、日志管理或通用进程托管协议，start/status/stop 仍是单文件 PID 记录模型。

## 方案架构与数据流

入口层复用父提交已经存在的两条 CLI 快速路径：DAEMON 开启时，daemon 参数进入 daemonMain，--daemon-worker <kind> 进入 runDaemonWorker；commands.ts 也已在 DAEMON 与 BRIDGE_MODE 同时开启时加载 remoteControlServer/index.ts。本提交没有改这些路由文件，而是在 scripts/build.ts 的 CLI 与 SDK Bun.build feature 列表加入 DAEMON，使原有 daemon 路由、worker 路由和命令注册与实际实现同时进入外部构建。

daemon/main.ts 将默认 kind=assistant 的记录写到 getClaudeConfigHomeDir()/daemon/<sanitized-kind>.json，kind 中非字母数字、下划线和连字符的字符替换为下划线。readRecord 只接受 pid 为正整数的 JSON，isAlive 用 process.kill(pid, 0) 探测。startDaemon 对仍存活记录直接返回，对死记录先删除；随后以 process.execPath、process.argv[1] 和 daemon run <kind> 创建 detached、stdio=ignore、继承环境的 supervisor，调用 unref，再把 supervisor 的 PID、kind 和 ISO startedAt 写入 0700 目录中的 0600 文件。写记录失败时向新 child 发 SIGTERM 并抛出原错误。

状态与停止共享同一记录格式。getDaemonStatus 对无有效记录返回 running=false，对 kill(pid,0) 失败的记录删除文件后返回 false，否则返回 running=true 和 supervisor pid。stopDaemon 先读取并删除记录，无记录返回 false；死 PID 同样返回 false，活 PID 则发送 SIGTERM 并返回 true。daemonMain 默认执行 status，start/run/stop 分别输出 PID 文本、前台运行结果或停止文本，未知命令给出固定 Usage 错误。这里的 PID 是 detached supervisor，不是其下不断替换的 worker。

DaemonSupervisor 以 active、stopping、running、restarts 管理单个运行循环，重复 run 会直接报错，getState 暴露 running、restarts 和当前活动 worker pid。每轮调用注入的 spawn(kind)，同时监听 error 与 exit；主动停止时返回退出码或 0，不再重启，正常 code=0 也直接结束。其他退出或 error 在重启额度耗尽后抛出带 kind、重启次数和原因的异常，否则按 baseDelayMs * 2^restarts 计算延迟，默认 base=1000、maximum=30000、maxRestarts=5，随后递增计数并等待。stop 只设置 stopping 并向 active 发送 SIGTERM，finally 统一清理 running/active。

runForeground 把 supervisor 的 spawn 适配为 process.execPath + 当前 CLI + --daemon-worker <kind>，worker 使用 stdio=inherit 并继承环境；supervisor.run 的返回码写入 process.exitCode。SIGINT 与 SIGTERM 以 once 注册到同一 stop 回调，运行结束后的 finally 移除监听。由此形成 CLI start 所记录的 supervisor PID、前台信号处理和内部 worker PID 三层关系，worker 崩溃只影响 supervisor 循环，不改写磁盘中的 supervisor 记录。

workerRegistry.ts 不再抛出 unavailable，而是把 assistant 与 remote-control 两种已知 kind 都映射到 startRemoteControlServer() 后接 waitForRemoteControlServer()；dependencies.start/wait 允许离线测试注入。undefined 抛出 Missing daemon worker kind，其他值抛出 Unknown daemon worker kind。生产路径没有为两种 kind 建立不同协议，二者都持有同一个 SDK Remote Control server 生命周期。

remoteControlServer/server.ts 以 ServerQuery=Pick<InternalQuery, enableRemoteControl|return> 限定依赖。pendingInput 构造没有业务消息的 AsyncIterable<SDKUserMessage>：next 等待 wake，close 或 iterator.return 设置 closed、唤醒等待者并返回 done。startRemoteControlServer 在 running 已存在时直接返回同一份 info；否则以该 input 和 cwd 创建 query，等待 enableRemoteControl(true) 返回 session_url、connect_url、environment_id。启用失败时先 close input、再 query.return 并重新抛出；成功后才构造 RunningServer、注册全局 cleanup 并设置 running，因此顺序发起的重复启动不会重复建 query。

RunningServer 同时保存 query、closeInput、info、done、finish 和 unregisterCleanup。waitForRemoteControlServer 等待 done，worker 因而保持存活。stopRemoteControlServer 先取出 server 并立即清空 running、注销 cleanup，再按 enableRemoteControl(false)、closeInput、query.return(undefined) 的正常顺序 teardown，finally 无条件 finish，使重复 stop 成为无操作且等待者能够结束。registerCleanup 将同一 stop 接入现有优雅退出集合，避免退出路径另建一套 server 关闭逻辑；若 disable 本身抛错，后续 close/return 并不会执行，这是实现保留的异常边界。

remoteControlServer/index.ts 提供 local-jsx 命令：call 先取 getRemoteControlServerInfo，缺失时才 await start，再把 session_url 交给 onDone；启动异常被格式化为 Failed to start 文本。命令 availability 为 claude-ai、isEnabled 恒 true，真正的编译可见性仍由 commands.ts 的 DAEMON+BRIDGE_MODE 门控。特性夹具同步加入 DAEMON 并输出 hasRemoteControlServerCommand，组合测试断言其为 true，工具总数仍固定为 34，说明本提交新增的是命令与 daemon 生命周期而非新工具。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/RELEASE.md`，符号 `## Daemon and Remote Control server lifecycle` | 记录 supervisor、worker SDK 分发、共享 query teardown 及 91/390 等历史结果，并明确 fakes 与无 live Cloud。 |
| 变更 | `docs/STATUS.md`，符号 `Daemon supervisor and worker registry` | 把能力范围标为 offline lifecycle/build，更新 91/390 并从下一实现顺序移除 daemon。 |
| 变更 | `scripts/build.ts`，符号 `'DAEMON'` | 在外部 CLI 与 SDK 构建 feature 列表启用 DAEMON，接通既有入口和新增实现。 |
| 变更 | `src/commands/remoteControlServer/index.ts`，符号 `async function call` | 实现 claude-ai local-jsx 命令，复用已有 server info、按需启动并报告 session_url 或错误。 |
| 变更 | `src/commands/remoteControlServer/server.ts`，符号 `startRemoteControlServer` | 实现 pending input、共享 SDK query、模块级 server 状态、启动失败清理、等待和正常 teardown。 |
| 变更 | `src/daemon/main.ts`，符号 `startDaemon` | 实现 supervisor PID 记录、detached spawn、start/run/stop/status、陈旧清理及前台信号连接。 |
| 变更 | `src/daemon/supervisor.ts`，符号 `export class DaemonSupervisor` | 实现 worker 活动状态、退出/error 处理、有界指数重启、可注入等待和主动停止。 |
| 变更 | `src/daemon/workerRegistry.ts`，符号 `runDaemonWorker` | 将 assistant/remote-control 分发到 SDK Remote Control server，并对缺失和未知 kind 报错。 |
| 变更 | `tests/daemon.test.ts`，符号 `describe('DaemonSupervisor'` | 以 mock query、FakeWorker 和临时 PID 目录覆盖 server、registry、重启、停止和陈旧记录。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `hasRemoteControlServerCommand` | 断言独立编译特性档注册 remote-control-server，保持既有 34 工具约束。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `hasRemoteControlServerCommand` | 在干净 Bun 构建中启用 DAEMON，并把命令注册结果写入 FEATURE_PROFILE。 |
| 复用 | `src/entrypoints/cli.tsx`，符号 `args[0] === '--daemon-worker'` | 复用父提交已有 DAEMON worker 快速路径和 daemon 主命令分派，本提交未修改该文件。 |
| 复用 | `src/commands.ts`，符号 `remoteControlServerCommand` | 复用已有 DAEMON+BRIDGE_MODE 条件加载和 COMMANDS 注册位置。 |
| 复用 | `src/entrypoints/agentSdkTypes.ts`，符号 `export function query` | 复用既有 SDK query 工厂，把 pending AsyncIterable 转为 InternalQuery。 |
| 复用 | `src/entrypoints/sdk/runtimeTypes.ts`，符号 `enableRemoteControl(enabled: boolean)` | 复用 InternalQuery 已定义的 enable/disable 契约和三项 session 信息。 |
| 复用 | `src/utils/sdkQuery.ts`，符号 `enableRemoteControl: async` | 复用 query 内 remoteController 的创建、重复 enable 信息返回和 disable stop。 |
| 复用 | `src/utils/sdkRemoteControl.ts`，符号 `startSdkRemoteControl` | 底层继续使用既有 SDK 消息、控制、权限和 controller.stop 生命周期。 |
| 复用 | `src/utils/cleanupRegistry.ts`，符号 `registerCleanup` | 把 server stop 注册进现有优雅退出清理集合，并取得注销函数。 |
| 复用 | `src/utils/envUtils.ts`，符号 `getClaudeConfigHomeDir` | 复用配置目录定位，将 supervisor JSON 记录置于其 daemon 子目录。 |
| 复用 | `src/utils/sleep.ts`，符号 `export function sleep` | 作为生产 supervisor 的默认退避等待，测试则注入 wait 记录延迟。 |

## 关键决策与工程取舍

- 将 supervisor 与 worker 分为两个进程层级，磁盘只记录 supervisor PID；worker 可由 --daemon-worker 重新创建而不让 start/status 的记录随重启变化。
- 重启采用显式 maxRestarts 与指数等待，而不是无限紧循环；默认最多重启五次，主动 stop 和 code=0 均退出循环，错误在额度耗尽后向上可见。
- assistant 与 remote-control 共用 Remote Control server 启动/等待函数，避免 worker 类型各自解释 SDK 建连和 teardown。
- server 使用模块级单例并在 enable 成功后才发布 running；已发布实例的重复 start 返回原 info，stop 则在异步 teardown 前先撤销全局可见性。
- pending input 只承担维持流式 query 与可关闭输入的职责，远控消息仍由既有 SDK remoteController 的输入输出任务处理，本层不伪造用户消息或 Cloud 响应。
- 通过构建 feature 列表启用既有 CLI/command 路由，不修改 cli.tsx 和 commands.ts；独立特性构建使用相同 DAEMON 标志验证真实打包后的注册结果。

### 备选方案与回溯分析

- 回溯性比较：另建 daemon 专用 Remote Control 传输会复制既有权限、消息和控制处理；实际实现调用 query.enableRemoteControl，并保留 sdkQuery/sdkRemoteControl 作为唯一协议路径。
- 回溯性比较：无限重启或固定短间隔会分别造成失控进程循环和故障时频繁 spawn；实际选择默认五次、1 秒起倍增且可封顶的退避，并把次数与活动 PID 暴露在状态中。
- 回溯性比较：每次 /remote-control-server 都创建 query 会产生多个输入流和远控控制器；实际以 RunningServer 单例复用 info/query，并由同一实例完成 stop 与 cleanup。
- 回溯性比较：把 worker PID 写入 status 记录会在每次重启后改变身份；实际记录 detached supervisor PID，worker PID 仅由 DaemonSupervisor.getState 提供。

## 安全与协议边界

- PID 文件名对 kind 做字符白名单式替换，记录目录使用 0700、记录文件使用 0600；JSON 仅包含 pid、kind、startedAt，不写入继承环境中的凭据。
- detached supervisor 和 worker 都继承 process.env，这保持既有 CLI 配置可用，但也意味着调用者环境会进入后台进程；本提交没有增加环境过滤或凭据隔离。
- kill(pid,0) 与 SIGTERM 只依据记录中的数字 PID，没有校验进程可执行文件或 startedAt 身份；PID 被复用时可能误报或误发信号，不能将该记录视为强所有权证明。
- /remote-control-server 声明 claude-ai availability，并受 DAEMON+BRIDGE_MODE 编译门控；真实 query 路径仍要求组织 UUID、OAuth token 和 remoteControlFactory 成功，离线 mock 不替代这些检查。
- 启动 enable 失败会尝试关闭 input 和 query，正常停止会先 disable 再关闭 input/query；停止异常只保证 done finish，不保证后续所有资源步骤都已执行。

## 验收标准

- start 对存活 supervisor 记录幂等返回，新启动写正整数 PID 记录；status 清理不可存活 PID 的陈旧文件，stop 删除记录并向存活 supervisor 发 SIGTERM。
- worker 非零退出或 error 按配置退避重启，达到 maxRestarts 后抛出错误；code=0 正常结束，stop 终止活动 worker 且不触发重启。
- runForeground 将 SIGINT/SIGTERM 链接到 supervisor.stop，并将 run 的最终码赋给 process.exitCode；worker 使用 --daemon-worker 进入 registry。
- assistant 与 remote-control 均启动并等待 Remote Control server，undefined 和未知 kind 返回明确错误。
- 顺序重复 start 只创建一个 query 并返回同一 info；正常 stop 依次发送 enable true/false、关闭输入和 return query，清理 running 并释放 waitForRemoteControlServer。
- /remote-control-server 展示已有或新启动服务的 session_url，外部 DAEMON+BRIDGE_MODE 特性构建包含该命令且工具池仍为 34 个非空工具。
- STATUS 的 Verified 仅指 offline lifecycle/build 范围；91/390、typecheck、build/declarations、daemon status 和特性档是提交内记录，fakes 不得解释为 live Cloud 通过。

## 实现状态与剩余范围

- 状态：**implemented**
- 真实 Cloud/OAuth Remote Control 会话、远端消息与权限往返仍未验证；STATUS 继续把 real Cloud API and remote bridge round trips 留在授权环境后续步骤。
- PID 记录没有启动身份或进程名核验，且并发 startDaemon 没有文件锁/原子占用；PID 复用与并发启动都不是当前测试覆盖的强一致场景。
- supervisor 在退避 wait 期间收到 stop 不会唤醒计时器，循环等待后仍可能先 spawn 下一个 worker；当前 stop 只对调用时的 active 发信号。
- server 在 enable await 尚未完成时还没有设置 running，并发 start 可创建多个 query；正常顺序启动的幂等测试不覆盖这一竞态。
- stop 中 disable 抛错会跳过 closeInput 和 query.return，只有 running 清除、cleanup 注销和 done finish 得到保证。
