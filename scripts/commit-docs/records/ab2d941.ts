import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'ab2d941c75f445320180c2559bc62e146238aacc',
  kind: 'evidence-update',
  status: 'partial',
  beforeState: '父提交已让 CI 在 checker 前生成文档，RELEASE 的 Commit documentation policy 段也已提到 41 historical commits、索引和 self 约定，但尚未记录这套流程的 hosted run 结果。',
  problem: '需要补录文档 CI 结果时，补丁只追加 run 42952964466，没有校正同段已经过时的 41 数量。该 revision 的完整历史为 93 个提交、92 个祖先，因此“All 41 historical commits”不能描述当时的全量文档集合；run 通过也不能证明模板正文具有设计价值。',
  goals: ['记录 CI run 42952964466 的完整历史生成/校验结果，并在回溯设计中明确保留数量过时与语义质量未验收两个边界。'],
  nonGoals: ['不修改生成器、历史 SPEC/PLAN 或 CI 顺序，不把本提交描述为文档内容质量整改。'],
  architecture: ['这是一次发布证据追加：既有政策段提供流程说明，新 run ID 提供执行关联。文档数量由 Git 历史决定而非静态文字决定；保留 41 使政策段与实际索引规模脱节。'],
  decisions: ['将 hosted run 记为已记录证据，同时把该提交标为 partial，因为它没有完成同段状态同步，且其“independent SPEC/PLAN”仅表示文件存在。'],
  alternatives: ['更完整的证据更新应同时按实际历史刷新数量，并说明 checker 只验证生成一致性；单纯删除数量可避免过时，但仍不能替代内容质量审查。'],
  security: ['新增内容是公开 CI 标识，不含 secret；不得由 full-history CI 成功推断 OAuth、Cloud 或桌面环境验证。'],
  acceptance: ['RELEASE 能定位 42952964466，且回溯记录明确区分 run passed、历史实际数量和设计内容未审查三件事。'],
  evidence: [
    {
      kind: 'recorded-ci-pass',
      statement: 'at-commit RELEASE 追加 CI run 42952964466 passed with full-history generation and validation。',
      source: { path: 'docs/RELEASE.md', role: 'evidence', revision: 'commit', symbol: '42952964466', note: '文档 workflow 执行结果的发布记录。' },
    },
    {
      kind: 'diff-observed',
      statement: '同一 RELEASE 段仍写 All 41 historical commits；Git 在 ab2d941 可枚举 93 个节点，说明静态数量没有随历史更新。',
      source: { path: 'docs/RELEASE.md', role: 'evidence', revision: 'commit', symbol: 'All 41 historical commits', note: '过时数量与实际 Git 清单形成可核对差异。' },
    },
    {
      kind: 'not-recorded',
      statement: '该提交没有逐 SPEC/PLAN 的设计评审记录，不能把生成一致性解释为方案或实施步骤质量通过。',
    },
  ],
  remaining: ['政策段的 41 数量需改为动态历史口径；所有生成文档仍需另行完成实质设计和实施内容审查。'],
  references: [
    { path: 'docs/RELEASE.md', role: 'changed', symbol: '42952964466', note: '追加文档 CI 结果，但保留原有 41-commit 静态描述。' },
  ],
  plan: {
    preconditions: ['确认父提交文档流程及 run 对应 revision，并独立计算 at-commit 全历史数量。'],
    reuse: ['沿用 Commit documentation policy 段，不另建重复的发布章节。'],
    steps: [
      { title: '追加 hosted 文档结果', detail: '在 self 约定说明后续写 42952964466 和 full-history generation/validation passed。', paths: ['docs/RELEASE.md'] },
      { title: '审计同段状态', detail: '对照 Git 清单检查既有 41 数量及质量措辞；实际补丁未做同步，因此回溯状态必须保留这一缺口。', paths: ['docs/RELEASE.md'] },
    ],
    compatibility: ['旧流程说明和 run 关联保持同段，但静态数量不能作为后续历史的可靠索引。'],
    risks: ['把 CI 成功与文档设计质量混同会掩盖通用 fallback；保留过时数量还会误导覆盖范围。'],
    verification: ['搜索 run ID，执行 rev-list --count ab2d941，并抽查生成 SPEC/PLAN 是否包含真实架构与步骤。'],
    completed: ['文档 CI run 标识已补入 RELEASE。'],
    incomplete: ['静态历史数量未更新，SPEC/PLAN 的语义质量也未在该提交验收。'],
  },
})
