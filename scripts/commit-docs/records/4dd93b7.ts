import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '4dd93b75220926cefbe9d5d017224238bfd8e0f1',
  slug: 'reregister-live-validation-workflow',
  title: 'Re-register live validation workflow',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本把 live 验证定义保存在 .github/workflows/live-validation.yml，内部名称仍为 live-validation。',
  problem: '提交主题指向重新注册，但可观察实现只有 workflow 文件换名；外部注册故障和结果都没有记录，设计范围不能扩展到平台行为。',
  goals: ['将定义迁移到 .github/workflows/live-checks.yml，并保持 YAML 字节不变。'],
  nonGoals: [
    '不修改内部名称、触发器、job、权限或验证脚本。',
    '不把文件换名描述成 workflow dispatch、schedule 或 CI 已成功。',
  ],
  architecture: ['产品架构不适用：本提交只有 GitHub Actions 路径迁移，没有产品源码或运行时 wiring；CI 定义本身不变。'],
  decisions: ['以单一 R100 rename 表达注册路径变化，保留 model、skillhub 两个 job 及原有 name 字段。'],
  alternatives: ['事后看，同时修改 name 虽能让显示名贴近新文件名，却会破坏纯重命名范围；保留旧路径则不存在本次可观察的注册路径迁移。'],
  security: ['contents: read、secret 与 variable 引用均逐字保留，没有新增权限或执行步骤。'],
  acceptance: ['旧路径消失、新路径出现，rename detection 为 R100，新旧 blob 直接比较为空。'],  remaining: ['GitHub 是否随后收录或执行新路径下的 workflow，需要平台侧证据。'],
  references: [
    { path: '.github/workflows/live-checks.yml', oldPath: '.github/workflows/live-validation.yml', role: 'changed', note: '同一 YAML blob 的纯重命名，覆盖新旧两个路径。' },
  ],
  plan: {
    preconditions: ['读取父版本旧路径内容，作为零内容变化比较基准。'],
    reuse: ['完整复用 workflow_dispatch、cron、permissions、两个 job 及其环境映射。'],
    steps: [
      { title: '纯重命名 workflow', detail: '把旧路径移动到 live-checks.yml，不编辑任何 YAML 行。', paths: ['.github/workflows/live-validation.yml', '.github/workflows/live-checks.yml'] },
      { title: '核对 blob 身份', detail: '比较父版本旧路径与提交版本新路径，确认 R100 且内部名称未变。', paths: ['.github/workflows/live-checks.yml'] },
    ],
    compatibility: ['手动触发、17 6 * * * schedule 和两条验证命令保持原样；仅依赖文件名的外部消费者需要识别新路径。'],
    risks: ['显示名与文件名不同，且路径变化本身不能证明平台注册结果。'],
    acceptanceSequence: ['用 rename-aware diff 检查唯一变更，再比较两个 revision 的 workflow blob。'],
    completed: ['新旧路径替换及零内容变化均可由提交直接确认。'],
    incomplete: ['换名后的注册、dispatch 和 schedule 执行情况未记录。'],
  },
})
