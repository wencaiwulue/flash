import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '4dbadb8a7616033419b9d4a614b62c11c1c3df52',
  kind: 'evidence-update',
  status: 'partial',
  beforeState: '父提交已经记录本地 live 脚本的四项模型 sentinel 与 SKILLHUB_LIVE_OK，但 RELEASE 尚未关联 hosted live-validation run，STATUS 的 Verified evidence 表也没有该 workflow 行。',
  problem: '需要补录 GitHub Actions 结果，同时保留缺凭据跳过与真正执行的区别。实际补丁在 RELEASE 写明 model/Cloud 可跳过，却在 STATUS 写成 Model、SkillHub、Cloud jobs passed，两个公开状态来源因此对 Cloud 给出不一致含义。',
  goals: [
    '把 live-validation run 42940722483 加入 RELEASE，并记录无凭据和无 self-hosted runner 时的跳过条件。',
    '在 STATUS 增加 workflow 行，同时识别其 Cloud passed 表述与 RELEASE 的冲突，而不替历史补丁掩盖。',
  ],
  nonGoals: [
    '不把 workflow 整体成功解释成每个 live job 都执行成功，skip 不是 live round trip。',
    '不新增模型、SkillHub、Cloud 或桌面探针，也不修改 secrets、runner 和脚本。',
  ],
  architecture: ['证据沿两个文档面传播：RELEASE 保存 run ID 与跳过条件，STATUS 保存摘要表行。二者本应对同一运行给出一致结论；本提交的实际设计缺陷正是 STATUS 摘要丢失了 Cloud 的 skip 限定。'],
  decisions: ['回溯记录同时保留 run 通过和文档矛盾，而不是只引用较乐观的 STATUS 行，也不把后来的配置状态倒填到这次运行。'],
  alternatives: ['更稳妥的实现应把 STATUS 写成 workflow passed，并列明 model/Cloud 按凭据跳过；直接删除 STATUS 行虽能消除冲突，却会丢失本次证据更新，这两种都不是实际 diff。'],
  security: ['文档只记录公开 run 和 sentinel，不写入 secret 值；Cloud 与桌面是否具备授权环境必须由真实 job 行为证明。'],
  acceptance: [
    'RELEASE 包含 42940722483，并明确 model/Cloud 缺凭据跳过和 desktop 无 self-hosted runner 跳过。',
    'STATUS 的新增行被原样识别为过度概括，不能被本设计文档重新表述为 Cloud live verified。',
  ],
  evidence: [
    {
      kind: 'recorded-ci-pass',
      statement: 'RELEASE 记录 live-validation run 42940722483 passed，但同句限定 model/Cloud 可在缺凭据时 skipped，desktop 可在无 runner 时 skipped。',
      source: { path: 'docs/RELEASE.md', role: 'evidence', revision: 'commit', symbol: '42940722483', note: 'hosted run 标识及跳过条件的直接来源。' },
    },
    {
      kind: 'diff-observed',
      statement: 'STATUS 同时新增 Model、SkillHub、Cloud jobs passed，未保留 Cloud skip 限定，因此该证据提交自身存在未调和的状态冲突。',
      source: { path: 'docs/STATUS.md', role: 'evidence', revision: 'commit', symbol: '| `live-validation` workflow |', note: '用于定位与 RELEASE 不一致的摘要行。' },
    },
    {
      kind: 'not-recorded',
      statement: '此提交没有附上 Cloud OAuth round trip 或桌面控制日志，不能用 workflow 结论补齐这些证据。',
    },
  ],
  remaining: ['STATUS 的 Cloud jobs passed 需要另行校正为带环境条件的 workflow 结果；在此之前，该证据提交只能记为 partial。'],
  references: [
    { path: 'docs/RELEASE.md', role: 'changed', symbol: '42940722483', note: '追加 hosted run 与 model/Cloud/desktop 的跳过条件。' },
    { path: 'docs/STATUS.md', role: 'changed', symbol: '| `live-validation` workflow |', note: '新增摘要行，但其 Cloud passed 没有保留 RELEASE 的限定。' },
  ],
  plan: {
    preconditions: ['读取本地 sentinel 的既有发布段，并核对 hosted run 中各 job 是 executed 还是 skipped。'],
    reuse: ['沿用 STATUS 的 Verified evidence 表和 RELEASE 的 CI live validation 段，不创建第二套运行记录。'],
    steps: [
      { title: '补写 RELEASE 运行结果', detail: '在 SkillHub global namespace 说明后追加 42940722483，并保留三个环境缺省时的跳过语义。', paths: ['docs/RELEASE.md'] },
      { title: '增加 STATUS 摘要', detail: '把 workflow 行加入验证表；审查时应发现 Cloud jobs passed 与上一步限定不一致，而不是将其当成可靠 live 证明。', paths: ['docs/STATUS.md'] },
      { title: '核对跨文档结论', detail: '逐 job 比较两个文件，标记 Cloud 的冲突并保留 desktop 无 runner 的边界。', paths: ['docs/RELEASE.md', 'docs/STATUS.md'] },
    ],
    compatibility: ['既有本地 sentinel 不变；新增 hosted 结果必须与原能力矩阵分开解读。'],
    risks: ['把 skipped 写成 passed 会让后续审计误以为 OAuth Cloud 已验证，这是本提交实际引入的文档风险。'],
    verification: ['检查两文件 diff 中的 run ID 和 skip 条件，再对照 STATUS 摘要，确认没有把 skip 当作 live 成功。'],
    completed: ['hosted run 及跳过条件已进入 RELEASE，STATUS 也增加了对应 workflow 行。'],
    incomplete: ['两个文档对 Cloud 的结论尚未调和，且没有新增 Cloud/desktop 实际执行证据。'],
  },
})
