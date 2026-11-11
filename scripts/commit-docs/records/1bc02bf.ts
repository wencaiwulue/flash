import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '1bc02bfb5271653be2dd2c2fcc498246cf111dc5',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交是 3fbabc2d43b99236cae4c232c6730bb6bc0a19ef，但实际待补对象是再前一提交 d472e5c963d799ffa51192e7358ecaba45de8c7a。父树已登记 2f55f19，INDEX Implemented 为 59，JSON 含 self 共 61 项，d472e5c 的 SPEC/PLAN 尚不存在。',
  problem: '提交标题中的 previous 不能解释为直接父 3fbabc2；本 diff 实际为 d472e5c 建文档。若按直接父填写 frontmatter，会同时错配身份和 d472e5c 所记录的 501672c 文档范围。',
  goals: [
    '为 d472e5c 新建 SPEC/PLAN，准确保留 Complete previous commit documentation、2026-11-11T11:06:14+08:00 和 implemented。',
    '登记 d472e5c 为 501672c 建立文档对的四路径、78 行新增和 1 行删除范围，并同步两个索引。',
  ],
  nonGoals: [
    '不为直接父 3fbabc2 或当前 1bc02bf 创建文档，也不改动 scripts/document-commits.ts。',
    '不执行或声称执行生成 PLAN 所列 test、typecheck、build 与 CI 检查。',
  ],
  architecture: [
    'd472e5c 的两个 Markdown 文件负责历史说明，INDEX 和 status JSON 负责发现；本提交没有运行时代码或生成器变更。',
    '新历史项排在 2f55f19 后、self 前；self 的 changeId、implemented 状态和 self-SPEC/self-PLAN 路径均只顺移，不被改写为当前 SHA。',
  ],
  decisions: [
    'SPEC 的 Actual scope 指向 501672c-SPEC、501672c-PLAN 与两个索引，而不是直接父 3fbabc2 的 2f55f19 文档组。',
    'INDEX Implemented 59→60，Partial 1、Unimplemented 0 不动；JSON 61→62 项，含 self 的 implemented 60→61。',
    'd472e5c 成为 JSON 第 61 项，self 成为第 62 项；当前提交自身没有新增 SHA 条目。',
  ],
  alternatives: ['若选择 3fbabc2 会把下一提交 1329f79 的对象提前并写错范围；只添加 d472e5c 文件而不加双索引，则 Implemented 60 与可发现入口无法同时成立。'],
  security: ['四个路径均为文档元数据，没有生成器执行逻辑、依赖、凭据或权限边界变化。'],
  acceptance: [
    '两个 frontmatter 均绑定 d472e5c 完整 SHA 和原提交时间，Actual scope 与 501672c 文档组一致。',
    'INDEX 行和 JSON 对象使用同一对 d472e5c 路径，位于 2f55f19 后且 self 仍居末位。',
  ],  remaining: ['直接父 3fbabc2 和当前 1bc02bf 在此快照仍未建档；本提交仅闭合 d472e5c。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 59→60，新增 d472e5c 行。' },
    { path: 'docs/plans/d472e5c-PLAN.md', role: 'changed', note: 'd472e5c 的新建实施计划。' },
    { path: 'docs/specs/d472e5c-SPEC.md', role: 'changed', note: '记录 d472e5c 身份和 501672c 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'JSON 61→62 项，self 前插入 d472e5c。' },
  ],
  plan: {
    preconditions: ['区分直接父 3fbabc2 与实际目标 d472e5c，并核对后者 diff 中的 501672c 产物。'],
    reuse: ['沿用既有 SPEC/PLAN 模板、INDEX 列和 JSON 字段，保留 2f55f19 后的追加顺序及 self 占位。'],
    steps: [
      { title: '建立 d472e5c SPEC', detail: '写入目标身份、501672c 两个文档路径及 78/1 行统计。', paths: ['docs/specs/d472e5c-SPEC.md'] },
      { title: '建立 d472e5c PLAN', detail: '以同一 frontmatter 保存模板步骤、风险、验证建议和完成状态。', paths: ['docs/plans/d472e5c-PLAN.md'] },
      { title: '登记人类索引', detail: '在 2f55f19 后新增 d472e5c，只把不含 self 的 Implemented 调至 60。', paths: ['docs/INDEX.md'] },
      { title: '登记机器索引', detail: '把 d472e5c 作为第 61 个对象插入，使 self 顺移至第 62 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 2f55f19 链接与 self 文档不变；生成器源码和 JSON schema 均未调整。'],
    risks: ['相邻提交都采用 previous 标题，混淆 3fbabc2 与 d472e5c 会让 frontmatter、Actual scope 和索引三者一起错位。'],
    acceptanceSequence: ['解析两份 frontmatter，对照 d472e5c 原始 diff，并比较父/当前索引计数和 self 下标。'],
    completed: ['d472e5c 的 SPEC/PLAN 与两个索引入口已在同一提交落盘。'],
    incomplete: ['没有可归属到本提交的验证执行日志，implemented 仅描述元数据完成状态。'],
  },
})
