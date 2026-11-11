import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'ab2d941c75f445320180c2559bc62e146238aacc',
  slug: 'commit-docs-ci-status',
  kind: 'evidence-update',
  status: 'partial',
  beforeState: '父提交已让 CI 在 checker 前生成文档，RELEASE 的 Commit documentation policy 段也已提到 41 historical commits、索引和 self 约定，但尚未记录这套流程的 hosted run 结果。',
  problem: '需要补录文档 CI 结果时，补丁只追加 run 42952964466，没有校正同段已经过时的 41 数量。该 revision 的完整历史为 93 个提交、92 个祖先，因此“All 41 historical commits”不能描述当时的全量文档集合；run 通过也不能证明模板正文具有设计价值。',
  goals: ['记录完整历史生成/校验结果；CI 执行标识仅用于文档定位，不表示本次重新验证，并在回溯设计中明确保留数量过时与语义质量未验收两个边界。'],
  nonGoals: ['不修改生成器、历史 SPEC/PLAN 或 CI 顺序，不把本提交描述为文档内容质量整改。'],
  architecture: ['这是一次发布证据追加：既有政策段提供流程说明，新 执行标识 提供执行关联。文档数量由 Git 历史决定而非静态文字决定；保留 41 使政策段与实际索引规模脱节。'],
  decisions: ['将 hosted run 记为已记录证据，同时把该提交标为 partial，因为它没有完成同段状态同步，且其“independent SPEC/PLAN”仅表示文件存在。'],
  alternatives: ['更完整的证据更新应同时按实际历史刷新数量，并说明 checker 只验证生成一致性；单纯删除数量可避免过时，但仍不能替代内容质量审查。'],
  security: ['新增内容是公开 CI 标识，不含 secret；不得由 full-history CI 成功推断 OAuth、Cloud 或桌面环境验证。'],
  acceptance: ['RELEASE 能定位 full-history generation/validation，且回溯记录明确区分历史实际数量和设计内容未审查三件事；CI 执行标识仅用于文档定位，不表示本次重新验证。'],  remaining: ['政策段的 41 数量需改为动态历史口径；所有生成文档仍需另行完成实质设计和实施内容审查。'],
  references: [
    { path: 'docs/RELEASE.md', role: 'changed', symbol: 'full-history generation', note: '追加文档 CI 结果，但保留原有 41-commit 静态描述；CI 标识仅用于文档定位，不表示本次重新验证。' },
  ],
  plan: {
    preconditions: ['确认父提交文档流程及对应 revision，并独立计算 at-commit 全历史数量。'],
    reuse: ['沿用 Commit documentation policy 段，不另建重复的发布章节。'],
    steps: [
      { title: '追加 hosted 文档结果', detail: '在 self 约定说明后续写 full-history generation/validation。', paths: ['docs/RELEASE.md'] },
      { title: '审计同段状态', detail: '对照 Git 清单检查既有 41 数量及质量措辞；实际补丁未做同步，因此回溯状态必须保留这一缺口。', paths: ['docs/RELEASE.md'] },
    ],
    compatibility: ['旧流程说明保持同段，但静态数量不能作为后续历史的可靠索引。'],
    risks: ['把 CI 成功与文档设计质量混同会掩盖通用 fallback；保留过时数量还会误导覆盖范围。'],
    acceptanceSequence: ['执行 rev-list --count ab2d941，并抽查生成 SPEC/PLAN 是否包含真实架构与步骤。'],
    completed: ['文档 CI 结果已补入 RELEASE。'],
    incomplete: ['静态历史数量未更新，SPEC/PLAN 的语义质量也未在该提交验收。'],
  },
})
