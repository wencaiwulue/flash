---
commit: 0b6806800508a15c7a5f8293c572b8fa5c960d24
title: "Implement ReviewArtifact and Hunter skill"
date: 2026-11-10T22:53:28+08:00
status: partial
kind: component
---

# 实施计划：Implement ReviewArtifact and Hunter skill

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要让作者对话之外的 reviewer 检查文件或内联 artifact，以预期行为而非个人风格为基准，返回可机读的 blocker/warning/nit、文件/行号及验证状态。文件输入必须复用 FileRead 权限而不是另开读取通道，评审 agent 只能使用只读检索工具；artifact 与 reviewer 输出都需要大小和结构约束。/hunter 应把这套约束变成用户可调用流程，并明确未执行验证的发现不能被包装成已通过。实际实现还须接受权限 updatedInput 和测试并发环境的检验，不能只验证直接函数调用。

- 确认父提交的 ReviewArtifact 工具与权限 UI 是禁用 stub，而 bundled/index 和 PermissionRequest 已有条件路由。
- 确认 runAgent 可接受独立 promptMessages、窄 availableTools、原 canUseTool 和系统提示覆盖。
- 把直接函数/mock 测试、完整权限 executor、真实 reviewer 和 CI 结果分成不同验证层。

## 复用与兼容处理

### 复用现有实现

- 复用 buildTool/Zod、createUserMessage、jsonStringify 和 getCwd，保持工具输入输出及路径约定。
- 复用 runAgent、GENERAL_PURPOSE_AGENT、asSystemPrompt 和原权限回调，不创建另一套 agent 协议。
- 复用 FileReadTool.checkPermissions 与 FallbackPermissionRequest，保持文件读取授权界面一致。
- 复用 registerBundledSkill、bundled/index 条件初始化、条件工具池和 Bun feature 档。

### 兼容、迁移与生命周期

- 保留 ReviewArtifact 工具名称和已有权限路由，在原禁用位置启用实现，不新增调用方入口。
- 文件路径沿用 FileRead 权限语义，但 updatedInput 必须使用 ReviewArtifact 原始字段；当前 revision 在这一兼容点上未完成。
- 内联 content 不需要文件权限，focus/context 可选，既有调用方不提供的字段使用默认审查重点。
- 输出从单一 message 扩展为 summary/findings/message，mapToolResult 改为完整 JSON，文本消费者需适应结构化内容。
- /hunter 复用 bundled prompt 命令形态，用户 args 原样追加，不引入新的持久状态或命令格式。

## 文件级实施步骤

### 1. 实现 artifact 输入、读取和结构化报告

在 ReviewArtifactTool.ts 先建立严格四字段输入和来源互斥校验，再实现内联/普通文件的 1 MB 读取。随后定义 findings/output schema、JSON 提取与 Zod 解析，最后组合 focus/context/artifact 提示并返回完整 JSON 工具结果。

涉及位置：`src/tools/ReviewArtifactTool/ReviewArtifactTool.ts`

### 2. 接入独立只读 reviewer 与文件权限

在同一工具实现 defaultReviewer，限制 Read/Grep/Glob、独立 promptMessages、八轮及最后文本提取。文件输入委托 FileReadTool，内联输入直接允许；权限组件改为 FallbackPermissionRequest。此步应同时核对 executor 的 updatedInput 契约，但 at-commit 实现和测试遗漏了形状适配。

涉及位置：`src/tools/ReviewArtifactTool/ReviewArtifactTool.ts`、`src/components/permissions/ReviewArtifactPermissionRequest/ReviewArtifactPermissionRequest.tsx`

### 3. 注册 Hunter、工具池和构建特性

新增 hunter.ts，固定独立评审、严重级别、证据和未验证提示并注册 user-invocable bundled skill。tools.ts 加入条件 ReviewArtifactTool，build.ts 开启 REVIEW_ARTIFACT，使父提交 bundled/index 的条件注册能够加载新模块。

涉及位置：`src/skills/bundled/hunter.ts`、`src/tools.ts`、`scripts/build.ts`

### 4. 添加离线回归和编译特性档

reviewArtifact.test.ts 用 mock runner 覆盖五个直接函数/注册场景，临时文件用例在目标版本使用全局 cwd。特性夹具导出并初始化 bundled skills，组合测试检查 38 工具、ReviewArtifact 和 hunter；这些断言不替代权限 executor 或真实 agent 验证。

涉及位置：`tests/reviewArtifact.test.ts`、`tests/fixtures/feature-check.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 5. 记录能力声明并核对独立 CI

STATUS/RELEASE 写入功能、130/563 和构建声明时保留 offline reviewer 限定，同时核对目标 SHA 的实际 CI，而不能把文档声明复制成 CI 执行。后续 cwd 隔离修复只能作为 后续证据，发布记录还应避免把旧章节工具数变化当作历史重跑。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 工作目录内或 Read allow 规则的 updatedInput 形状错配会使文件评审丢失 artifact_path 和 focus/context，直接函数测试无法发现；Fallback 单次 Yes 回传原输入，不能把所有权限分支一概而论。
- 全局 setCwdState 在异步测试间串扰，目标 CI 已出现读取其他临时目录的失败；后代隔离不能改变目标结果。
- 模型可在没有 verification 的情况下自报 verified，或受 artifact 内指令影响；结构校验不等于事实核验。
- lstat 与 readFile 分离导致大小和文件类型竞态，1 MB 限制不是整个读取过程的严格不变量。
- JSON 首末括号提取会接受提示要求之外的包裹文本，artifact 自身含大括号时仍需由完整 JSON/Zod 解析兜底。

## 验收顺序

1. 运行输入矩阵，覆盖空、双来源、空 content、内联多字节大小、普通文件、目录、symlink 和超限文件。
2. 用真实 executor 分别走 FileRead allow/ask/deny，断言 call 收到 artifact_path/focus/context，而非仅直接调用 reviewArtifact。
3. 注入可控 runner 检查独立 prompt、Read/Grep/Glob、空响应、末段文本、无效 JSON、严重级别和默认 unverified。
4. 隔离 cwd 后运行五个新增测试及全量套件，并单独核对目标/后续 GitHub Actions 的 Test、Build 和 smoke 步骤。
5. 构建特性档核对 38 个非空工具、ReviewArtifact 和 hunter；不把该结果提升为真实 reviewer 质量证明。
6. 在授权环境执行真实 /hunter 与 ReviewArtifact，记录实际权限、工具调用、修改检查结果和未验证发现。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- 严格来源输入、内联/文件读取、1 MB 预检和结构化 reviewer 输出已经落入实现。
- 独立 promptMessages、Read/Grep/Glob 候选池、runAgent 和 FileRead/Fallback 委托代码已经接通。
- /hunter、REVIEW_ARTIFACT、38 工具特性档及五个离线测试已经加入。
- STATUS/RELEASE 的历史命令声明、目标 CI 失败和后代 cwd 修复已经在本记录中分层，不再统称通过。

### 未完成或后续工作

- FileRead 自动 allow 的 updatedInput 到 ReviewArtifact.call 的字段兼容尚未完成，文件权限端到端路径不能视为已实现验收；无路径参数的 ReviewArtifact 持久 allow 范围也需收敛。
- 目标 CI 一测试失败且 Build/CLI/SDK smoke 被跳过，真实 defaultReviewer 与 /hunter 在线评审也无记录。
- verified 证据约束、提示注入防护和读取竞态仍需后续工程与独立验证。
