import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '3c4b6f2752cee47fd15ead682e6016fe48174bd8',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '来到 parent fdffe9e 时，Implemented 已为 81，f5b097b 排在 self 前；但 e8d8c066c1419579fbf8bf6f653760110eaf315a 的 SPEC、PLAN 和两种索引入口仍全部缺失。',
  problem: 'e8d8c06 刚刚完成的是 4329cd8 的补档，本提交则要为 e8d8c06 自己补档。相同提交标题叠加两层文档关系，最容易把新建 e8d8c06 文件误写成修改 4329cd8 文件。',
  goals: [
    '创建 docs/specs/e8d8c06-SPEC.md 与 docs/plans/e8d8c06-PLAN.md，准确描述 e8d8c06 的身份及其 4329cd8 文档范围。',
    '将 INDEX 的 implemented 汇总更新为 82，并在 status JSON 中加入 e8d8c06 的完整映射。',
  ],
  nonGoals: [
    '不编辑 e8d8c06 所生成的 4329cd8 文档，也不改变 parent fdffe9e 已登记的 f5b097b 内容。',
    '不根据 PLAN 的验证清单推断任何测试、构建或 CI 已通过。',
  ],
  architecture: [
    '这是一次文档链的下一层封装：新 SPEC 引用 4329cd8 两个产物作为 e8d8c06 的历史范围，本次 diff 的实体新增则是 e8d8c06 两个产物。',
    '索引层仍由 Markdown 表格与 JSON 数组构成，新记录置于 f5b097b 后、self 前；self 的定义未随历史链增长而改变。',
  ],
  decisions: [
    'frontmatter 固定 e8d8c06 的 2026-11-11T11:19:30+08:00 与 Finalize 标题；SPEC 保留该提交 4 文件、78 insertions、1 deletion 的原始统计。',
    'Implemented 从 81 调为 82，Partial 与 Unimplemented 继续为 1、0；JSON 的 spec/plan 不再指向上层 4329cd8，而指向本次 e8d8c06 文件。',
  ],
  alternatives: ['在 4329cd8 文档里追加 e8d8c06 内容会合并不同修订的历史；只新增索引行又没有目标文件，因此选择独立产物加双重登记。'],
  security: ['变更没有可执行代码、秘密材料或权限模型调整，仅扩充提交文档元数据。'],
  acceptance: [
    '两个新文件都标明 e8d8c066c1419579fbf8bf6f653760110eaf315a，SPEC 中的嵌套路径确为 4329cd8。',
    'INDEX 显示 82/1/0，e8d8c06 行位于 f5b097b 后；JSON 字段与两个新文件一致且 self 仍在末尾。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'e8d8c06 SPEC 的 Actual scope 同时列出 INDEX、status JSON 和 4329cd8 的 SPEC/PLAN，反映被补档提交的四文件范围。',
      source: { path: 'docs/specs/e8d8c06-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/specs/4329cd8-SPEC.md', note: '4329cd8 是被描述范围，不是本次 changed reference。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 以 e8d8c06 完整 SHA 为 frontmatter commit，并保留 implemented 完成状态。',
      source: { path: 'docs/plans/e8d8c06-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'commit: e8d8c066c1419579fbf8bf6f653760110eaf315a', note: '身份与本记录描述的提交一致。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 将 Implemented 81 改为 82，并新增带两个 e8d8c06 链接的表格行。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 82', note: '新行插在 self 前，其他状态计数未动。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 添加 e8d8c06 的完整 SHA、2026-11-11T11:19:30+08:00、Finalize subject 和文档路径。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"plan": "docs/plans/e8d8c06-PLAN.md"', note: '该对象位于 self 对象之前。' },
    },
    { kind: 'not-recorded', statement: '两个生成文件只给出建议验证序列，diff 中没有任何对应执行结果。' },
  ],
  remaining: ['新 PLAN 没有针对 e8d8c06 的四项补丁给出专门步骤，仍停留在通用计划文本。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '新增 e8d8c06 行，Implemented 81→82。' },
    { path: 'docs/plans/e8d8c06-PLAN.md', role: 'changed', note: '新建 e8d8c06 的实施计划。' },
    { path: 'docs/specs/e8d8c06-SPEC.md', role: 'changed', note: '新建引用 4329cd8 范围的 e8d8c06 SPEC。' },
    { path: 'docs/status/index.json', role: 'changed', note: '新增 e8d8c06 机器可读条目。' },
  ],
  plan: {
    preconditions: ['厘清 e8d8c06 是当前文档对象，4329cd8 是其 SPEC 内的历史范围，fdffe9e 才是实际 parent。'],
    reuse: ['沿用相邻条目的字段顺序与 Markdown 小节，保持 f5b097b 和 self 的相对位置。'],
    steps: [
      { title: '建立 e8d8c06 规格', detail: '填写 e8d8c06 身份，并如实抄录其 4329cd8 两文件范围与 78+1 统计。', paths: ['docs/specs/e8d8c06-SPEC.md'] },
      { title: '建立 e8d8c06 计划', detail: '使用相同提交日期和 Finalize 标题，生成计划的各个标准小节。', paths: ['docs/plans/e8d8c06-PLAN.md'] },
      { title: '移动汇总到 82', detail: '在 f5b097b 行之后加入 e8d8c06，保持 self 行不动。', paths: ['docs/INDEX.md'] },
      { title: '登记 e8d8c06 JSON', detail: '让机器条目指向新建 SPEC/PLAN，而不是其内部提到的 4329cd8 文件。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['已有 79 至 81 计数对应的历史行保持原顺序，只追加新一代入口。'],
    risks: ['同名 Finalize 提交连续出现，完整 SHA 与嵌套路径若未同时核对，就可能错配一代。'],
    verification: ['检查 e8d8c06 原始 name-status 与 SPEC 路径块，并核对当前 INDEX/JSON 的 82 计数和新对象。'],
    completed: ['e8d8c06 自身的两个文档与两个索引入口已经补齐。'],
    incomplete: ['通用计划没有执行证据，也没有更细的生成过程说明。'],
  },
})
