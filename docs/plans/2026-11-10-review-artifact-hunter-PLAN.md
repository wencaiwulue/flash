---
commit: 0b6806800508a15c7a5f8293c572b8fa5c960d24
title: ReviewArtifact 与 Hunter 的实施顺序
date: 2026-11-10
retrospective: true
---

# ReviewArtifact 与 Hunter 的实施顺序

## 1. 实现输入校验与只读加载

**文件：** `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts`。

validateInput 用两个 undefined 的相等关系拒绝“都提供/都不提供”。checkPermissions 对 artifact_path 复用 FileReadTool；readArtifact 对 inline 和文件分别检查 1 MB，并用 lstat 拒绝非普通文件。

**测试：** `tests/reviewArtifact.test.ts` 先覆盖互斥输入、临时文件和超限内容。

## 2. 实现独立 reviewer 与结构化输出

defaultReviewer 动态加载 runAgent、GENERAL_PURPOSE_AGENT 和 asSystemPrompt，availableTools 只过滤 Read/Grep/Glob。promptMessages 只有评审请求，override systemPrompt 要求独立、只读、只报告有依据问题，maxTurns 为 8。

reviewArtifact 构造包含 focus/context/artifact 的固定 JSON-only prompt，runner 可注入。parseReviewerOutput 提取最外层 JSON 文本并用 reviewerOutputSchema.parse，status 默认 unverified，最后附加统一的完成 message。

**测试：** 注入 runner，检查 prompt 包含 artifact 与 requirements、finding status、空 findings、无 JSON、非法字段和空响应。

## 3. 注册 Hunter 技能

**文件：** `src/skills/bundled/hunter.ts`。

使用 registerBundledSkill 注册 name=hunter、userInvocable=true 和独立评审描述。prompt 要求先收集 artifact 与 intended behavior，再调用 ReviewArtifact，区分 verified 与 unverified，并说明聚焦验证的实际范围。

**测试：** 注册后从 getBundledSkills 查找 hunter，断言 prompt 包含 ReviewArtifact 和 unverified。

## 4. 接入工具池与 feature

`src/tools.ts` 注册 ReviewArtifact，`scripts/build.ts` 只添加 `REVIEW_ARTIFACT`，feature fixture 同时检查工具和 hunter。

```bash
bun test tests/reviewArtifact.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除技能和工具注册，再回滚 reviewer；不得提供 Write/Bash 工具、放宽 JSON schema，或把未验证 concern 自动升级为 blocker。
