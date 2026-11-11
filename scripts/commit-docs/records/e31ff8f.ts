import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'e31ff8ffe39417856b209be89190ef9cc429e6b9',
  title: 'Reset cron scheduler state on stop and restart',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交已经让 takeover 测试接受任一锁 owner，并允许注入 50 毫秒探测；但 stop 只设置 stopped、清 timers/watcher 并释放锁，没有清 inFlight 或 nextFireAt。对同一 scheduler 再 start 时，旧的触发中去重标记和下一次触发时间可能跨生命周期保留。两个直接 start 分支还以 void enable() 启动异步初始化，没有 rejection 处理。',
  problem:
    '需要让 stop/start 成为干净的调度生命周期：停止时丢弃进程内触发状态，重启重新发起磁盘加载并在空 Map 上重锚，而不是沿用旧 Map/Set。回归通过显式重启非 owner 并再次推进虚拟时间区别于父提交的被动接管，但该序列是否真正构造旧状态、未 await 的读盘顺序以及跨生命周期异步 finally 都需单独限定；异步 enable 失败也应进入 debug 日志而不是形成未处理 rejection。',
  goals: [
    '在 stop 中清空 inFlight 和 nextFireAt，同时保留既有 timer、watcher 和锁清理。',
    '让重启后的 enable 重新发起 load，并在空 nextFireAt 下按当前 tasks 的 lastFiredAt ?? createdAt 重锚；不预设未 await 的读盘一定先于首次 check。',
    '为 dir 路径和已启用 REPL 路径的两个直接 enable 调用补 catch/debug 日志。',
    '把 takeover 回归改为 owner.stop、other.stop、other.start，再推进 current 60 秒并等待 other 触发。',
  ],
  nonGoals: [
    '不改变 lockProbeIntervalMs、owner-neutral 角色选择或锁协议，那些属于父提交的接管确定性修复。',
    '不修改 cron 表达式计算、任务文件格式、1000 毫秒 check、5000 毫秒默认探测或 persisted lastFiredAt 写法。',
    '不把同进程虚拟时间回归描述为真实进程崩溃恢复，也不声称所有异步 enable 入口都新增 rejection 测试。',
  ],
  architecture: [
    'stop 在 stopped=true 后立即执行 inFlight.clear() 和 nextFireAt.clear()，清除停止时已见的旧去重标记与计划，使 getNextFireTime 不再暴露旧值。其余 enablePoll/checkTimer/lockProbeTimer、watcher 和 owner lock 清理顺序保持。旧异步删除或 lastFiredAt 写入的 finally 没有生命周期标识，仍可能在重启后删除新周期同 ID 的 inFlight 标记，因此 clear 不是跨生命周期异步隔离的完整保证。',
    'start 仍调用 enable，enable 以 void load(true) 发起异步读盘但不等待完成，stop 也不清 tasks。nextFireAt 清空后，后续 check 会按当前 tasks 对 recurring 重新以 lastFiredAt ?? createdAt 计算 jitteredNextCronRunMs，对 one-shot 则以 createdAt 计算；磁盘加载完成后再使用新读取的任务数组。实现和测试均未保证首次 check 前已经完成读盘，因此不能表述为加载磁盘任务后才重锚，现有用例也没有直接断言读盘与首次 check 的顺序。',
    '回归沿用实际触发方选择 owner/other：owner.stop 后执行 other.stop/start，再推进 current 并以 10_000 上限等待 otherFired，覆盖非 owner 实例显式重启后重新获锁并触发的路径。但 other 此前未触发，recurring 的 inFlight 为空，非 owner check 原本也会清理 nextFireAt；残留状态位于未重启的 owner。因此该序列没有构造父提交所遗留的旧状态，不能作为 stop 清理 inFlight/nextFireAt 或磁盘重锚的定向回归证据。',
  ],
  decisions: [
    '在 stop 而不是只在 start 清状态，使停止本身就不可查询旧 nextFireTime，并让每个后续 start 都从空调度索引开始。',
    '清 nextFireAt 而不重写 cron 文件；持久化的 lastFiredAt/createdAt 继续决定下一次时间，避免把重启误当作所有任务立即到期。',
    '测试保留真实 timers、锁和文件写入，仅通过注入 now 控制任务到期；新增 other.stop/start 是区别于父提交被动接管回归的关键步骤。',
    '两个直接 enable 调用统一附加 catch 并写 ScheduledTasks debug，不将异步初始化异常伪装为调度成功。',
  ],
  alternatives: [
    '回溯性比较：只在重启时替换 tasks 数组不足以移除旧 nextFireAt/inFlight；立即按 now 重锚又会丢失磁盘 lastFiredAt 语义，因此实际选择清派生状态并复用首次见到任务的计算分支。',
    '回溯性比较：可以继续让 other 仅靠 50 毫秒 probe 被动接管，但那不能触发同一实例生命周期重置；显式 stop/start 并再次推进虚拟时间可观察重启路径，仍需另造持有旧调度状态的实例才能定向验证本提交的两个 clear。',
  ],
  security: [
    '没有新增外部输入、文件路径或权限分支；stop 清的是进程内 ID 集合和时间 Map，锁释放仍由 releaseSchedulerLock 按 owner identity 处理。',
    'enable 异常只进入 debug 日志，不在本提交新增重试、提权或自动修改任务文件的恢复动作。',
  ],
  acceptance: [
    'stop 同时清 inFlight/nextFireAt，并继续清 timers、关闭 watcher、按需释放锁。',
    '同一实例 start 后重新发起任务文件读取，空 nextFireAt 使 check 按当前 tasks 的 lastFiredAt ?? createdAt 重锚；读盘不 await，旧异步 finally 也仍需定向交错验证。',
    'owner-neutral 回归执行 other.stop/start，在第二次虚拟时间推进后观察到 otherFired，且最终清理 other。',
    'dir 与已启用 REPL 两个直接 start 分支都捕获 enable rejection 并记录 debug；不改变既有正常启动路径。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'stop 新增 inFlight.clear 与 nextFireAt.clear，两个直接 void enable() 调用新增 catch/debug；其他锁和 timer 清理保持。',
      source: {
        path: 'src/utils/cronScheduler.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'inFlight.clear()',
        note: '生命周期状态重置的直接实现证据。',
      },
    },
    {
      kind: 'test-added',
      statement: 'takeover 回归在 owner.stop 后显式执行 other.stop、other.start，再推进 current 60_000 并等待 otherFired；此项只证明非 owner 的虚拟时间重启步骤随提交加入，不构成 stop 状态清理有效性的独立证据。',
      source: {
        path: 'tests/cronLifecycle.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: 'other.start()',
        note: '区分显式重启与被动接管的测试改动；不证明该用例能在未清状态的父提交上失败。',
      },
    },
    {
      kind: 'recorded-ci-pass',
      statement: '后续 271cf75 在 RELEASE.md 将 GitHub Actions run 42861258902 记录为 e31ff8f 通过；工作流包含依赖安装、SDK 类型生成、typecheck、bun test、build 及 CLI/SDK smoke。这是提交后的累积树 CI 证据，不替代状态清理的定向回归。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: '271cf757a24eb6cd7e46586fa18995759be32043',
        symbol: 'CI run `42861258902` passed',
        note: '后续发布记录对 e31ff8f 的明确 CI 归因及其实际工作流范围。',
      },
    },
    {
      kind: 'not-recorded',
      statement: 'at-commit STATUS 的 152 tests、645 assertions、typecheck/build 继承自 adaa8ff，不是本提交修改后的本地执行记录。没有真实多进程崩溃/重启或专门针对 enable rejection 日志的新测试；修改的用例使用同一进程、临时目录和注入 now。',
    },
  ],
  remaining: [
    '现有用例只重启首次未触发的 other，未重启积累 recurring nextFireAt/inFlight 的 owner，也没有 stop 后状态断言；两个 clear 是否消除旧生命周期残留仍需能够区分父提交的定向回归。重启读盘与首次 check 的先后顺序也未覆盖。',
    'one-shot 与 recurring 的异步 finally 没有生命周期标识，旧任务可能在重启后删除新周期同 ID 的 inFlight；该交错及真实进程崩溃恢复仍无新增证据。',
    'enable rejection 被记录为 debug，但该 diff 没有自动重试策略；enablePoll 回调也不是本次两个 catch 修改的对象。',
  ],
  references: [
    {
      path: 'src/utils/cronScheduler.ts',
      role: 'changed',
      symbol: 'nextFireAt.clear()',
      note: 'stop 清派生调度/去重状态，直接 start 分支捕获 enable 异常；重启仍走原 load/check。',
    },
    {
      path: 'tests/cronLifecycle.test.ts',
      role: 'changed',
      symbol: 'other.start()',
      note: '在 owner-neutral takeover 后显式重启 other，并再次推进虚拟时间验证触发。',
    },
    {
      path: 'src/utils/cronTasks.ts',
      role: 'reused',
      symbol: 'export async function readCronTasks',
      note: 'enable/load 复用磁盘任务读取，lastFiredAt 与 createdAt 的重锚数据不改格式。',
    },
    {
      path: 'src/utils/cronTasksLock.ts',
      role: 'reused',
      symbol: 'export async function releaseSchedulerLock',
      note: 'stop 继续按原 owner identity 释放锁，本提交不改锁协议。',
    },
  ],
  plan: {
    preconditions: [
      '确认父提交 stop 保留 inFlight/nextFireAt，而 load(true) 和 check 已具备从磁盘任务首次锚定的路径。',
      '确认回归已能动态识别 owner/other，新增步骤必须显式重启 other，不能只等待被动 probe。',
      '确认测试的 now 只控制任务到期，真实 check/probe timers 仍需要 waitFor。',
    ],
    reuse: [
      '复用 readCronTasks、recurring 的 lastFiredAt ?? createdAt 锚定、jitter 计算和持久化写入。',
      '复用 stop 的 timer/watcher/lock 清理、enable/start 正常流程以及既有 afterEach 清理。',
      '复用父提交的 50 毫秒 lockProbeIntervalMs 与 owner/other 动态选择，不重复设计接管机制。',
    ],
    steps: [
      {
        title: '重置 stop 生命周期状态并收口启动异常',
        detail:
          '在 cronScheduler.ts 的 stop 开头清 inFlight 和 nextFireAt，保留原有 stopped、timer、watcher、锁处理。给 dir 与已启用 REPL 两个直接 enable 调用添加 catch/debug；不要改 cron 文件或首次锚定算法，让重启通过空 Map 和 load(true) 自然重建。',
        paths: ['src/utils/cronScheduler.ts'],
      },
      {
        title: '把被动接管回归扩展为显式重启',
        detail:
          '在 cronLifecycle.test.ts 保留 owner.stop，随后加入 other.stop/start，再把 current 推进 60_000，以 10 秒 waitFor 等 otherFired。这样测试观察的是此前未触发的 other 实例显式重启、重新获锁并再次触发，而不是上一提交的被动 takeover；不把它记为旧 owner 状态清理或读盘先于 check 的定向回归。',
        paths: ['tests/cronLifecycle.test.ts'],
      },
    ],
    compatibility: [
      'CronSchedulerOptions、start/stop 签名和 cron 文件结构不变，生产默认探测与 check 周期不变。',
      '停止后 getNextFireTime 不再返回旧生命周期值；重启继续使用磁盘 lastFiredAt/createdAt，而非无条件立即触发。',
    ],
    risks: [
      '若只清 nextFireAt 而保留 inFlight，重启仍可能跳过任务；两个派生结构必须同时重置。',
      '虚拟时钟推进不会唤醒真实 timer，测试仍需真实 waitFor；10 秒等待不是把文件与锁操作同步化。',
      '该用例不覆盖 stop 与未结束 one-shot 删除的交错，enable catch 也只记录异常而不证明恢复。',
    ],
    verification: [
      '定向重复运行 cron lifecycle，确认 owner.stop 后 other 经显式 stop/start 在第二次虚拟时间推进后触发。',
      '另补定向检查：让实际触发并持有 nextFireAt/inFlight 的 owner 停止再启动，直接验证 stop 后两者为空及 recurring 重锚；现有 other 用例没有执行这些断言。',
      '核对两个直接 start 分支的 rejection 日志路径；任何测试通过结论必须引用实际命令或 CI 来源。',
    ],
    completed: [
      'stop 已清 inFlight/nextFireAt，两个直接 enable 启动路径已增加 rejection 日志。',
      '测试已加入非 owner 的 other.stop/start 和第二次虚拟时间推进，用于观察显式重启后的再次触发；不将其记为旧状态清理或磁盘重锚的定向回归。',
    ],
    incomplete: [
      '真实多进程崩溃恢复、实际 owner 旧状态清理、读盘与首次 check 顺序、one-shot/recurring 异步 finally 跨生命周期交错及 enable 失败重试没有新增验证。',
      'enablePoll 的异步回调未随这两个直接调用一起修改。',
    ],
  },
})
