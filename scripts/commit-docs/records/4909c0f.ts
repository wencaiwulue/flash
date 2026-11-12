import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '4909c0fccbf24736f5c670ef936bae317e52dd4c',
  changeId: 'date-based-commit-docs-design',
  title: 'Design date-based commit documentation',
  kind: 'component',
  status: 'implemented',
  beforeState: 'c69c271 已把 SPEC/PLAN 改为逐提交结构化设计记录，包含实质架构、实施步骤和验证证据，但交付文件仍按 short SHA 命名，读者无法从文件名识别日期和功能。',
  problem: '下一阶段的文档迁移同时涉及命名、同日冲突、完整 SHA 映射、证据移除、旧链接和生成/检查语义。如果没有独立设计就批量改写九十余个提交的记录，容易丢失已有设计内容、混淆 self 与历史身份，或把历史执行结果继续复制到目标格式。',
  goals: [
    '形成一份可评审的日期加功能命名设计，保留完整 SHA 与每份 SPEC/PLAN 的精确对应。',
    '定义记录、命名、校验、渲染、索引和迁移步骤，覆盖同日同 slug 和 self 的动态清单。',
    '明确从历史交付文档删除执行证据，只保留验收标准与实现范围。',
  ],
  nonGoals: [
    '本提交只新增设计文档，不修改生成器、记录 schema、历史 SPEC/PLAN、索引或产品实现。',
    '不重跑历史测试、CI、OAuth、Cloud 或桌面验证，也不声明迁移已经实施。',
    '不改写 Git 历史或提交标题，不承诺旧 SHA 深链继续有效。',
  ],
  architecture: [
    '设计把 Git 历史作为 SHA、日期和 diff 的事实源，显式记录提供人工 slug、设计和引用，命名校验完成后才由统一渲染器生成 Markdown 与索引。',
    '历史输出采用 YYYY-MM-DD-slug-SPEC/PLAN，self 保持固定名称；完整 SHA 继续保存在 frontmatter 和索引中，因此人类可读命名不会改变记录身份。',
    '迁移顺序先固化旧 self 与已落地设计评审记录，再批量更新记录和渲染，生成新文件及索引后才显式删除旧 SHA 文件，最后由只读 checker 发现孤儿和过期产物。',
  ],
  decisions: [
    '日期取 committer date 的自然日，slug 由每条记录显式维护，避免从标题自动翻译导致不稳定或语义误猜。',
    '同日同 slug 按历史顺序分配 02、03 等后缀，最终路径冲突必须失败而不是覆盖。',
    '结构化记录目标中删除 evidence 字段，PLAN 的 verification 改为 acceptanceSequence，从数据模型上阻止历史执行结果进入新交付文档。',
    'writer 继续是本地显式写入口，CI 只读检查，迁移中间状态不允许被当作完成。',
  ],
  alternatives: [
    '保留 SHA 文件名无需迁移但可读性差，直接按标题生成 slug 又会引入翻译和改名漂移，因此采用显式 slug 加完整 SHA。',
    '一次性删除旧文件再生成会放大中断风险，设计选择先建立新文件和索引、后清理旧文件。',
    '保留历史证据与只写验收标准都能描述过去，但本设计明确选择后者，避免交付文档继续承担执行日志职责。',
  ],
  security: [
    '命名校验、路径冲突和孤儿检查防止静默覆盖或错误链接，敏感信息检查继续作为生成门禁。',
    '迁移不重放历史命令或外部 live 流程，设计中的命令仅是后续验收顺序，不是本提交的执行证据。',
  ],
  acceptance: [
    '设计文档覆盖命名格式、slug 规则、同日冲突、schema/渲染/索引变化、迁移顺序和错误处理。',
    '明确 94 与 190 只是设计基线数量，实际清单必须由生成时 Git 历史动态计算，并包含设计评审提交。',
    '明确本提交没有实施迁移，后续完成必须同时满足记录、输出、链接、旧文件清理和工程验收条件。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '提交只新增一份带 approved 状态的日期加功能命名设计，包含十个章节及迁移、错误处理和验收矩阵，没有修改生成代码或历史输出。',
      source: { path: 'docs/superpowers/specs/2026-11-11-date-based-commit-design-docs-design.md', role: 'evidence', revision: 'commit', symbol: '## 10. 完成定义', note: '可核对本提交的实际文档范围和完成条件。' },
    },
    {
      kind: 'not-recorded',
      statement: '本提交是设计评审落盘，没有迁移实现或迁移测试可记录；后续实现不能倒写成本提交证据。',
    },
  ],
  remaining: [
    '日期加 slug 的记录字段、命名模块、渲染和索引尚未实现。',
    '全部历史记录的 slug、证据移除、旧文件迁移、链接更新和后续工程验收仍待实施。',
  ],
  references: [
    { path: 'docs/superpowers/specs/2026-11-11-date-based-commit-design-docs-design.md', role: 'changed', note: '新增完整的日期加功能命名与迁移设计。' },
  ],
  plan: {
    preconditions: [
      'c69c271 的结构化记录、实质 SPEC/PLAN 和只读 CI 政策已经存在，迁移以保留这些设计内容为前提。',
    ],
    reuse: [
      '复用现有 self/head/next 语义、完整 SHA 记录身份、Bun 生成与检查入口，避免另建平行文档系统。',
    ],
    steps: [
      {
        title: '评审命名与迁移契约',
        detail: '把目标、非目标、数据流、记录与渲染变化、迁移和验收写成独立设计，明确本提交不执行迁移。',
        paths: ['docs/superpowers/specs/2026-11-11-date-based-commit-design-docs-design.md'],
      },
    ],
    compatibility: [
      '内部 records 仍按 short SHA 加载，完整 SHA 是稳定身份；只有交付 SPEC/PLAN 路径改为日期加功能名。',
      'self 继续承接未提交工作，新历史记录必须先固化当前 self 和已落地设计提交。',
    ],
    risks: [
      '同日冲突和批量 rename 容易产生覆盖、孤儿与断链，设计要求确定性序号、统一命名和只读检查。',
      '删除证据字段可能误删实现范围信息，迁移需区分执行结果与仍可保留的设计行为。',
    ],
    verification: [
      '后续实现先测试日期、slug、冲突、内容和渲染，再执行全量 next 生成与只读检查。',
      '核对动态 Git 清单、每提交一对文档、索引链接、旧文件清零和重复生成幂等。',
      '本提交仅核对设计文件和完成定义，不声明后续命令已执行。',
    ],
    completed: [
      '日期加功能命名的 approved 设计已落盘，并与 c69c271 基线及后续 self 迁移要求建立关联。',
    ],
    incomplete: [
      '所有生成器、记录、历史文档和索引的实际迁移及其验证均未在本提交实施。',
    ],
  },
})
