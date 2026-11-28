---
id: upstream-config-b5-independent-features
batch: 5
title: B5：独立功能子项目对齐设计
date: 2026-11-16
status: draft
---

# B5：独立功能子项目对齐设计

本文实现全量配置对齐路线的 B5：独立功能子项目（model 环境变量、fast mode、feedback survey、subagent model、artifact、auto mode 等）的来源、默认值与运行时读取对齐。基线为上游 Claude Code **2.1.311**（npm stable）。工作统一在 PR wencaiwulue/flash#17（保持 Draft），批次间不独立合并。

## 1. 问题与约束

矩阵 `fixtures/upstream-config/2.1.311/compatibility.yaml` 中 `ownerBatch: 5` 共 **61 条 = 9 setting + 52 env**，初始 56 missing + 1 partial + 4 excluded，无 aligned。上游证据在 `inventory.json`（env 条目的 `types`/`default`/`scopes` 多为空，语义在 `excerpt`/`precedence`）。

B5 条目围绕若干独立功能：model picker 自定义（`ANTHROPIC_DEFAULT_*_MODEL[_NAME|_DESCRIPTION]`、`ANTHROPIC_CUSTOM_MODEL_OPTION*`）、全局/subagent model（`ANTHROPIC_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`）、fast mode、feedback survey、artifact、auto mode。其中 model/feedback/fast-mode 多数 env flash 已有运行时读取（`process.env.X`），可对齐；artifact、部分 auto mode、`SUPPORTED_CAPABILITIES` 等为功能缺口。

约束：每条对齐六维度并记录证据；按 2026-11-23 用户指令"先完成 B1 到 B5，太难的先记下来跳过"，未实现子系统的 missing 条目记录功能缺口，不实现。

## 2. 设计理由与备选方案

沿用六维度工作法。对 B5 的 61 条，评估两种口径：
- **A. 全量实现 56 条 missing**：需先实现 artifact、auto mode server、model capabilities、sync plugins/skills 等子系统，违反"太难先跳过"指令。
- **B. 对齐已有运行时读取的 22 条 + 记录剩余 missing 功能缺口**（采用）：把已有 `process.env.X` 读取的 21 条 env + feedbackSurveyRate（1 partial）标为 aligned；其余 35 条 missing 按子系统记录功能缺口，难项跳过。

## 3. 目标与非目标

**目标**：
- 22 条（21 env + feedbackSurveyRate）对齐六维度并标 aligned。
- 35 条 missing 按子系统记录功能缺口（§9）。
- 4 条 excluded 保持（disableArtifact、ANTHROPIC_SMALL_FAST_MODEL、两个 fast-mode override）。

**非目标**：
- 不实现 artifact、auto mode server、model capabilities、sync plugins/skills 子系统。
- 不追求 B5 全量 aligned。

## 4. 架构、模块与数据流

本轮对齐的 22 条均为"环境变量/settings → 运行时读取"路径：

- **model picker env** → `src/utils/model/modelOptions.ts`（`getCustomOpusOption`/`getCustomSonnetOption`/haiku 对应函数读 `ANTHROPIC_DEFAULT_*_MODEL[_NAME|_DESCRIPTION]`；`getModelOptions` 读 `ANTHROPIC_CUSTOM_MODEL_OPTION*` 并 push 自定义条目）。
- **全局/subagent model** → `src/main.tsx:2998`（`ANTHROPIC_MODEL`）、`src/utils/model/agent.ts:43`（`CLAUDE_CODE_SUBAGENT_MODEL`）。
- **fast mode env** → `src/utils/fastMode.ts`（`isFastModeEnabled`、可用性检查）。
- **feedback env/setting** → `useMemorySurvey.tsx`、`feedbackAvailability.ts`、`useFeedbackSurvey.tsx:88`。
- **其他** → `src/services/api/client.ts`（region）、`src/utils/permissions/yoloClassifier.ts`（auto mode classifier model）、`src/utils/model/model.ts`（legacy remap）。

### 决策表（22 条 aligned，分组）

| 组 | key | default | precedence | runtime | 证据 |
| --- | --- | --- | --- | --- | --- |
| model picker | ANTHROPIC_DEFAULT_OPUS_MODEL / SONNET / HAIKU（3） | unset | env 覆盖内置 alias 解析 | modelOptions.ts getCustom*Option（3P 时 alias 解析） | `modelOptions.ts` |
| model picker | ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL_NAME（3） | unset（显示识别名或 ID） | env 覆盖显示名 | modelOptions.ts label=NAME ?? customModel | `modelOptions.ts` |
| model picker | ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL_DESCRIPTION（3） | unset（默认 Custom X model...） | env 覆盖描述 | modelOptions.ts description=DESC ?? 默认 | `modelOptions.ts` |
| model picker | ANTHROPIC_CUSTOM_MODEL_OPTION（+NAME+DESCRIPTION，3） | unset | env 添加自定义条目（不替换内置 alias） | getModelOptions:481 push 自定义条目；tests/b5 验证 | `modelOptions.ts` |
| 全局 model | ANTHROPIC_MODEL | unset | options.model 优先于 env | main.tsx:2998 explicitModel=options.model \|\| env | `main.tsx` |
| subagent | CLAUDE_CODE_SUBAGENT_MODEL | unset | env 优先 | agent.ts:43 return parseUserSpecifiedModel(env) | `agent.ts` |
| model | CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP | unset（默认 remap） | env=1 禁用 | model.ts 读 env（Bedrock/GCP/Azure 不 remap） | `model.ts` |
| region | ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION | unset | env 覆盖 Haiku region | client.ts 读 env（Bedrock/Mantle） | `client.ts` |
| auto mode | CLAUDE_CODE_AUTO_MODE_MODEL | unset | env 设 classifier model | yoloClassifier.ts 读 env | `yoloClassifier.ts` |
| feedback | CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY | unset（默认启用） | env=1 禁用 | useMemorySurvey.tsx 读 env | `useMemorySurvey.tsx` |
| feedback | DISABLE_FEEDBACK_COMMAND | unset（默认启用） | env=1 禁用 /feedback /bug /share | feedbackAvailability.ts 读 env | `feedbackAvailability.ts` |
| feedback | feedbackSurveyRate（setting） | unset | settings 文件 | useFeedbackSurvey.tsx:88 getInitialSettings().feedbackSurveyRate | `useFeedbackSurvey.tsx` |
| fast mode | CLAUDE_CODE_DISABLE_FAST_MODE | unset（默认启用） | env=1 禁用 | fastMode.ts:39 isFastModeEnabled()=!isEnvTruthy(env)；tests/b5 验证 | `fastMode.ts` |
| fast mode | CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS | unset | env=1 检查失败视为可用 | fastMode.ts:128 读 env（仍 honor org disabled） | `fastMode.ts` |

上游证据均为 `inventory.json` 对应条目（excerpt + precedence）。

## 5. 失败语义与工程取舍

- **model picker env**：未设时回退默认显示（识别的名称/ID、默认描述），非安全敏感。
- **fast mode**：`CLAUDE_CODE_DISABLE_FAST_MODE=1` 禁用；`SKIP_FAST_MODE_NETWORK_ERRORS=1` 仅跳过网络检查失败，仍 honor org disabled（不绕过组织禁用）。
- **feedback**：disable 类 env=1 禁用 survey//feedback，与 `DISABLE_TELEMETRY`/`DO_NOT_TRACK` 等一致。
- **35 条 missing**：记录功能缺口而非对齐，避免"仅 schema 对齐"被误判为完成。

## 6. 现状验收标准

- 22 条标 aligned，六维 evidence 完整，implementation/tests/spec 引用齐全。
- `--batch 5` 0 诊断；`check-design-docs.ts` 无 error；`typecheck` 通过。
- env aligned：2 → 23（+21）；setting aligned：66 → 67（+1）。

## 7. 代码与测试证据

- `src/utils/model/modelOptions.ts`（model picker env 读取）
- `src/main.tsx`（ANTHROPIC_MODEL）、`src/utils/model/agent.ts`（SUBAGENT_MODEL）、`src/utils/model/model.ts`（legacy remap）
- `src/utils/fastMode.ts`（fast-mode env）
- `src/services/api/client.ts`（region）、`src/utils/permissions/yoloClassifier.ts`（auto mode model）
- `src/components/FeedbackSurvey/useMemorySurvey.tsx`、`src/commands/feedback/feedbackAvailability.ts`、`src/components/FeedbackSurvey/useFeedbackSurvey.tsx`（feedback）
- `src/utils/settings/types.ts`（feedbackSurveyRate zod）
- `tests/b5ModelEnvSettings.test.ts`：4 用例全过
  - feedbackSurveyRate 接受 number、拒绝 string
  - isFastModeEnabled 随 CLAUDE_CODE_DISABLE_FAST_MODE 切换
  - getModelOptions 添加 ANTHROPIC_CUSTOM_MODEL_OPTION（NAME/DESCRIPTION）
  - NAME/DESCRIPTION 未设时回退默认（label=model ID、description=Custom model (<id>)）

## 8. 文件覆盖与相关子系统

coverage：[upstream-config-b5-independent-features.yaml](../../architecture/coverage/upstream-config-b5-independent-features.yaml)。运行时代码主归属由 model、fastMode、FeedbackSurvey、settings 等既有 coverage 维护，本 spec 不重复拥有文件。相关子系统：model（picker/alias/subagent）、fastMode、feedback、settings。

## 9. 改进建议

按"太难先记下来跳过"，以下难项本轮跳过，仅记录功能缺口（35 条 missing）。后续若实现对应子系统，应各立独立 spec 并回填本矩阵 missing 条目。

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P3 | artifact 子系统未实现（enableArtifact + CLAUDE_CODE_ARTIFACT_AUTO_OPEN/COMMENTS/COMMENTS_AUTOREACT/PUBLISH_EDITS/DISABLE_ARTIFACT 共 6 条） | 立 artifact spec，实现 artifact 发布/评论/自动打开后回填 | 中 | artifact 行为测试 | L | 设计推断 |
| P3 | model SUPPORTED_CAPABILITIES 未实现（ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL_SUPPORTED_CAPABILITIES + ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES 共 5 条） | 实现 model capabilities 覆盖（影响 1M context/能力标注）后回填 | 中 | capabilities 行为测试 | M | 设计推断 |
| P3 | FABLE model env 未实现（ANTHROPIC_DEFAULT_FABLE_MODEL + NAME + DESCRIPTION 共 3 条；FABLE 系列） | 随 FABLE model 上线补 model picker 支持后回填 | 低 | FABLE picker 行为测试 | M | 设计推断 |
| P3 | auto mode server/enable 未实现（CLAUDE_CODE_AUTO_MODE_SERVER、CLAUDE_CODE_ENABLE_AUTO_MODE） | 实现 auto mode server/classifier 开关后回填 | 中 | auto mode 行为测试 | M | 设计推断 |
| P3 | model access/remap 其他 env 未实现（ANTHROPIC_DEFAULT_MODEL、CLAUDE_CODE_SUBAGENT_MODEL_FORCE、CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK、CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT、CLAUDE_CODE_SKIP_MODEL_ACCESS_MEMORY、CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK） | 实现对应 model access/window/subagent force/org check 后回填 | 中 | model access 行为测试 | M | 设计推断 |
| P3 | feedback 其他 env 未实现（CLAUDE_CODE_SEND_FEEDBACK、CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL） | 实现 feedback 发送/OTEL survey 后回填 | 低 | feedback 行为测试 | S | 设计推断 |
| P3 | 其他独立功能 env 未实现（CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS、CLAUDE_CODE_EXPERIMENTAL_CODE_MODE、CLAUDE_CODE_FORCE_SYNC_OUTPUT、CLAUDE_CODE_PERFORCE_MODE、CLAUDE_CODE_SAFE_MODE） | 实现对应 async agent/code mode/sync output/perforce/safe mode 后回填 | 中 | 各功能行为测试 | M | 设计推断 |
| P3 | setting 功能缺口（autoContinueAtUsageLimit、dialogExpiry、feedbackDrafts、switchModelsOnFlag、syncClaudeAiPlugins、syncClaudeAiSkills 共 6 条） | 实现 usage-limit 续跑/dialog 过期/feedback 草稿/flag 切 model/同步 plugins+skills 后回填 | 中 | 各 setting 行为测试 | M | 设计推断 |

## 10. 实现状态（2026-11-16）

- 22 条标 aligned（21 env + feedbackSurveyRate）：model picker env（12）、全局/subagent model（2）、legacy remap（1）、region（1）、auto mode model（1）、feedback（2 env + 1 setting）、fast mode（2）。
- 35 条 missing 分类记录功能缺口（§9），难项跳过。
- 4 条 excluded 保持。
- `tests/b5ModelEnvSettings.test.ts` 4 用例全过；`--batch 5` 0 诊断；design-docs 无 error；typecheck 通过。
- env aligned：2 → 23（+21）；setting aligned：66 → 67（+1）。
