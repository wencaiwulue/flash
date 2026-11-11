import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'c43f42e4eba9ae16c7d7a78dfbcfcb4bfb177d0c',
  title: 'Isolate CI lifecycle test timing and cwd',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交的 ReviewArtifact 文件读取测试虽然使用 mkdtemp 隔离目录，却通过 getCwdState/setCwdState 改写进程级 cwd，并在 finally 恢复；并发异步测试可能观察到这份临时全局状态。cron takeover 回归固定等待 first 获锁和触发，second 接管等待为 12 秒、整个测试上限为 15 秒，而非 owner 的锁探测常量仍为 5000 毫秒。',
  problem:
    '需要减少 CI 中由共享 cwd 和偏紧计时窗口造成的测试不稳定，同时不改变 ReviewArtifact 或 cron 产品实现。这里的修复只建立异步上下文隔离并放宽接管等待，不解决 first 必获锁的假设，也不注入锁探测间隔。',
  goals: [
    '用 runWithCwdOverride 将 ReviewArtifact 的临时目录限制在当前异步调用链，移除测试对全局 cwd 的写入和恢复。',
    '把 second 接管等待从 12 秒放宽到 30 秒，并把整个 cron takeover 测试上限从 15 秒调整为 40 秒。',
  ],
  nonGoals: [
    '不修改 cronScheduler、cronTasksLock、ReviewArtifactTool 或生产 cwd 解析逻辑。',
    '不让测试接受 second 先获锁，不改变 5000 毫秒生产探测周期，也不添加 stop/start 重启回归。',
    '不把临时目录与 fake review runner 测试描述为真实模型 artifact review 或多进程 cron 验证。',
  ],
  architecture: [
    'ReviewArtifact 测试继续在同一临时目录写 artifact.txt，但调用改为 runWithCwdOverride(dir, () => reviewArtifact(...))。既有 cwd.ts 用 AsyncLocalStorage<string> 保存 override，pwd/getCwd 在当前异步上下文及其后代读取它，未设置时才回退 getCwdState；因此测试 finally 只需删除目录，不再恢复全局状态。',
    'cron 测试的调度器、虚拟 now、锁实现和 first/second 断言均保持原样，唯一时序变化是 waitFor 的 secondFired 上限扩为 30_000，test 总预算扩为 40_000。真实 setInterval 仍按 1000 毫秒 check、5000 毫秒 lock probe 运行，放宽的是等待窗口而非虚拟时钟。',
  ],
  decisions: [
    '复用已经存在的 AsyncLocalStorage cwd 入口，而不是在测试中另建 mock 或继续 setCwdState；这样被测 reviewArtifact 仍经正常 getCwd/resolve 路径读取文件。',
    '本提交仅放大接管时间预算，保留固定 owner 断言；owner-neutral 选择和可注入 probe interval 不属于该 diff。',
  ],
  alternatives: [
    '回溯性比较：可以继续依赖 try/finally 恢复全局 cwd，但那不能隔离恢复前的并发读取；也可以直接改用绝对路径，但本提交实际先验证 AsyncLocalStorage override，绝对路径简化不在此范围。',
    '回溯性比较：可以把锁探测改成更短的生产常量来加速测试，但那会改变所有调用方；本提交只延长测试等待，保持调度器行为不变。',
  ],
  security: [
    'AsyncLocalStorage override 限定测试读取临时 artifact 的 cwd，不新增文件权限或扩大 ReviewArtifact 的输入契约。',
    '两个变更文件都是测试，没有新增网络访问、凭据处理或生产权限分支。',
  ],
  acceptance: [
    'ReviewArtifact 测试在 override 异步上下文中读取相对 artifact.txt，源码不再导入或调用 getCwdState/setCwdState，并始终清理临时目录。',
    'cron takeover 的 second 等待上限为 30 秒、测试上限为 40 秒，原有单 owner 触发断言不变。',
    '产品源码零变更，cwd override 与锁探测的既有生产默认值不被测试调整改写。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'ReviewArtifact 文件测试以 runWithCwdOverride 包裹完整异步调用，并删除全局 cwd 的保存和恢复。',
      source: {
        path: 'tests/reviewArtifact.test.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'runWithCwdOverride(dir',
        note: '异步 cwd 隔离的直接测试改动。',
      },
    },
    {
      kind: 'diff-observed',
      statement: 'cron takeover 仍等待 firstFired 后停止 first，但 secondFired 的等待为 30_000，测试总超时为 40_000。',
      source: {
        path: 'tests/cronLifecycle.test.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'secondFired.length >= 1, 30_000',
        note: '本提交只扩大锁接管等待窗口。',
      },
    },
    {
      kind: 'not-recorded',
      statement: 'c43f42e 未修改 STATUS/RELEASE；其中 152 tests、645 assertions、typecheck/build 记录继承自更早的 adaa8ff，早于本提交，只能作为先前基线，不能证明本次 cwd 隔离和计时窗口修改后执行通过。本提交没有定向或全量运行记录。',
      source: {
        path: 'docs/STATUS.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '| `bun test` | 152 tests, 645 assertions passed |',
        note: '该表在 at-commit 快照中可见，但内容来自 adaa8ff，不是本提交的执行证据。',
      },
    },
    {
      kind: 'not-recorded',
      statement: '没有真实 ReviewArtifact 模型调用或跨进程 cron 接管证据；异步 cwd 隔离与等待窗口变更不能扩展为这些在线结论。',
    },
  ],
  remaining: [
    '该 revision 的 takeover 测试仍假设 first 是 owner，锁探测间隔也固定为 5000 毫秒；异步获锁先后与测试速度尚未解耦。',
    'stop/start 的调度状态重置不在本提交覆盖内，真实多进程锁竞争和真实模型 review 仍无新增证据。',
  ],
  references: [
    {
      path: 'tests/cronLifecycle.test.ts',
      role: 'changed',
      symbol: 'secondFired.length >= 1, 30_000',
      note: '只放宽 second 接管与整个测试的实时等待上限。',
    },
    {
      path: 'tests/reviewArtifact.test.ts',
      role: 'changed',
      symbol: 'runWithCwdOverride(dir',
      note: '用异步本地 cwd 包住 artifact 读取，移除全局 cwd 写入/恢复。',
    },
    {
      path: 'src/utils/cwd.ts',
      role: 'reused',
      symbol: 'new AsyncLocalStorage<string>()',
      note: '复用父提交已有的异步上下文 cwd override，pwd/getCwd 的回退逻辑不变。',
    },
    {
      path: 'src/tools/ReviewArtifactTool/ReviewArtifactTool.ts',
      role: 'reused',
      symbol: 'resolve(getCwd(), input.artifact_path!)',
      note: '被测实现继续通过 getCwd 解析相对 artifact 路径，本提交不改产品代码。',
    },
  ],
  plan: {
    preconditions: [
      '确认 cwd.ts 已提供 AsyncLocalStorage override，ReviewArtifact 通过 getCwd 解析相对路径，无需新增测试专用生产接口。',
      '确认 cron 回归使用真实计时器和既有 5000 毫秒锁探测，本步只调整等待预算。',
    ],
    reuse: [
      '复用 mkdtemp/rm 临时目录、fake review runner、虚拟 now、waitFor 和现有锁生命周期。',
      '复用 runWithCwdOverride，让被测异步调用及其后代看到同一目录，而不是模拟 ReviewArtifact 内部路径解析。',
    ],
    steps: [
      {
        title: '隔离 artifact 测试的异步 cwd',
        detail:
          '在 reviewArtifact.test.ts 移除 getCwdState/setCwdState 导入及保存/恢复语句，把写入后的相对路径读取包进 runWithCwdOverride。保留同一临时目录、fake runner、summary 断言和 finally 删除，使文件解析仍走真实 getCwd 路径。',
        paths: ['tests/reviewArtifact.test.ts'],
      },
      {
        title: '放宽 cron 锁接管等待窗口',
        detail:
          '在 cronLifecycle.test.ts 将 secondFired 的 waitFor 超时改为 30 秒，并将该测试的总超时改为 40 秒；不改 first owner 前提、虚拟时间推进或调度器常量。',
        paths: ['tests/cronLifecycle.test.ts'],
      },
    ],
    compatibility: [
      '生产 API、feature flag、cron 文件格式和 ReviewArtifact 路径契约均不变。',
      '测试仍使用相对 artifact 路径，因此继续覆盖异步 cwd override 对 getCwd 的影响。',
    ],
    risks: [
      '真实计时器在慢速 CI 上仍可能波动；30/40 秒只是更宽窗口，并不使 owner 选择或锁探测确定化。',
      'AsyncLocalStorage 只覆盖当前异步调用链，不能把其他未包裹测试的全局 cwd 写入变得安全。',
    ],
    verification: [
      '定向运行 ReviewArtifact 文件读取测试，并在并行测试环境下确认相对路径读取不依赖全局 cwd 恢复。',
      '重复运行 cron takeover 测试，核对 30 秒接管等待和 40 秒总预算；执行结果须另有命令或 CI 来源。',
    ],
    completed: [
      'ReviewArtifact 测试已切换到异步本地 cwd，cron 接管等待已放宽，且没有产品源码变更。',
    ],
    incomplete: [
      '固定 first owner、固定探测周期和 stop/restart 状态问题仍未在该 revision 处理。',
      '本提交没有独立定向或全量执行记录；at-commit STATUS 的 152/645 是 adaa8ff 留下的先前基线，真实模型和多进程运行也仍无证据。',
    ],
  },
})
