import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'a8c8b90fd2e7b5fa14ebb2bc6beff3f5c2904346',
  title: 'Add lifecycle regressions and race fixes',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交的 STATUS 仍把 changed-file offset/limit、cron recurring/aging 和 LSP restart/shutdown 列为验证缺口。changed-files 虽已在 getChangedFiles 中按缓存范围重读，但没有真实文件系统回归；cron 文件任务删除后依赖 chokidar reload 才清除内存项，磁盘已删而 watcher 未到的窗口可能再次触发；LSPClient 在崩溃后的 restart 中仍尝试向已关闭连接发送 shutdown，maxRestarts 超限路径也可能留下 stopped 状态或旧错误，而不是可观察的 error 终态。',
  problem:
    '需要以真实文件、真实调度器/锁和真实 stdio JSON-RPC 子进程固定这些生命周期语义，而不是只检查配置字段。修复必须落在正确竞态点：one-shot 删除成功后立即驱逐内存任务，连接关闭后跳过无响应的 shutdown 握手但仍完整清理，所有重启上限路径统一写入 error/lastError。提交内的 151/643 是文档记录的本地命令结果，不能自动等同于目标 SHA 的远端 CI 全绿；后续修复树的全绿也只能作为带完整 SHA 的 later evidence。',
  goals: [
    '用真实临时文件验证 offset/limit 范围内重读、范围外变化抑制、全读兼容和 ENOENT 缓存驱逐。',
    '为 cron 注入时间源，验证 one-shot 单次触发与删除、recurring 重排/老化及项目锁接管。',
    '在磁盘删除 Promise 成功后同步清除内存任务，关闭 watcher reload 前的重复触发窗口。',
    '跟踪 LSP 连接关闭状态，崩溃后跳过 shutdown/exit 握手并无条件释放连接、监听器和进程。',
    '让 maxRestarts 的两条超限路径都设置 error 与准确的 lastError，并以真实 JSON-RPC fixture 验证生命周期。',
    '区分测试新增、提交内命令记录和后续 CI 证据，不把不同 revision 的结果混写。',
  ],
  nonGoals: [
    '不修改 changed-files 的生产读取算法；本提交以真实文件回归证明既有 offset/limit 语义。',
    '不覆盖图片、PDF、notebook、临时 stat 错误或完整模型附件消费链，新增范围测试聚焦文本文件。',
    '不实现真实第三方 language server、socket transport 或所有异常帧场景的兼容测试。',
    '不把 maxRestarts=0 的一次崩溃测试描述为多轮连续成功重启后超限。',
    '不把 at-commit 文档中的本地 151/643 或后续 e31ff8f 的绿色 CI 反向标记为目标 SHA 的 GitHub CI 全绿。',
  ],
  architecture: [
    'changed-files 继续由 FileReadTool 将 content、timestamp、offset、limit 写入 readFileState，getChangedFiles 在 mtime 更新后按原范围重建 FileReadTool 输入，经 isFileReadDenied 与 validateInput 的 deny/path 校验后直接调用 FileReadTool.call，再用旧/新局部内容生成 edited_text_file snippet；它不经过 checkPermissions 的完整权限协商。测试在真实临时目录写文件并以 utimes 推进 mtime：范围内修改只返回局部片段，重读后再次查询为空，范围外变化不报告；全读仍工作，删除文件只在 ENOENT 时驱逐缓存。',
    'cronScheduler.ts 新增可选 now 函数，默认 Date.now，load 的 missed 判定与 check 的 tick 统一使用 nowFn，使测试可以精确推进六十秒而不改系统时钟。recurring 任务从当前时间计算下一触发并批量持久化 lastFiredAt；isRecurringTaskAged 保持 maxAgeMs=0 和 permanent 永不老化。文件任务仍只由项目锁 owner 执行，显式 dir 路径不读取 bootstrap session 状态。',
    '文件型 one-shot 或 aged recurring 触发时先进入 inFlight，再异步 removeCronTasks。关键修复是在删除 Promise 成功后立即执行 tasks=tasks.filter(...)，随后 finally 才移除 inFlight；这样即使 chokidar 尚未 reload，旧内存项也不能再次触发。nextFireAt 同步删除，getNextFireTime 不再被已完成任务占据。该修复针对实际提交点，而不是单纯延长等待来掩盖竞态。',
    'LSPClient 在闭包中增加 connectionClosed，每次 start 前置 false，子进程 exit 与 JSON-RPC onClose 都置 true。stop 只在 connection 存在且尚未关闭时发送 shutdown request 和 exit notification，崩溃后的 restart 不再等待永远无法响应的对端。无论握手跳过还是失败，finally 都清 timer、dispose connection、移除 process/stdin/stderr listeners、kill 并清空 process，同时复位 initialized/capabilities/isStopping。',
    'LSPServerInstance 的 crash callback 将 state 置 error、记录 lastError、增加 crashRecoveryCount，并按 restartOnCrash 调 restart。restart 在 stop 后累计 restartCount，超过 maxRestarts 时现在同时写 lastError 和 state=error；start 的 crash-recovery 超限保护也明确 error。成功 start 会清 crashRecoveryCount，但累计 restartCount 不被隐式重置，健康状态仍要求 running 且 client.isInitialized。',
    'fake-lsp-server.ts 是实际 Bun 子进程，通过 stdin 缓冲和 Content-Length 帧解析支持 initialize、x-echo、x-crash、shutdown。x-crash 以退出码 1 模拟异常，shutdown 先响应再按环境变量延迟退出。lspLifecycle.test.ts 因而经过真正的 vscode-jsonrpc 编解码和进程生命周期，覆盖 echo、一次崩溃重启、零重启上限及延迟退出时 stop 快速返回和 stopped 状态，而不是 mock sendRequest 的表面状态；该 shutdown 用例没有直接观察 connection/listener dispose 或子进程退出。',
    '证据分为三层：测试源码说明覆盖被加入，at-commit STATUS/RELEASE 记录 151 tests/643 assertions、typecheck、build/declarations 和 42-tool profile，后续 271cf757 的 RELEASE 才记录 e31ff8f 的 CI 42861258902 通过。三者不能互相替代，尤其后续树包含额外 cron/测试隔离修正和其他功能变化。',
  ],
  decisions: [
    'changed-files 用生产 FileReadTool 与真实文件做回归，而不是重新实现 diff 逻辑，确保测试证明的是实际附件路径。',
    'cron 只注入时间源，不注入整个调度器 fake；文件、watcher、锁和持久化仍参与测试。',
    '内存驱逐放在 removeCronTasks 成功之后、inFlight 清理之前，使磁盘与内存在同一删除完成点对齐。',
    'LSP 以连接是否已关闭决定能否握手，而不是给崩溃 shutdown 再增加盲等超时；清理始终执行。',
    'maxRestarts 超限统一 error/lastError，避免 stopped 外表掩盖永久失败并误导后续健康检查。',
    '历史验证按 revision 分层引用，后续绿色 CI 不用于粉饰目标提交原树的时序问题。',
  ],
  alternatives: [
    '回溯性比较：可以仅断言 FileReadTool 收到 offset/limit，但无法证明片段和缓存行为；实际用真实文件验证范围内外变化和 ENOENT。',
    '回溯性比较：可以完全 mock cron 文件与锁以获得快速测试，但会漏掉删除/watch/接管竞态；实际保留真实调度基础设施并只控制时间。',
    '回溯性比较：可以让 LSP stop 无论状态都发送 shutdown，协议表面统一却会在崩溃后悬挂；实际先检查连接关闭，再选择握手或直接清理。',
    '回溯性比较：可以把所有验证结果写成同一组 passed，但会隐藏逐提交 CI 差异；实际将 at-commit 本地记录和后续完整 SHA 的 CI 分开。',
  ],
  security: [
    'changed-file 自动重读经过 isFileReadDenied 和 FileReadTool.validateInput 的 deny/path 校验后直接调用 FileReadTool.call；不会执行 FileReadTool.checkPermissions，新增测试也未覆盖完整权限协商流程。',
    '只有 ENOENT 会驱逐读取缓存，EACCES 等非 ENOENT 临时错误会保留既有状态；原子保存间隙若表现为 ENOENT，仍会触发驱逐。',
    'cron 文件任务仍受项目锁约束，session-only 任务与显式 dir 的 daemon/test 路径分离，避免共享目录重复执行。',
    'LSP 使用 spawn(command,args) 而非 shell，shutdown 后移除监听器并 kill 子进程，降低悬挂进程和迟到回调风险。',
    'LSP 环境由 subprocessEnv 与 config.env 合并，后者可以覆盖前者，不能把该实现描述为不可重新注入敏感变量的沙箱。',
    '所有验证证据按提交和后续 revision 标注，防止以错误的执行状态驱动发布判断。',
  ],
  acceptance: [
    '局部读取后，范围内修改产生含新内容且不含范围外文本的 edited_text_file，重读后无变化查询为空。',
    '范围外修改不产生附件，全读修改仍能报告，文件删除后返回空且 readFileState 对应项被移除。',
    'one-shot 推进到触发时间后只执行一次，磁盘记录和 nextFireAt 均清除；recurring 写 lastFiredAt 并保留下一触发时间。',
    'maxAgeMs=0 与 permanent 永不老化，普通 recurring 可按年龄过期；owner stop 后另一 scheduler 能按锁协议接管。',
    'LSP initialize/x-echo 正常，异常退出可重启一次，maxRestarts=0 时首次超限进入 error 并记录明确错误。',
    '连接已关闭时 stop 不发送 shutdown，所有路径都释放连接、监听器和进程；延迟退出不会拖住 stop 状态清理。',
    'at-commit 文档记录 151/643 与构建结果，后续 e31ff8f 的 CI 通过仅作为 271cf757 提供的 later evidence。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '该 revision 在 removeCronTasks 成功后立即从内存 tasks 过滤已删除 ID，并在 finally 才解除 inFlight，直接关闭磁盘删除与 watcher reload 的竞态窗口。',
      source: {
        path: 'src/utils/cronScheduler.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'tasks = tasks.filter(task => task.id !== t.id)',
        note: 'cron 删除提交点的直接实现证据。',
      },
    },
    {
      kind: 'diff-observed',
      statement: 'LSPClient 以 connectionClosed 跟踪 exit/onClose，只在连接未关闭时发送 shutdown/exit，并在 finally 中完成连接与进程清理。',
      source: {
        path: 'src/services/lsp/LSPClient.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'connection && !connectionClosed',
        note: '崩溃后跳过无效握手和资源回收的实现证据。',
      },
    },
    {
      kind: 'test-added',
      statement: '新增两个真实文件系统测试，覆盖局部范围重读、范围外变化、全读兼容和 ENOENT 驱逐；此项只声明测试随提交加入。',
      source: {
        path: 'tests/changedFiles.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: "describe('changed-file offset/limit reads'",
        note: 'changed-files 的真实临时文件回归。',
      },
    },
    {
      kind: 'test-added',
      statement: '新增三个 cron 生命周期测试，使用真实 scheduled_tasks.json、调度器与项目锁覆盖 one-shot、recurring/aging 和 owner stop 后接管。',
      source: {
        path: 'tests/cronLifecycle.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: "describe('cron scheduler lifecycle'",
        note: 'cron 文件、时间和锁生命周期回归。',
      },
    },
    {
      kind: 'test-added',
      statement: '新增真实 stdio JSON-RPC fake server 与四个 LSP 测试，覆盖 initialize/echo、一次 crash restart、maxRestarts=0，以及延迟 shutdown 时 stop 快速返回和 stopped 状态；未直接观察 connection/listener dispose 或子进程退出。',
      source: {
        path: 'tests/lspLifecycle.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: "describe('LSP process lifecycle'",
        note: '真实子进程协议生命周期回归，不是第三方语言服务器在线测试。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: '提交内 STATUS 记录 bun test 已通过 151 个测试、643 个断言；这是 at-commit 文档中的命令记录，不是目标 SHA 的 GitHub CI 结果或本次复跑。',
      source: {
        path: 'docs/STATUS.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '`bun test`',
        note: 'at-commit Verified evidence 表的本地全量测试记录。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: '提交内 STATUS 记录 bun run typecheck 零错误，bun run build 完成 CLI、SDK 与声明构建。',
      source: {
        path: 'docs/STATUS.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '`bun run typecheck`',
        note: 'at-commit 类型检查和构建命令结果。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: '提交内 RELEASE 的 Lifecycle regressions 段记录 151/643、typecheck、build、declarations 和 42-tool profile 通过。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '## Lifecycle regressions',
        note: '生命周期发布段的本地验证声明。',
      },
    },
    {
      kind: 'later-evidence',
      statement: '后续 271cf757a24eb6cd7e46586fa18995759be32043 的 RELEASE 记录：包含后续 cron/测试隔离修正的 e31ff8ffe39417856b209be89190ef9cc429e6b9 才取得 CI run 42861258902 全绿；该结果不能反向写成目标 SHA 的 CI 全绿。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: '271cf757a24eb6cd7e46586fa18995759be32043',
        symbol: '42861258902',
        note: '目标后代文档记录的后续 CI 结果，271cf757 与 e31ff8f 均为目标完整 SHA 的后代。',
      },
    },
    {
      kind: 'not-recorded',
      statement: '目标提交自己的 STATUS/RELEASE 没有记录其 GitHub Actions run 或失败/通过状态，因此本地 151/643 记录不得被解释为目标 SHA 的远端 CI 全绿。',
    },
  ],
  remaining: [
    '目标提交原树的 cron lock 接管和测试隔离仍有时序风险，后续 e31ff8f 的 stop/reset 与测试调整及其绿色 CI 是独立后续工作。',
    'cron 删除竞态测试没有显式暂停 watcher 来确定性复现窗口，aging 也只直接验证纯函数，没有覆盖最后一次触发后删除全链路。',
    'LSP maxRestarts 用例只验证 maxRestarts=0 的一次崩溃；shutdown 用例只断言 stop 在 500ms 内返回且 state=stopped，未直接验证 connection dispose、process/stdin/stderr listener 移除或子进程退出，也未单独证明 25ms timer 是唯一 killer。',
    '真实第三方 language server、signal 退出、socket transport、startup timeout 和异常 JSON-RPC 帧仍未覆盖。',
    'changed-files 未覆盖非文本格式、deny rule、临时 stat 错误和端到端模型附件流程。',
  ],
  references: [
    {
      path: 'docs/RELEASE.md',
      role: 'changed',
      symbol: '## Lifecycle regressions',
      note: '记录 changed-files、cron、LSP 的修复范围和 151/643 本地验证声明。',
    },
    {
      path: 'docs/STATUS.md',
      role: 'changed',
      symbol: 'Changed-file partial reads',
      note: '把三项生命周期能力标为 Verified，更新测试总数并保留其他授权环境边界。',
    },
    {
      path: 'src/services/lsp/LSPClient.ts',
      role: 'changed',
      symbol: 'connectionClosed',
      note: '跟踪进程/连接关闭，崩溃后跳过握手并保证连接、监听器和进程清理。',
    },
    {
      path: 'src/services/lsp/LSPServerInstance.ts',
      role: 'changed',
      symbol: 'createLSPServerInstance',
      note: '在两类重启上限路径统一写入 error 和 lastError。',
    },
    {
      path: 'src/utils/cronScheduler.ts',
      role: 'changed',
      symbol: 'const nowFn',
      note: '注入时间源，并在磁盘删除成功后同步驱逐内存任务以修复重复触发竞态。',
    },
    {
      path: 'tests/changedFiles.test.ts',
      role: 'changed',
      symbol: "describe('changed-file offset/limit reads'",
      note: '以真实文件和 mtime 固定局部重读、范围外变化、全读和删除驱逐。',
    },
    {
      path: 'tests/cronLifecycle.test.ts',
      role: 'changed',
      symbol: "describe('cron scheduler lifecycle'",
      note: '覆盖 one-shot、recurring/aging 与真实项目锁接管。',
    },
    {
      path: 'tests/fixtures/fake-lsp-server.ts',
      role: 'changed',
      symbol: "process.stdin.on('data'",
      note: '提供 Content-Length 帧解析、initialize/echo、异常退出和可延迟 shutdown 的真实子进程。',
    },
    {
      path: 'tests/lspLifecycle.test.ts',
      role: 'changed',
      symbol: "describe('LSP process lifecycle'",
      note: '通过真实 JSON-RPC 子进程验证启动、请求、崩溃重启、上限和停止清理。',
    },
    {
      path: 'src/utils/attachments.ts',
      role: 'reused',
      symbol: 'getChangedFiles',
      note: '复用按缓存 offset/limit 重读、deny/path 校验、直接 FileReadTool.call、snippet 生成和 ENOENT 驱逐逻辑；不经过 checkPermissions。',
    },
    {
      path: 'src/tools/FileReadTool/FileReadTool.ts',
      role: 'reused',
      symbol: 'readFileState.set',
      note: '复用实际文件读取和 content/timestamp/offset/limit 缓存写入。',
    },
    {
      path: 'src/utils/cronTasks.ts',
      role: 'reused',
      symbol: 'removeCronTasks',
      note: '复用任务文件读取、删除和 lastFiredAt 持久化实现。',
    },
    {
      path: 'src/utils/cronTasksLock.ts',
      role: 'reused',
      symbol: 'tryAcquireSchedulerLock',
      note: '复用原子项目锁、PID 存活探测、stale 回收和 owner release 协议。',
    },
  ],
  plan: {
    preconditions: [
      '确认 changed-files 的生产代码已支持 offset/limit，本提交主要缺真实文件回归而非另写算法。',
      '确认 cron 的文件删除、chokidar reload、inFlight 和项目锁可以共同构造真实生命周期场景。',
      '确认 LSPClient/LSPServerInstance 的 stop/restart 分工，修复必须保证已关闭连接不再等待握手。',
      '分别保存 at-commit 本地结果和后续 CI 结果，验证文档不得跨 revision 借用过绿状态。',
    ],
    reuse: [
      '复用 FileReadTool、getChangedFiles 和真实 FileStateCache，不建立平行附件实现。',
      '复用 readCronTasks/removeCronTasks/markCronTasksFired、chokidar 和 cronTasksLock。',
      '复用 vscode-jsonrpc、createMessageConnection 和实际 Bun child_process.spawn。',
      '复用 createCronScheduler/createLSPServerInstance 的公开生命周期接口，避免测试专用状态旁路。',
      '复用 STATUS/RELEASE 的历史证据格式，并用后续完整 SHA 标明 later evidence。',
    ],
    steps: [
      {
        title: '用真实文件固定局部变更读取',
        detail:
          '新增 changedFiles.test.ts，在临时目录通过 FileReadTool 写入实际 readFileState，再修改文件并用 utimes 推进 mtime。依次断言范围内 snippet、重读去重、范围外抑制、全读兼容和 ENOENT 驱逐，直接验证 getChangedFiles 的既有生产路径。',
        paths: ['tests/changedFiles.test.ts'],
      },
      {
        title: '注入 cron 时间并修复删除竞态',
        detail:
          '在 cronScheduler.ts 增加 now 选项并统一 load/check 的时间读取。文件任务触发后保留 inFlight，removeCronTasks 成功时立即过滤内存 tasks 和清理 nextFireAt，finally 再解除 inFlight；recurring 仍按 now 重排并持久化 lastFiredAt。',
        paths: ['src/utils/cronScheduler.ts'],
      },
      {
        title: '覆盖 cron 单次、重排、老化和锁接管',
        detail:
          '新增 cronLifecycle.test.ts，使用真实任务文件和两个调度器。通过注入时间验证 one-shot 只触发一次且删除、recurring 持久化并重排，再直接检查普通老化、maxAgeMs=0 和 permanent；最后停止 owner 并等待另一调度器接管，保留真实锁与 watcher 参与。',
        paths: ['tests/cronLifecycle.test.ts'],
      },
      {
        title: '实现 LSP 关闭感知和重启终态',
        detail:
          '在 LSPClient.ts 跟踪 connectionClosed，start 重置、exit/onClose 置位，stop 仅对活连接发送 shutdown/exit，并在 finally 完成全部资源清理。LSPServerInstance.ts 随后在 restartCount 和 crashRecoveryCount 超限分支统一写 lastError/state=error，避免永久失败看似 stopped。',
        paths: [
          'src/services/lsp/LSPClient.ts',
          'src/services/lsp/LSPServerInstance.ts',
        ],
      },
      {
        title: '以真实 JSON-RPC 子进程验证生命周期',
        detail:
          '先实现 fake-lsp-server.ts 的 Content-Length 缓冲解析及 initialize/x-echo/x-crash/shutdown，再用 lspLifecycle.test.ts 驱动正常 echo、一次崩溃重启、maxRestarts=0 和延迟退出。测试收口调用 stop，验证状态与耗时，同时不把 fake server 外推为第三方 LSP 兼容证明。',
        paths: [
          'tests/fixtures/fake-lsp-server.ts',
          'tests/lspLifecycle.test.ts',
        ],
      },
      {
        title: '记录本地结果并隔离后续 CI 证据',
        detail:
          'STATUS/RELEASE 将三项能力改为 Verified 并记录 151/643、typecheck、build/declarations 和 42-tool profile，但不写入目标 SHA 的虚构 CI 状态。后续 271cf757 的 RELEASE 仅作为 later evidence 记录 e31ff8f 的 CI 42861258902，通过完整 SHA 明确其包含额外修复。',
        paths: [
          'docs/STATUS.md',
          'docs/RELEASE.md',
        ],
      },
    ],
    compatibility: [
      'changed-files 生产 API 和附件结构不变，只增加真实回归；全读路径保持既有行为。',
      'CronSchedulerOptions.now 为可选参数，未提供时继续使用 Date.now，现有 REPL/daemon 调用无需修改。',
      'cron 文件、锁和 lastFiredAt 格式不变，内存驱逐只修正删除后的调度视图。',
      'LSPClient.stop 与 LSPServerInstance 公共接口不变，正常活跃连接仍按 shutdown/exit 协议关闭。',
      'maxRestarts 默认值和计数方式保持，只有超限后的可观察状态和错误信息被补齐。',
    ],
    risks: [
      '若只依赖 watcher 清理，one-shot 会在磁盘删除后再次触发；内存过滤必须与删除 Promise 的成功点绑定。',
      '真实 watcher/锁测试可能受时序影响，目标原树的接管风险不能被后续绿色 CI 隐去。',
      '崩溃连接若仍发送 shutdown 会悬挂 restart，但无条件跳过正常握手又会破坏协议；connectionClosed 区分两类状态。',
      '进程清理若遗漏监听器或 timer 会产生迟到回调和资源泄漏，因此必须放在 finally。',
      '真实 fake LSP 只覆盖所选协议路径，测试名称中的 force-kill 不应被过度解释为 timer 路径已被独立证明。',
      '本地命令记录、测试新增和后续 CI 是不同证据等级，混写会造成错误发布结论。',
    ],
    verification: [
      '运行 changed-files 定向测试，检查范围内 snippet、范围外空结果、再次查询去重和删除缓存驱逐。',
      '推进 cron 注入时间，观察 one-shot 单次触发、磁盘删除、nextFireTime=null，以及 recurring lastFiredAt 和重排。',
      '分别检查普通 recurring 老化、maxAgeMs=0、permanent，并运行两个 scheduler 的锁接管场景。',
      '运行 LSP 定向测试，核对真实 echo、一次 crash 后 restartCount=1、maxRestarts=0 的 error/lastError。',
      '以延迟 shutdown fixture 检查 stop 快速返回和 stopped 状态，并确认 afterEach 再次 stop 不重启。',
      '依据 at-commit STATUS 引用 151/643、typecheck、build/declarations；后续 CI 42861258902 只能按 271cf757 的 later evidence 引用。',
    ],
    completed: [
      'changed-files 的真实 offset/limit、范围外、全读和 ENOENT 回归已经加入。',
      'cron 时间注入、one-shot/recurring/aging/锁测试及删除后内存驱逐修复已经完成。',
      'LSP 关闭感知、崩溃清理和 maxRestarts error/lastError 终态已经实现。',
      '真实 stdio JSON-RPC fake server 与四项生命周期测试已经加入。',
      'at-commit 文档记录 151/643 和构建结果，后续全绿 CI 已按完整后代 SHA 单独标注。',
    ],
    incomplete: [
      '目标提交原树的 cron 接管与测试隔离仍需后续 e31ff8f 等修正才能获得已记录的全绿 CI。',
      'watcher 延迟确定性注入、aged recurring 最终删除全链路和多轮 LSP 崩溃上限尚未覆盖。',
      '第三方语言服务器、非 stdio 传输、非文本 changed-files 和完整模型附件链未在该提交验证。',
    ],
  },
})
