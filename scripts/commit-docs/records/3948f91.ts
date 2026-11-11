import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '3948f914500e3982fb160607250d6a2e22f0578d',
  slug: 'deterministic-cron-takeover',
  title: 'Make cron takeover test deterministic',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交已把 cron 接管等待放宽到 30 秒，但测试仍先等 first.getNextFireTime，再要求只有 firstFired 增长；两个异步 enable 竞争同一锁时，second 也可能成为 owner。非 owner 的 setInterval 固定使用 LOCK_PROBE_INTERVAL_MS=5000，测试无法缩短真实探测周期。ReviewArtifact 测试则仍通过上一提交的 AsyncLocalStorage cwd override 读取临时目录中的相对路径。',
  problem:
    '需要让回归验证“恰有一个 owner，停止后另一个接管”，而不是把异步竞争结果硬编码为 first，并用可注入探测周期压缩真实等待。artifact 用例已经持有完整临时路径，可以进一步移除不必要的 cwd 上下文。本提交不处理同一 scheduler 停止再启动时的 inFlight/nextFireAt 残留。',
  goals: [
    '为 createCronScheduler 增加可选 lockProbeIntervalMs，缺省保持 5000 毫秒，仅让非 owner 的锁探测 timer 使用该值。',
    '让 takeover 测试接受 first 或 second 任一方先触发，断言另一方未触发，再停止实际 owner 并等待另一方接管。',
    '在 second scheduler 注入 50 毫秒探测周期，保留虚拟 now 推进与真实 check/lock timer 的组合。',
    '把 ReviewArtifact 输入改成 join(dir, artifact.txt) 的绝对路径，移除该测试对 runWithCwdOverride 的依赖。',
  ],
  nonGoals: [
    '不改变锁文件格式、O_EXCL 竞争、owner 释放规则、1000 毫秒 check 周期或生产默认 5000 毫秒探测周期。',
    '不在 stop 中清理调度 Map/Set，不把 takeover 测试改成 other.stop/start 重启测试。',
    '不修改 ReviewArtifact 产品路径解析，也不宣称两个同进程 scheduler 等同真实多进程锁竞争。',
  ],
  architecture: [
    'CronSchedulerOptions 新增 lockProbeIntervalMs。enable 初次未获锁时创建 lockProbeTimer，其间隔改为 options.lockProbeIntervalMs ?? LOCK_PROBE_INTERVAL_MS；获锁后的 isOwner=true、清除 probe timer 以及 stop 释放锁的流程不变。生产调用方省略选项时仍是 5000 毫秒，50 毫秒只出现在测试中。',
    'takeover 回归先等待任一方 getNextFireTime 非空，再把共享 current 推进 60_000，并等待 firstFired.length + secondFired.length 至少为 1。触发数组非空的一方被选为 owner，另一方及其 fired 数组被选为 other/otherFired；断言 otherFired 为空后停止 owner，再等待 otherFired。断言对象从启动顺序转为实际行为，因此无论谁赢锁都检查同一单 owner 与接管契约。',
    'ReviewArtifact 测试保留临时目录和文件，但将 artifact_path 直接设为 join(dir, artifact.txt)。reviewArtifact 原有 resolve(getCwd(), input.artifact_path) 对绝对输入无需临时 cwd，故移除 override 包裹，finally 仍递归删除目录。',
  ],
  decisions: [
    '把可变性限制在锁探测 timer 的构造参数，而不是缩短全局常量或模拟 tryAcquireSchedulerLock；真实锁获取、释放和 owner 切换仍被测试走通。',
    '用首次实际触发决定 owner/other，不读取私有 isOwner，也不接受双方触发；这同时保留互斥断言并消除启动竞态假设。',
    'artifact 用例改用绝对路径而非保留 AsyncLocalStorage，是因为该用例只验证文件 artifact 读取；相对路径 override 已由上一提交覆盖，本 diff 的实际选择是更直接的输入。',
  ],
  alternatives: [
    '回溯性比较：继续固定 first 会使测试把合法锁竞争当成失败；只断言双方总计一次再固定停止 first，又可能停错对象，因此实际实现同时动态选择 owner 和 other。',
    '回溯性比较：可以用 fake timers 取代真实锁探测，但那会绕过本用例关注的 timer/lock 协作；注入 50 毫秒只压缩等待，不改变调度器算法。',
  ],
  security: [
    'lockProbeIntervalMs 是内部调用方选项，不来自 cron 文件或用户 prompt；缺省生产探测频率不变，锁的 owner identity 校验和释放逻辑复用原实现。',
    '绝对 artifact 路径仅改变测试输入，文件仍经原 ReviewArtifact 实现读取；本提交没有新增生产文件访问或权限分支。',
  ],
  acceptance: [
    '省略 lockProbeIntervalMs 时使用 5000 毫秒，传入 50 时非 owner 每 50 毫秒探测，成功获锁后仍停止 probe timer。',
    'first 或 second 任一方首次触发都可通过，首次阶段另一方必须零触发；停止实际 owner 后，另一方最终触发。',
    'ReviewArtifact 绝对路径测试不再导入 runWithCwdOverride，仍返回 fake runner 的 ok summary 并清理目录。',
    'stop/start 状态清理不属于本次验收，上一提交的 cwd 相对路径实现也未被产品层修改。',
  ],  remaining: [
    '此 revision 的 stop 尚未清 inFlight/nextFireAt，测试仍是 owner.stop 后等待 other 被动接管，没有覆盖 other.stop/start。',
    '两个 scheduler 位于同一测试进程，锁身份不同但 PID 相同；真实跨进程存活探测和崩溃恢复未被该用例证明。',
  ],
  references: [
    {
      path: 'src/utils/cronScheduler.ts',
      role: 'changed',
      symbol: 'lockProbeIntervalMs',
      note: '为非 owner 锁探测增加可注入间隔，默认仍使用 5000 毫秒。',
    },
    {
      path: 'tests/cronLifecycle.test.ts',
      role: 'changed',
      symbol: 'const owner = firstFired.length > 0 ? first : second',
      note: '按实际触发选择 owner/other，并注入 50 毫秒锁探测。',
    },
    {
      path: 'tests/reviewArtifact.test.ts',
      role: 'changed',
      symbol: "artifact_path: join(dir, 'artifact.txt')",
      note: '使用绝对 artifact 路径，移除不再需要的异步 cwd override。',
    },
    {
      path: 'src/utils/cronTasksLock.ts',
      role: 'reused',
      symbol: 'export async function tryAcquireSchedulerLock',
      note: '复用既有 O_EXCL 获锁、身份判断和 releaseSchedulerLock，不改锁协议。',
    },
    {
      path: 'src/tools/ReviewArtifactTool/ReviewArtifactTool.ts',
      role: 'reused',
      symbol: 'resolve(getCwd(), input.artifact_path!)',
      note: '绝对路径仍由原 resolve/getCwd 入口处理，产品实现不变。',
    },
  ],
  plan: {
    preconditions: [
      '确认首次获锁由异步 enable 竞争决定，测试不得把 first.start 的调用顺序当作锁所有权保证。',
      '确认锁探测只用于非 owner，且生产默认 5000 毫秒必须保持；虚拟 now 不会驱动真实 setInterval。',
      '确认 ReviewArtifact 用例只需读取已知绝对文件路径，不再以此用例测试相对 cwd 解析。',
    ],
    reuse: [
      '复用 tryAcquireSchedulerLock/releaseSchedulerLock、原有 isOwner 切换和 timer 清理。',
      '复用临时 cron 目录、永久 recurring 任务、注入 now、waitFor 和 afterEach scheduler/directory 清理。',
      '复用 ReviewArtifact 原 resolve/getCwd 路径及 fake review runner。',
    ],
    steps: [
      {
        title: '注入非 owner 锁探测周期',
        detail:
          '在 cronScheduler.ts 的 options 类型加入 lockProbeIntervalMs 及默认值注释，将 lockProbeTimer 的 setInterval 第二参数改为选项值加原常量回退。不要改变首次获锁、probe 成功后的清理或生产调用方。',
        paths: ['src/utils/cronScheduler.ts'],
      },
      {
        title: '把 takeover 回归改为 owner-neutral',
        detail:
          '在 cronLifecycle.test.ts 给 second 传入 50 毫秒探测，先等任一 nextFireTime，再推进共享 current 并等待合并 fired。依据非空 fired 数组选出 owner、other 和 otherFired，确认对方未触发后停止 owner，最后等待 otherFired；保留 40 秒总预算。',
        paths: ['tests/cronLifecycle.test.ts'],
      },
      {
        title: '简化 artifact 文件路径输入',
        detail:
          '在 reviewArtifact.test.ts 删除 runWithCwdOverride 导入与包裹，把 artifact_path 改为 join(dir, artifact.txt)。保留文件写入、ok 断言和临时目录清理，使本用例直接验收绝对路径读取。',
        paths: ['tests/reviewArtifact.test.ts'],
      },
    ],
    compatibility: [
      'createCronScheduler 只增加可选字段，现有调用方无需修改，缺省锁探测行为保持 5000 毫秒。',
      'cron 锁文件、任务持久化、ReviewArtifact API 和相对路径能力均未删除；变化的只是测试输入与等待策略。',
    ],
    risks: [
      '若只等待 first.getNextFireTime 会继续携带 owner 假设；必须先接受任一 scheduler 就绪，再按实际 fired 选择角色。',
      '50 毫秒探测使用真实 timer，CI 仍需等待 check 和异步文件写；该选项缩短窗口但不把完整生命周期变成同步测试。',
      '本用例只证明被动接管，停止再启动可能遇到不同内存状态，不能据此扩大验收范围。',
    ],
    acceptanceSequence: [
      '重复定向运行 cron takeover，分别观察任一启动顺序下首次仅一方触发、停止 owner 后另一方接管。',
      '检查未传 lockProbeIntervalMs 的调用仍走 5000 毫秒默认值，测试第二实例明确为 50 毫秒。',
      '运行 ReviewArtifact 文件用例，确认绝对路径读取成功且不依赖 cwd override；执行结论只引用有来源的命令记录。',
    ],
    completed: [
      '锁探测间隔可注入且默认值不变，takeover 回归不再假设 first 必须获锁。',
      'ReviewArtifact 文件用例已改为绝对路径并移除 cwd override。',
    ],
    incomplete: [
      '同一 scheduler 的 stop/start、inFlight/nextFireAt 清理和重启后磁盘重锚定尚未覆盖。',
      '继承的 152/645 不是本提交修改后的执行结果，owner-neutral 与 50ms probe 没有独立运行记录。',
      '真实多进程锁存活与崩溃接管、真实模型 review 没有新增执行证据。',
    ],
  },
})
