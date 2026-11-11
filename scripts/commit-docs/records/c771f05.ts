import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'c771f05fa4971b361de9a9b1dbfc880972154583',
  slug: 'commit-docs-finalization',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本 5c5bc03 已登记 787b2dc，INDEX 显示 Implemented 71、Partial 1、Unimplemented 0。目标祖父提交 6b0ce9d 的 SPEC/PLAN 尚未创建，status 中也没有它的对象。',
  problem: '要把 6b0ce9d 纳入文档链，并保留其特殊范围：它补的是祖父提交 b6bf982，而新 SPEC 的 Actual scope 因而应列出 b6bf982 两个文档，而非 5c5bc03 刚登记的 787b2dc。',
  goals: [
    '以 6b0ce9d6834a125567ec0121caa531f5b8341101 为完整提交身份创建对应 SPEC 与 PLAN。',
    '在双索引中登记 6b0ce9d，使 Implemented 从 71 到 72，并确保 self 条目持续垫底且无其他路径变化。',
  ],
  nonGoals: [
    '不追溯修改 b6bf982 或 787b2dc 的文件，也不将文档工作描述成产品代码实现。',
    '不依据文档内命令列表推断测试、构建或 CI 已执行。',
  ],
  architecture: [
    '四路径元数据迁移由两层说明组成：当前提交新增 6b0ce9d 的说明文件，而被说明的 6b0ce9d 又曾新增 b6bf982 的说明文件。',
    'INDEX 承担第 72 个 implemented 入口的展示，status JSON 保存相同 fullSha 与文件映射；二者均不改变 self 的引导项目身份。',
  ],
  decisions: [
    '新 SPEC 使用 6b0ce9d 的 Finalize previous commit documentation 标题，内层文件清单固定为 b6bf982-SPEC/PLAN 加 INDEX/status。',
    '索引操作采用追加而非重排：新行和新 JSON 对象都位于 self 前，汇总只调整 implemented，Partial 与 Unimplemented 不动。',
  ],
  alternatives: ['把新 SPEC 写成 787b2dc 的 96283ae 范围会混淆相邻两代；只创建两个 Markdown 又无法维持 72 项索引闭合，所以本提交同时处理四个路径。'],
  security: ['变更面没有程序逻辑、认证材料或访问控制，文档里的权限与凭据措辞不带来实际 enforcement。'],
  acceptance: [
    'SPEC/PLAN 均使用 6b0ce9d 的完整 SHA、2026-11-11T11:13:50+08:00 日期和 implemented 状态。',
    'SPEC 内层路径为 b6bf982 两份文档，INDEX 达 72/1/0，status 新对象字段一致，self 保持原内容与末位。',
  ],  remaining: ['新文件仍是概括性计划，未提供 6b0ce9d 模板生成过程的更多细节，也没有独立验证产物。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '加入 6b0ce9d 链接并将 implemented 计数设为 72。' },
    { path: 'docs/plans/6b0ce9d-PLAN.md', role: 'changed', note: '为目标祖父提交新建 Finalize 类型计划。' },
    { path: 'docs/specs/6b0ce9d-SPEC.md', role: 'changed', note: '记录 6b0ce9d 及其 b6bf982 内层范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前添加 6b0ce9d 的完整 JSON 注册。' },
  ],
  plan: {
    preconditions: ['以 5c5bc03 的 71 项索引为基线，确认 6b0ce9d 是本次目标祖父提交，并核对其自身的 b6bf982 四文件范围。'],
    reuse: ['沿用现有 Markdown 双文件和双索引布局，复用格式而不复制 787b2dc 的 96283ae 内容。'],
    steps: [
      { title: '描述 6b0ce9d 规格', detail: '把 6b0ce9d 的身份与其为 b6bf982 建文档的历史范围分开书写。', paths: ['docs/specs/6b0ce9d-SPEC.md'] },
      { title: '描述 6b0ce9d 计划', detail: '建立同身份 PLAN，使用 Finalize 标题并保留验证与剩余工作的独立段落。', paths: ['docs/plans/6b0ce9d-PLAN.md'] },
      { title: '推进索引到 72', detail: '将 6b0ce9d 作为 787b2dc 后的新历史行，implemented 增一且不动其他两类计数。', paths: ['docs/INDEX.md'] },
      { title: '写入第 72 项状态', detail: '把 6b0ce9d 的完整 SHA 和新文件路径登记在 JSON self 对象之前。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['保留既有 b6bf982、787b2dc 条目及 self 的 changeId/spec/plan，新增路径命名沿用短 SHA 约定。'],
    risks: ['本提交与前后提交都增删 78/1 行，若只比对统计会漏掉 b6bf982 与 96283ae 的语义差别。'],
    acceptanceSequence: ['读取 c771f05 版本中的四个路径，核对 6b0ce9d 全 SHA、b6bf982 范围、72/1/0 汇总及 self 末位。'],
    completed: ['6b0ce9d 的 SPEC、PLAN 和两类索引注册已经加入，且未出现第五个变更文件。'],
    incomplete: ['文档声明的命令没有输出存档，本记录不补造运行时或 CI 结论。'],
  },
})
