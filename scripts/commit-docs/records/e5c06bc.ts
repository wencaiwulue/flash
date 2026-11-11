import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'e5c06bc3865ddeee428732aae46dab58c412a545',
  title: 'Record feature completion and CI evidence',
  kind: 'evidence-update',
  status: 'implemented',
  beforeState:
    '父提交 6b7bf48 的 RELEASE 只到 initial restoration release，并说明实际 SHA 与 GitHub Actions 结果留待后续文档更新；其中 known limitations 仍列出该实现提交已经处理的若干能力。父提交 STATUS 已记录 38 tests、146 assertions 及分项验证矩阵。',
  problem:
    '需要把前一实现提交的完整 SHA、CI run、远端存在性和验证汇总补入 RELEASE，同时保留 Cloud xattr 与 daemon/bridge remote control 的协议阻塞边界。本提交不修改 STATUS，也不实现任何功能。',
  goals: [
    '在 RELEASE 新增 Follow-up feature completion 段，明确其证据对象为 6b7bf48b0b4f0af740073eddbc5584f0c598c539。',
    '记录 ci run 42757526053、origin/main 存在性以及 38/146、build 和 declarations 的历史结果。',
  ],
  nonGoals: [
    '不重新实现或重新验证 Linux libsecret、npm marketplace、ultraplan、SDK rewind、stop hooks 和 SDK control APIs。',
    '不把 Cloud xattr 或 daemon/bridge remote control 改写成已实现，也不宣称本次文档提交产生了新的运行结果。',
  ],
  architecture: [
    '运行时架构不适用：唯一变更是在 docs/RELEASE.md 追加十行发布证据。新段以完整实现 SHA 为对象，将代码能力摘要、CI、远端和离线验证计数集中记录，并用末尾一句继续指向 STATUS 的当前能力矩阵。',
  ],
  decisions: [
    '把证据放在独立的 Follow-up feature completion 段，而不回写 initial release 的已知限制或提交身份，保持两个历史事件可区分。',
    'CI、remote 与测试计数均作为 RELEASE 中已有记录引用；本记录不将它们升级为本次重新执行的结果。',
  ],
  alternatives: [
    '回溯性比较：直接改写 initial release 的 limitations 会混合 9b2a352 与 6b7bf48 两个时点；追加段落能保留原始发布上下文，但读者仍需结合 STATUS 判断最新状态。',
  ],
  security: [
    '新增内容只有提交标识、CI 编号、能力摘要和验证计数，不包含凭据或新的执行逻辑；npm registry 无访问等具体边界仍以 STATUS 为准。',
  ],
  acceptance: [
    'RELEASE 新段的 Commit 字段精确指向直接父提交，CI 字段精确记录 42757526053 于 2026-11-10 通过。',
    '新增验证汇总为 38 tests、146 assertions、build 与 declaration generation passing，且 Cloud 与 daemon/bridge 仍标为协议阻塞。',
    'diff 不含 docs/STATUS.md 或任何产品、测试文件变更。',
  ],
  evidence: [
    {
      kind: 'recorded-ci-pass',
      statement: 'RELEASE 记录 ci run 42757526053 在 2026-11-10 通过；这是新增文档中的历史 CI 声明。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '`ci` run `42757526053` passed on 2026-11-10',
        note: 'Follow-up feature completion 段的 CI 记录。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: 'RELEASE 记录完整套件为 38 tests、146 assertions，并记录 build 与 declaration generation 通过。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: 'commit',
        symbol: 'The full suite now has 38 tests and 146 assertions',
        note: '新增段落的验证计数与构建结果；不代表本记录编写时重跑。',
      },
    },
    {
      kind: 'diff-observed',
      statement: '新段把完整 SHA 6b7bf48b0b4f0af740073eddbc5584f0c598c539 与 origin/main 存在性写在同一证据对象下。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: 'commit',
        symbol: 'the same commit is present on `origin/main`',
        note: '提交身份及远端状态的直接文档增量。',
      },
    },
    {
      kind: 'not-recorded',
      statement: '该提交没有新增命令输出、真实 Cloud/remote 往返或独立 CI API 响应；只有 RELEASE 中的结果记录。',
    },
  ],
  remaining: [
    'Cloud xattr 与 daemon/bridge remote control 的协议阻塞说明保持未解；真实环境结果不能由这段发布摘要推得。',
  ],
  references: [
    {
      path: 'docs/RELEASE.md',
      role: 'changed',
      symbol: '## Follow-up feature completion',
      note: '追加父实现提交的 SHA、CI run、origin/main、能力摘要、38/146 与构建/声明结果，并保留两项协议阻塞。',
    },
    {
      path: 'docs/STATUS.md',
      role: 'reused',
      symbol: '| `bun test` | 38 tests, 146 assertions passed |',
      note: '复用父提交未改的验证矩阵来限定 RELEASE 摘要，尤其保留 mock/offline 与 protocol-blocked 语义。',
    },
  ],
  plan: {
    preconditions: [
      '以 6b7bf48 的 RELEASE 末尾和未修改的 STATUS 为基线，确认待补对象是直接父提交而非 initial release。',
    ],
    reuse: [
      '沿用 RELEASE 的 Commit/CI/Remote 字段格式，并沿用 STATUS 的测试计数与协议阻塞分类。',
    ],
    steps: [
      {
        title: '追加功能完成证据段',
        detail:
          '在 RELEASE 末尾建立 Follow-up feature completion，依次写入父提交完整 SHA、CI run、origin/main 记录、实际能力摘要及 38/146、build、declarations 结果。',
        paths: ['docs/RELEASE.md'],
      },
      {
        title: '核对未实现边界',
        detail:
          '对照同一提交未改的 STATUS，确认新段仍把 Cloud xattr 和 daemon/bridge remote control 留为 authoritative protocols 阻塞，且不新增其他文件。',
        paths: ['docs/RELEASE.md', 'docs/STATUS.md'],
      },
    ],
    compatibility: [
      '既有 initial release 内容原样保留，新证据以追加段落呈现，STATUS 的矩阵和计数不变。',
    ],
    risks: [
      '能力摘要容易被误读为本次文档提交重新实现或在线验证；证据类型必须保持为历史记录，并保留 offline/protocol-blocked 限定。',
    ],
    verification: [
      '比较父/当前 RELEASE，确认仅新增十行且 SHA、run ID、日期、38/146 计数逐项一致。',
      '核对 STATUS 无 diff，并确认 RELEASE 的 Cloud 与 remote-control 限定没有被省略。',
    ],
    completed: [
      'Follow-up feature completion 段已按父提交身份补齐发布与 CI 元数据。',
    ],
    incomplete: [
      '该文档增量没有提供独立日志或真实 Cloud/remote 环境验证。',
    ],
  },
})
