import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '1329f792eb0a103eeeabea26a46566bfa9eceaba',
  slug: 'commit-docs-finalization',
  title: 'Finalize documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父提交 1bc02bfb5271653be2dd2c2fcc498246cf111dc5 刚补完 d472e5c，INDEX Implemented 为 60，JSON 62 项。当前实际目标是祖父 3fbabc2d43b99236cae4c232c6730bb6bc0a19ef，其父树尚无 3fbabc2 文档或索引项。',
  problem: '需要在 d472e5c 后补回 3fbabc2，而不是把直接父 1bc02bf 当作目标；3fbabc2 的说明还必须保留其为 2f55f19 建文档的历史范围。',
  goals: [
    '新建 3fbabc2 SPEC/PLAN，frontmatter 使用 Finalize previous commit documentation、2026-11-11T11:06:43+08:00 和完整目标 SHA。',
    '记录 2f55f19 文档对、两个索引及 78 行新增、1 行删除，并增加唯一一组双索引入口。',
  ],
  nonGoals: [
    '不提前登记 1bc02bf 或 1329f79，不重写刚加入的 d472e5c 条目。',
    '不修改文档生成器，也不把模板中的命令和 CI 名称当成运行结果。',
  ],
  architecture: [
    '本提交仍是纯元数据层：两份新历史文档加两个索引补丁，没有产品或生成器执行路径变化。',
    '3fbabc2 接在 d472e5c 后，self 保持末尾；新增对象使用历史 fullSha，而 self 对象不使用当前提交身份。',
  ],
  decisions: [
    'Actual scope 选择 2f55f19-SPEC/PLAN，区别于上一历史项 d472e5c 所记录的 501672c 文档组。',
    'INDEX Implemented 60→61，其他状态维持 1/0；JSON 总数 62→63，含 self 的 implemented 61→62。',
    '3fbabc2 是 commits 第 62 项，self 移到第 63 项，两个新文件正好对应新增索引字段。',
  ],
  alternatives: ['按提交措辞选择直接父 1bc02bf 会跳过 3fbabc2 并重复下一层工作；只修改索引则无法提供本次实际新增的 3fbabc2 文档内容。'],
  security: ['变更仅写入提交说明和索引元数据，未引入凭据、网络行为、权限变更或新执行代码。'],
  acceptance: [
    'SPEC/PLAN 的标题、日期、完整 SHA 与 3fbabc2 一致，范围明确指向 2f55f19。',
    'INDEX 和 JSON 各新增一个 implemented 项，d472e5c 保持不动，self 位于最后。',
  ],  remaining: ['1bc02bf 与当前 1329f79 的文档仍待后续提交，本快照只补齐 3fbabc2。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 60→61，添加 3fbabc2 链接行。' },
    { path: 'docs/plans/3fbabc2-PLAN.md', role: 'changed', note: '新建 3fbabc2 计划文档。' },
    { path: 'docs/specs/3fbabc2-SPEC.md', role: 'changed', note: '记录 3fbabc2 及其 2f55f19 实际范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 62→63，self 前登记 3fbabc2。' },
  ],
  plan: {
    preconditions: ['确认目标是祖父 3fbabc2，并核对其 2f55f19 SPEC/PLAN 和四文件统计。'],
    reuse: ['复用 d472e5c 后的索引顺序、self 占位和已有生成文档结构，不改变字段格式。'],
    steps: [
      { title: '编写 3fbabc2 SPEC', detail: '绑定 3fbabc2 身份并列出 2f55f19 文档对与两个索引。', paths: ['docs/specs/3fbabc2-SPEC.md'] },
      { title: '编写 3fbabc2 PLAN', detail: '保留相同标题和时间，写入计划小节及 implemented 声明。', paths: ['docs/plans/3fbabc2-PLAN.md'] },
      { title: '更新 INDEX', detail: '在 d472e5c 后添加 3fbabc2 行，把 Implemented 单项递增到 61。', paths: ['docs/INDEX.md'] },
      { title: '更新 status JSON', detail: '在 self 前插入第 62 个历史对象，保持现有 self 内容不变。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['d472e5c 及更早链接不重排，self 路径不变；生成器和索引结构保持父版本行为。'],
    risks: ['3fbabc2 与直接父 1bc02bf 都是文档提交，若仅按时间邻近选择对象，会把 2f55f19 范围错挂到 1bc02bf。'],
    acceptanceSequence: ['核对 3fbabc2 原始提交元数据与 diff，再检查两个索引只新增该对象且 self 最后。'],
    completed: ['3fbabc2 文档对和双索引注册已完整落盘，四个变更路径均可直接核对。'],
    incomplete: ['没有实际命令或 CI 日志，生成 PLAN 的宽泛完成声明不扩大本记录的证据范围。'],
  },
})
