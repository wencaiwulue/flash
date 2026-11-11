import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'd2fafcde7d75171be093fd40ec8d954c0f326d21',
  title: 'Implement daemon and remote control server lifecycle',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交中的 daemonMain 与 runDaemonWorker 都只是抛出 unavailable 错误的 stub；CLI 的 daemon、--daemon-worker 快速入口以及 commands.ts 中同时受 DAEMON 与 BRIDGE_MODE 控制的 remote-control-server 注册点已经存在，但外部构建尚未启用 DAEMON，目标命令实现文件也不存在。另一方面，SDK query、InternalQuery.enableRemoteControl、sdkQuery 中的 remoteController 生命周期、cleanupRegistry 和 sleep 均可复用。因此本提交面对的是进程监督、PID 记录、worker 分发和 query 持有/ teardown 尚未接通，而不是缺少一套新的远控传输协议。',
  problem:
    '需要把既有 CLI 入口变成可启动、查询、停止的 supervisor，并让 worker 失效时按有界退避重启、收到信号时终止活动 worker；同时让 assistant 与 remote-control worker 进入同一个 SDK Remote Control query 路径。交互命令还要复用已启动的服务、展示 session_url，并在停止时关闭远控、输入流和 query。提交内证据只覆盖 fake/mock 生命周期、编译特性档和 daemon status，真实 Cloud 建连及完整 OS 进程往返仍需单独验证。',
  goals: [
    '实现 daemon start、run、stop、status 四个子命令，以 supervisor PID 记录支撑幂等启动、运行查询、陈旧记录清理和信号停止。',
    '建立独立 DaemonSupervisor，提供活动 worker 状态、默认五次有界重启、指数退避、正常退出传播及 SIGINT/SIGTERM 停止链接。',
    '让 workerRegistry 接受 assistant 与 remote-control，拒绝缺失或未知类型，并统一启动和等待 SDK Remote Control server。',
    '以模块级 RunningServer 共享一个 query，提供启动、查询信息、等待和停止 API，串接 enableRemoteControl、pending input、cleanup registry 与 query.return。',
    '提供 /remote-control-server 的 claude-ai local-jsx 命令，并在外部 CLI/SDK 构建及独立特性夹具中启用 DAEMON。',
    '加入离线 supervisor/server/PID 回归与命令注册断言，在 STATUS/RELEASE 中记录 91 tests、390 assertions 及构建结果，同时保留 fake 与无 live Cloud session 的边界。',
  ],
  nonGoals: [
    '不另写 WebSocket、权限或 Remote Control wire protocol；worker 与命令都进入既有 query.enableRemoteControl 及其 SDK controller。',
    '不修改 InternalQuery.enableRemoteControl 的公共契约或 sdkQuery/sdkRemoteControl 的底层实现，本提交只消费既有能力。',
    '不宣称完成真实 Cloud、OAuth、组织策略或远端会话往返；示例 URL 和 createQuery 均为离线测试替身。',
    '不建立可跨进程查询的 RemoteControlServerInfo 注册表；running 只在模块内保存，磁盘 DaemonRecord 只描述 supervisor 的 pid/kind/startedAt。',
    '不加入并发 start 锁、PID 启动身份校验、日志管理或通用进程托管协议，start/status/stop 仍是单文件 PID 记录模型。',
  ],
  architecture: [
    '入口层复用父提交已经存在的两条 CLI 快速路径：DAEMON 开启时，daemon 参数进入 daemonMain，--daemon-worker <kind> 进入 runDaemonWorker；commands.ts 也已在 DAEMON 与 BRIDGE_MODE 同时开启时加载 remoteControlServer/index.ts。本提交没有改这些路由文件，而是在 scripts/build.ts 的 CLI 与 SDK Bun.build feature 列表加入 DAEMON，使原有 daemon 路由、worker 路由和命令注册与实际实现同时进入外部构建。',
    'daemon/main.ts 将默认 kind=assistant 的记录写到 getClaudeConfigHomeDir()/daemon/<sanitized-kind>.json，kind 中非字母数字、下划线和连字符的字符替换为下划线。readRecord 只接受 pid 为正整数的 JSON，isAlive 用 process.kill(pid, 0) 探测。startDaemon 对仍存活记录直接返回，对死记录先删除；随后以 process.execPath、process.argv[1] 和 daemon run <kind> 创建 detached、stdio=ignore、继承环境的 supervisor，调用 unref，再把 supervisor 的 PID、kind 和 ISO startedAt 写入 0700 目录中的 0600 文件。写记录失败时向新 child 发 SIGTERM 并抛出原错误。',
    '状态与停止共享同一记录格式。getDaemonStatus 对无有效记录返回 running=false，对 kill(pid,0) 失败的记录删除文件后返回 false，否则返回 running=true 和 supervisor pid。stopDaemon 先读取并删除记录，无记录返回 false；死 PID 同样返回 false，活 PID 则发送 SIGTERM 并返回 true。daemonMain 默认执行 status，start/run/stop 分别输出 PID 文本、前台运行结果或停止文本，未知命令给出固定 Usage 错误。这里的 PID 是 detached supervisor，不是其下不断替换的 worker。',
    'DaemonSupervisor 以 active、stopping、running、restarts 管理单个运行循环，重复 run 会直接报错，getState 暴露 running、restarts 和当前活动 worker pid。每轮调用注入的 spawn(kind)，同时监听 error 与 exit；主动停止时返回退出码或 0，不再重启，正常 code=0 也直接结束。其他退出或 error 在重启额度耗尽后抛出带 kind、重启次数和原因的异常，否则按 baseDelayMs * 2^restarts 计算延迟，默认 base=1000、maximum=30000、maxRestarts=5，随后递增计数并等待。stop 只设置 stopping 并向 active 发送 SIGTERM，finally 统一清理 running/active。',
    'runForeground 把 supervisor 的 spawn 适配为 process.execPath + 当前 CLI + --daemon-worker <kind>，worker 使用 stdio=inherit 并继承环境；supervisor.run 的返回码写入 process.exitCode。SIGINT 与 SIGTERM 以 once 注册到同一 stop 回调，运行结束后的 finally 移除监听。由此形成 CLI start 所记录的 supervisor PID、前台信号处理和内部 worker PID 三层关系，worker 崩溃只影响 supervisor 循环，不改写磁盘中的 supervisor 记录。',
    'workerRegistry.ts 不再抛出 unavailable，而是把 assistant 与 remote-control 两种已知 kind 都映射到 startRemoteControlServer() 后接 waitForRemoteControlServer()；dependencies.start/wait 允许离线测试注入。undefined 抛出 Missing daemon worker kind，其他值抛出 Unknown daemon worker kind。生产路径没有为两种 kind 建立不同协议，二者都持有同一个 SDK Remote Control server 生命周期。',
    'remoteControlServer/server.ts 以 ServerQuery=Pick<InternalQuery, enableRemoteControl|return> 限定依赖。pendingInput 构造没有业务消息的 AsyncIterable<SDKUserMessage>：next 等待 wake，close 或 iterator.return 设置 closed、唤醒等待者并返回 done。startRemoteControlServer 在 running 已存在时直接返回同一份 info；否则以该 input 和 cwd 创建 query，等待 enableRemoteControl(true) 返回 session_url、connect_url、environment_id。启用失败时先 close input、再 query.return 并重新抛出；成功后才构造 RunningServer、注册全局 cleanup 并设置 running，因此顺序发起的重复启动不会重复建 query。',
    'RunningServer 同时保存 query、closeInput、info、done、finish 和 unregisterCleanup。waitForRemoteControlServer 等待 done，worker 因而保持存活。stopRemoteControlServer 先取出 server 并立即清空 running、注销 cleanup，再按 enableRemoteControl(false)、closeInput、query.return(undefined) 的正常顺序 teardown，finally 无条件 finish，使重复 stop 成为无操作且等待者能够结束。registerCleanup 将同一 stop 接入现有优雅退出集合，避免退出路径另建一套 server 关闭逻辑；若 disable 本身抛错，后续 close/return 并不会执行，这是实现保留的异常边界。',
    'remoteControlServer/index.ts 提供 local-jsx 命令：call 先取 getRemoteControlServerInfo，缺失时才 await start，再把 session_url 交给 onDone；启动异常被格式化为 Failed to start 文本。命令 availability 为 claude-ai、isEnabled 恒 true，真正的编译可见性仍由 commands.ts 的 DAEMON+BRIDGE_MODE 门控。特性夹具同步加入 DAEMON 并输出 hasRemoteControlServerCommand，组合测试断言其为 true，工具总数仍固定为 34，说明本提交新增的是命令与 daemon 生命周期而非新工具。',
  ],
  decisions: [
    '将 supervisor 与 worker 分为两个进程层级，磁盘只记录 supervisor PID；worker 可由 --daemon-worker 重新创建而不让 start/status 的记录随重启变化。',
    '重启采用显式 maxRestarts 与指数等待，而不是无限紧循环；默认最多重启五次，主动 stop 和 code=0 均退出循环，错误在额度耗尽后向上可见。',
    'assistant 与 remote-control 共用 Remote Control server 启动/等待函数，避免 worker 类型各自解释 SDK 建连和 teardown。',
    'server 使用模块级单例并在 enable 成功后才发布 running；已发布实例的重复 start 返回原 info，stop 则在异步 teardown 前先撤销全局可见性。',
    'pending input 只承担维持流式 query 与可关闭输入的职责，远控消息仍由既有 SDK remoteController 的输入输出任务处理，本层不伪造用户消息或 Cloud 响应。',
    '通过构建 feature 列表启用既有 CLI/command 路由，不修改 cli.tsx 和 commands.ts；独立特性构建使用相同 DAEMON 标志验证真实打包后的注册结果。',
  ],
  alternatives: [
    '回溯性比较：另建 daemon 专用 Remote Control 传输会复制既有权限、消息和控制处理；实际实现调用 query.enableRemoteControl，并保留 sdkQuery/sdkRemoteControl 作为唯一协议路径。',
    '回溯性比较：无限重启或固定短间隔会分别造成失控进程循环和故障时频繁 spawn；实际选择默认五次、1 秒起倍增且可封顶的退避，并把次数与活动 PID 暴露在状态中。',
    '回溯性比较：每次 /remote-control-server 都创建 query 会产生多个输入流和远控控制器；实际以 RunningServer 单例复用 info/query，并由同一实例完成 stop 与 cleanup。',
    '回溯性比较：把 worker PID 写入 status 记录会在每次重启后改变身份；实际记录 detached supervisor PID，worker PID 仅由 DaemonSupervisor.getState 提供。',
  ],
  security: [
    'PID 文件名对 kind 做字符白名单式替换，记录目录使用 0700、记录文件使用 0600；JSON 仅包含 pid、kind、startedAt，不写入继承环境中的凭据。',
    'detached supervisor 和 worker 都继承 process.env，这保持既有 CLI 配置可用，但也意味着调用者环境会进入后台进程；本提交没有增加环境过滤或凭据隔离。',
    'kill(pid,0) 与 SIGTERM 只依据记录中的数字 PID，没有校验进程可执行文件或 startedAt 身份；PID 被复用时可能误报或误发信号，不能将该记录视为强所有权证明。',
    '/remote-control-server 声明 claude-ai availability，并受 DAEMON+BRIDGE_MODE 编译门控；真实 query 路径仍要求组织 UUID、OAuth token 和 remoteControlFactory 成功，离线 mock 不替代这些检查。',
    '启动 enable 失败会尝试关闭 input 和 query，正常停止会先 disable 再关闭 input/query；停止异常只保证 done finish，不保证后续所有资源步骤都已执行。',
  ],
  acceptance: [
    'start 对存活 supervisor 记录幂等返回，新启动写正整数 PID 记录；status 清理不可存活 PID 的陈旧文件，stop 删除记录并向存活 supervisor 发 SIGTERM。',
    'worker 非零退出或 error 按配置退避重启，达到 maxRestarts 后抛出错误；code=0 正常结束，stop 终止活动 worker 且不触发重启。',
    'runForeground 将 SIGINT/SIGTERM 链接到 supervisor.stop，并将 run 的最终码赋给 process.exitCode；worker 使用 --daemon-worker 进入 registry。',
    'assistant 与 remote-control 均启动并等待 Remote Control server，undefined 和未知 kind 返回明确错误。',
    '顺序重复 start 只创建一个 query 并返回同一 info；正常 stop 依次发送 enable true/false、关闭输入和 return query，清理 running 并释放 waitForRemoteControlServer。',
    '/remote-control-server 展示已有或新启动服务的 session_url，外部 DAEMON+BRIDGE_MODE 特性构建包含该命令且工具池仍为 34 个非空工具。',
    'STATUS 的 Verified 仅指 offline lifecycle/build 范围；91/390、typecheck、build/declarations、daemon status 和特性档是提交内记录，fakes 不得解释为 live Cloud 通过。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'DaemonSupervisor 明确实现 active/stopping/running/restarts、error/exit 收口、默认五次重启、1 秒起指数退避、30 秒封顶以及 stop 对活动 worker 的 SIGTERM。',
      source: {
        path: 'src/daemon/supervisor.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'export class DaemonSupervisor',
        note: '监督状态机和有界重启语义的直接实现证据。',
      },
    },
    {
      kind: 'diff-observed',
      statement: 'Remote Control server 复用单一 running query；启动失败关闭 input/query，正常停止执行 enableRemoteControl(false)、closeInput、query.return，并在 finally 释放 done。',
      source: {
        path: 'src/commands/remoteControlServer/server.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'export async function stopRemoteControlServer',
        note: '共享 query 与 teardown 顺序的直接实现证据。',
      },
    },
    {
      kind: 'test-added',
      statement: '新增六个离线测试，覆盖重复 start 的 createQuery 一次、enable true/false、query.return、wait 完成、worker 分发、一次重启延迟、maxRestarts、stop 不重启及 stale PID 文件删除；query、worker 和 wait 均为 fake/mock。',
      source: {
        path: 'tests/daemon.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: "describe('Remote Control server lifecycle'",
        note: '新增 daemon/server 生命周期回归；此项只声明测试及替身范围。',
      },
    },
    {
      kind: 'test-added',
      statement: '独立特性夹具启用 DAEMON 并报告 remote-control-server 注册，组合测试要求 hasRemoteControlServerCommand=true，同时继续断言 34 个工具且无 null。',
      source: {
        path: 'tests/enabledFeatures.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: 'hasRemoteControlServerCommand',
        note: '新增的真实 Bun 特性构建注册断言，不是 Cloud 会话测试。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: 'at-commit STATUS 记录 bun test 已通过 91 tests、390 assertions；这是该提交保存的历史全量结果，不是本次文档编写重新执行的结果。',
      source: {
        path: 'docs/STATUS.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '`bun test`',
        note: 'Verified evidence 表中的精确历史测试计数。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: 'at-commit STATUS 记录 bun run typecheck 零 TypeScript 错误，bun run build 已构建 CLI、SDK 和 declarations。',
      source: {
        path: 'docs/STATUS.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '`bun run typecheck`',
        note: '同一历史 Verified evidence 表还列出 build 与 declarations 结果。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: 'at-commit RELEASE 记录 daemon status 和 34-tool compiled feature profile 通过，并再次列出 91/390、typecheck、build、declarations；生命周期测试使用 fakes。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '## Daemon and Remote Control server lifecycle',
        note: '本提交专属发布段的执行结果和 fake 限定。',
      },
    },
    {
      kind: 'not-recorded',
      statement: '没有 live Cloud session 证据；STATUS/RELEASE 均明确不作此声明，测试中的 example.invalid、env-test 和 createQuery mock 不能证明真实建连。',
    },
    {
      kind: 'not-recorded',
      statement: '新增回归没有执行真实 detached start/stop、worker spawn 或 SIGINT/SIGTERM 进程往返；历史执行记录只明确列出 daemon status smoke，监督停止与重启由 FakeWorker 验证。',
    },
  ],
  remaining: [
    '真实 Cloud/OAuth Remote Control 会话、远端消息与权限往返仍未验证；STATUS 继续把 real Cloud API and remote bridge round trips 留在授权环境后续步骤。',
    'PID 记录没有启动身份或进程名核验，且并发 startDaemon 没有文件锁/原子占用；PID 复用与并发启动都不是当前测试覆盖的强一致场景。',
    'supervisor 在退避 wait 期间收到 stop 不会唤醒计时器，循环等待后仍可能先 spawn 下一个 worker；当前 stop 只对调用时的 active 发信号。',
    'server 在 enable await 尚未完成时还没有设置 running，并发 start 可创建多个 query；正常顺序启动的幂等测试不覆盖这一竞态。',
    'stop 中 disable 抛错会跳过 closeInput 和 query.return，只有 running 清除、cleanup 注销和 done finish 得到保证。',
  ],
  references: [
    {
      path: 'docs/RELEASE.md',
      role: 'changed',
      symbol: '## Daemon and Remote Control server lifecycle',
      note: '记录 supervisor、worker SDK 分发、共享 query teardown 及 91/390 等历史结果，并明确 fakes 与无 live Cloud。',
    },
    {
      path: 'docs/STATUS.md',
      role: 'changed',
      symbol: 'Daemon supervisor and worker registry',
      note: '把能力范围标为 offline lifecycle/build，更新 91/390 并从下一实现顺序移除 daemon。',
    },
    {
      path: 'scripts/build.ts',
      role: 'changed',
      symbol: "'DAEMON'",
      note: '在外部 CLI 与 SDK 构建 feature 列表启用 DAEMON，接通既有入口和新增实现。',
    },
    {
      path: 'src/commands/remoteControlServer/index.ts',
      role: 'changed',
      symbol: 'async function call',
      note: '实现 claude-ai local-jsx 命令，复用已有 server info、按需启动并报告 session_url 或错误。',
    },
    {
      path: 'src/commands/remoteControlServer/server.ts',
      role: 'changed',
      symbol: 'startRemoteControlServer',
      note: '实现 pending input、共享 SDK query、模块级 server 状态、启动失败清理、等待和正常 teardown。',
    },
    {
      path: 'src/daemon/main.ts',
      role: 'changed',
      symbol: 'startDaemon',
      note: '实现 supervisor PID 记录、detached spawn、start/run/stop/status、陈旧清理及前台信号连接。',
    },
    {
      path: 'src/daemon/supervisor.ts',
      role: 'changed',
      symbol: 'export class DaemonSupervisor',
      note: '实现 worker 活动状态、退出/error 处理、有界指数重启、可注入等待和主动停止。',
    },
    {
      path: 'src/daemon/workerRegistry.ts',
      role: 'changed',
      symbol: 'runDaemonWorker',
      note: '将 assistant/remote-control 分发到 SDK Remote Control server，并对缺失和未知 kind 报错。',
    },
    {
      path: 'tests/daemon.test.ts',
      role: 'changed',
      symbol: "describe('DaemonSupervisor'",
      note: '以 mock query、FakeWorker 和临时 PID 目录覆盖 server、registry、重启、停止和陈旧记录。',
    },
    {
      path: 'tests/enabledFeatures.test.ts',
      role: 'changed',
      symbol: 'hasRemoteControlServerCommand',
      note: '断言独立编译特性档注册 remote-control-server，保持既有 34 工具约束。',
    },
    {
      path: 'tests/fixtures/verify-enabled-features.ts',
      role: 'changed',
      symbol: 'hasRemoteControlServerCommand',
      note: '在干净 Bun 构建中启用 DAEMON，并把命令注册结果写入 FEATURE_PROFILE。',
    },
    {
      path: 'src/entrypoints/cli.tsx',
      role: 'reused',
      symbol: "args[0] === '--daemon-worker'",
      note: '复用父提交已有 DAEMON worker 快速路径和 daemon 主命令分派，本提交未修改该文件。',
    },
    {
      path: 'src/commands.ts',
      role: 'reused',
      symbol: 'remoteControlServerCommand',
      note: '复用已有 DAEMON+BRIDGE_MODE 条件加载和 COMMANDS 注册位置。',
    },
    {
      path: 'src/entrypoints/agentSdkTypes.ts',
      role: 'reused',
      symbol: 'export function query',
      note: '复用既有 SDK query 工厂，把 pending AsyncIterable 转为 InternalQuery。',
    },
    {
      path: 'src/entrypoints/sdk/runtimeTypes.ts',
      role: 'reused',
      symbol: 'enableRemoteControl(enabled: boolean)',
      note: '复用 InternalQuery 已定义的 enable/disable 契约和三项 session 信息。',
    },
    {
      path: 'src/utils/sdkQuery.ts',
      role: 'reused',
      symbol: 'enableRemoteControl: async',
      note: '复用 query 内 remoteController 的创建、重复 enable 信息返回和 disable stop。',
    },
    {
      path: 'src/utils/sdkRemoteControl.ts',
      role: 'reused',
      symbol: 'startSdkRemoteControl',
      note: '底层继续使用既有 SDK 消息、控制、权限和 controller.stop 生命周期。',
    },
    {
      path: 'src/utils/cleanupRegistry.ts',
      role: 'reused',
      symbol: 'registerCleanup',
      note: '把 server stop 注册进现有优雅退出清理集合，并取得注销函数。',
    },
    {
      path: 'src/utils/envUtils.ts',
      role: 'reused',
      symbol: 'getClaudeConfigHomeDir',
      note: '复用配置目录定位，将 supervisor JSON 记录置于其 daemon 子目录。',
    },
    {
      path: 'src/utils/sleep.ts',
      role: 'reused',
      symbol: 'export function sleep',
      note: '作为生产 supervisor 的默认退避等待，测试则注入 wait 记录延迟。',
    },
  ],
  plan: {
    preconditions: [
      '确认父提交 daemonMain/runDaemonWorker 为 unavailable stub，而 cli.tsx 的 daemon 与 --daemon-worker 路由、commands.ts 的双 feature 命令注册已经存在。',
      '确认父提交 agentSdkTypes.query 返回 InternalQuery，enableRemoteControl(true/false) 与 query.return 足以承载远控启停，不需要新增传输契约。',
      '确认 cleanupRegistry、getClaudeConfigHomeDir、sleep 和本地命令类型可复用，DAEMON 尚未进入外部 build 与特性夹具。',
      '将离线 fake 生命周期验证与真实 Cloud、真实进程信号验证分开，历史结果只能引用 at-commit STATUS/RELEASE。',
    ],
    reuse: [
      '复用 cli.tsx 的 DAEMON 快速入口与 commands.ts 的 DAEMON+BRIDGE_MODE 注册，不为 daemon 或命令增加第二条路由。',
      '复用 query、InternalQuery.enableRemoteControl、sdkQuery remoteController 和 sdkRemoteControl，保持 SDK 远控消息与权限路径。',
      '复用 registerCleanup/runCleanupFunctions，将 RunningServer 停止纳入现有退出清理。',
      '复用 getClaudeConfigHomeDir 和现有文件系统 Promise API，集中 supervisor 记录路径、目录权限和文件权限。',
      '复用 sleep 作为退避实现，同时通过 SupervisorOptions.spawn/wait 与 worker dependencies.start/wait 保留离线可控测试接缝。',
      '复用现有 local-jsx/onDone、Bun feature 构建和 FEATURE_PROFILE 特性档，不添加新的命令框架或测试输出协议。',
    ],
    steps: [
      {
        title: '先实现共享 Remote Control server 生命周期',
        detail:
          '在 server.ts 定义三项 ServerInfo 与最小 ServerQuery 接口，先写可关闭的 pendingInput，再实现 start 的单例检查、query 创建、enable(true)、失败清理和 RunningServer 发布。随后加入 getInfo、done/wait、cleanup 注册及 stop 的 running 撤销、enable(false)、input close、query.return 和 finally finish，使 worker 与交互命令能共享同一生命周期。',
        paths: ['src/commands/remoteControlServer/server.ts'],
      },
      {
        title: '接入交互命令外观',
        detail:
          '在 index.ts 以 local-jsx 命令包装 server API：优先显示已有 info，否则启动后显示 session_url，异常经 onDone 返回失败文本；声明 claude-ai availability 和恒定 isEnabled，把编译门控继续留给既有 commands.ts。',
        paths: ['src/commands/remoteControlServer/index.ts'],
      },
      {
        title: '建立有界 supervisor 状态机',
        detail:
          '在 supervisor.ts 定义最小 worker process 接口和可注入 spawn/wait 参数，实现 run 的重复调用保护、活动子进程事件等待、正常/主动停止、非零退出与 error 的重启上限及指数延迟。补上 getState、stop(SIGTERM) 和 finally 状态清理，让 main 只负责进程适配而不复制重启逻辑。',
        paths: ['src/daemon/supervisor.ts'],
      },
      {
        title: '实现 PID 记录和 daemon 子命令',
        detail:
          '在 main.ts 先实现 kind 文件名清理、记录读写、kill(pid,0) 与 stale cleanup，再实现 detached supervisor start、0600/0700 记录及写失败终止，随后实现 status/stop。最后以 --daemon-worker spawn 适配 DaemonSupervisor，连接 SIGINT/SIGTERM，并按 start/run/stop/status 分派输出和退出码。',
        paths: ['src/daemon/main.ts'],
      },
      {
        title: '把 worker registry 接到 server',
        detail:
          '在 workerRegistry.ts 用 switch 取代 unavailable stub，让 assistant 和 remote-control 顺序执行 start/wait；保留可注入依赖供离线测试，undefined 与未知 kind 分别给出确定错误。此步骤复用第一步的 server，不产生另一套 Remote Control 协议。',
        paths: ['src/daemon/workerRegistry.ts'],
      },
      {
        title: '启用构建并增加编译特性断言',
        detail:
          '在 build.ts 的共享 builds 循环 feature 列表加入 DAEMON，使 CLI 和 SDK 使用同一启用集合；在独立特性夹具加入相同标志并输出 hasRemoteControlServerCommand，在组合测试断言命令存在且工具总数仍为 34、nullCount 为 0。',
        paths: [
          'scripts/build.ts',
          'tests/fixtures/verify-enabled-features.ts',
          'tests/enabledFeatures.test.ts',
        ],
      },
      {
        title: '补齐可控离线生命周期回归',
        detail:
          '在 daemon.test.ts 用 mock ServerQuery 验证顺序重复 start、enable true/false、return 和 wait，用注入 start/wait 验证 registry，用 EventEmitter FakeWorker 验证退避、上限和 stop，再在临时目录写死 PID 记录验证 status 删除文件；afterEach 调 stop 清理模块单例。测试不把这些替身结果描述为 Cloud 或真实进程证据。',
        paths: ['tests/daemon.test.ts'],
      },
      {
        title: '记录实际范围和执行结果',
        detail:
          '最后更新 STATUS 的全量计数与两个 offline lifecycle/build 能力行，并从后续实现列表移除 daemon；在 RELEASE 增加本组件段，准确记录 91 tests、390 assertions、typecheck、build/declarations、daemon status 和 34-tool profile，同时保留 lifecycle fakes、no live Cloud session 的限定。',
        paths: ['docs/STATUS.md', 'docs/RELEASE.md'],
      },
    ],
    compatibility: [
      '保持既有 daemon [start|run|stop|status] [assistant|remote-control] 参数形态和 --daemon-worker 内部入口，原 stub 位置变为实现。',
      '保持 InternalQuery.enableRemoteControl 和 RemoteControlServerInfo 的 session_url/connect_url/environment_id 数据形状，不要求 SDK 调用方迁移。',
      'remote-control-server 只在 DAEMON 与 BRIDGE_MODE 同时编译开启时注册，availability 继续限制为 claude-ai。',
      'DAEMON 加入 CLI/SDK 构建没有改变工具集合，特性档继续固定 34 个非空工具。',
      '重复 start 返回已有 info、无运行实例时 stop/wait 安全返回，使命令、worker 和 cleanup 可共享同一模块 API。',
    ],
    risks: [
      'PID 复用或两个 start 并发写同一 JSON 可能造成误杀、误报或多个 supervisor；当前实现只有 kill(pid,0) 和普通 writeFile，没有身份验证或锁。',
      '退避期间 stop 没有取消 wait，等待结束后循环仍可能创建 worker；测试只覆盖活动 worker 存在时的 stop。',
      'start 在 enable await 期间尚未发布 running，并发调用可能各自创建 query；当前幂等断言是顺序 await 后再 start。',
      'teardown 的 disable 失败会阻断 closeInput/query.return，虽然 finish 会执行，资源关闭并不完整；启动失败清理也可能受首个清理异常影响。',
      'fake query/FakeWorker 只能证明调用顺序和状态转换，不能覆盖 OAuth、Cloud 网络、真实 detached 进程、OS 信号或 SDK 远端权限行为。',
    ],
    verification: [
      '运行 daemon/server 定向测试，核对 createQuery 仅一次、enable 调用序列 true/false、query.return、info 清除和 wait 释放。',
      '用可控 worker 分别触发 code=1、code=0、连续失败和主动 stop，核对注入延迟、重启计数、上限异常及 running/active 清理。',
      '在临时 registryDir 写入不存在进程的 PID，执行 getDaemonStatus 并确认 running=false 与记录文件删除。',
      '执行独立 verify-enabled-features 构建，读取 FEATURE_PROFILE，核对 remote-control-server=true、toolCount=34、nullCount=0。',
      '依据 at-commit STATUS 引用 bun test 的 91 tests/390 assertions、typecheck 零错误和 build CLI/SDK/declarations；依据 RELEASE 引用 daemon status 与 34-tool profile。',
      '真实 daemon start/run/stop、worker 重启和 SIGINT/SIGTERM 应在隔离进程环境另做端到端验证，不能从 FakeWorker 结果补写为已通过。',
      '真实 Cloud Remote Control 建连、消息和权限往返只在授权环境验证，并单独记录来源；本提交明确没有该结果。',
    ],
    completed: [
      'daemonMain 的四个子命令、supervisor PID 记录、detached spawn 和 stale cleanup 已实现。',
      'DaemonSupervisor 的活动状态、有界指数重启、正常退出和 SIGTERM 停止已实现，runForeground 已连接 SIGINT/SIGTERM。',
      'assistant/remote-control worker 已统一分发到 SDK Remote Control server，未知类型会报错。',
      '共享 query、pending input、启动失败清理、cleanup 注册、等待与正常 stop teardown 已实现。',
      '/remote-control-server 已实现并通过 DAEMON+BRIDGE_MODE 既有注册点进入外部构建。',
      '六个离线 daemon/server 测试和独立特性档命令断言已加入，工具池约束保持 34。',
      'STATUS/RELEASE 已记录 91/390、typecheck、build/declarations、daemon status 和特性档结果及其离线边界。',
    ],
    incomplete: [
      'live Cloud session、真实远端消息/权限以及 OAuth/组织环境交互未验证。',
      '真实 detached start/stop、worker spawn 和 OS 信号往返未由新增测试执行。',
      'PID 复用、并发 daemon start、enable 阶段并发 server start 仍缺少互斥与回归覆盖。',
      '退避期间停止不能唤醒 wait，disable 异常也可能跳过 input/query 的后续关闭步骤。',
      'RemoteControlServerInfo 只在进程内保存，重启后不能从 supervisor PID 文件恢复旧 query 或 session_url。',
    ],
  },
})
