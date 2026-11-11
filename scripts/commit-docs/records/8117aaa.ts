import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '8117aaa81ba58bb7ddae1256712797880a6cdebd',
  slug: 'commit-docs-finalization',
  title: 'Finalize self record for current commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交是 587c466f7e28e4cb59b0c4522857a7110e7b152a。其生成器遍历 git log --reverse 的全部提交，INDEX 当时为 Implemented 40、Partial 1、Unimplemented 0；本提交没有改动这些文档。',
  problem: '最新 HEAD 也进入逐提交文档、索引行和状态计数，提交生成结果后产生的新 SHA 不会与已写入的 HEAD 身份一致，需要把当前 HEAD 排除在历史记录循环之外。',
  goals: [
    '仅调整 buildCommitDocuments 的历史遍历边界，使最新 HEAD 不再生成历史 SPEC/PLAN 和索引项。',
    '保留独立 self 文档与 self 索引项的既有生成路径。',
  ],
  nonGoals: [
    '本提交不新增 587c466 或 8117aaa 的 SPEC/PLAN，也不修改 INDEX/status。',
    '不增加测试、CI 检查或文档内容模板，亦不声称执行过这些验证。',
  ],
  architecture: [
    'commits() 将 git log --reverse 映射为时间正序数组，因而末尾元素就是当前 HEAD；slice(0, -1) 在主循环入口排除这一项。',
    '被截断的循环仍统一负责历史 SPEC、PLAN、INDEX 行、JSON 对象及状态计数，循环之后的 self-SPEC、self-PLAN 和 self 注册逻辑不变。',
  ],
  decisions: [
    '只把 for (const commit of commits()) 改为 for (const commit of commits().slice(0, -1))，没有在各输出分支分别增加条件。',
    'self 与历史 HEAD 是两套身份：前者仍固定生成，后者不再冒充一个已经定稿的历史提交。',
  ],
  alternatives: ['保留全量循环再过滤输出会分散 HEAD 排除规则；修改 commits() 又会影响其他调用者，因此把边界限定在文档构建循环更直接。'],
  security: ['单行变更不引入凭据、网络访问或权限绕过；它只减少被处理的 Git 元数据范围。'],
  acceptance: [
    '当前 HEAD 不进入历史文档、两个索引或 implemented/partial/unimplemented 计数。',
    'self 的两个文件和索引项仍由原有代码生成，历史数组其余元素处理顺序不变。',
  ],  remaining: ['此提交只建立排除 HEAD 的规则；它本身及直接父提交的缺失文档需要由后续提交处理。'],
  references: [
    { path: 'scripts/document-commits.ts', role: 'changed', note: '将历史文档生成循环改为排除最新 HEAD。' },
  ],
  plan: {
    preconditions: ['确认 commits() 的 --reverse 顺序和当前 HEAD 位于数组末尾，并区分历史提交与 self。'],
    reuse: ['沿用 commits、specFor、planFor、statusFor 及现有 self 生成函数，不新增文档抽象。'],
    steps: [
      { title: '截断最新历史项', detail: '在唯一主循环的数组来源上移除末尾 HEAD，使该提交的全部历史产物和计数同步跳过。', paths: ['scripts/document-commits.ts'] },
      { title: '保留 self 分支', detail: '不移动循环后的 self 文件与索引注册，维持其独立身份。', paths: ['scripts/document-commits.ts'] },
    ],
    compatibility: ['除最新 HEAD 外，历史提交仍按原顺序生成；已有 self 路径和 JSON 字段保持不变。'],
    risks: ['排除 HEAD 后，新提交自身不会立即获得历史文档，需要后续提交补齐；索引不能提前引用尚不存在的文件。'],
    acceptanceSequence: ['可从源码确认数组截断位置，并分别检查主循环和 self 分支；本提交未保存实际生成或测试结果。'],
    completed: ['HEAD 排除已落在统一历史循环，diff 未触碰其他生成逻辑。'],
    incomplete: ['没有随提交记录运行生成器、测试、typecheck、build 或 CI 的结果。'],
  },
})
