---
id: help-feedback
batch: 5
title: Help & Feedback 帮助、提示与用户反馈设计
date: 2026-11-12
status: draft
---

# Help & Feedback 帮助、提示与用户反馈设计

## 1. 问题与约束

Help & Feedback 系统需要解决以下核心问题与约束：

1. **用户发现功能**：帮助用户发现和学习可用命令和功能
2. **收集产品反馈**：收集用户满意度评分和详细问题报告
3. **隐私保护**：默认不共享敏感信息，共享前清理凭证
4. **不打扰用户**：反馈调查低概率随机出现，有冷却期
5. **上下文相关**：提示根据用户当前行为显示相关功能
6. **多语言考虑**：架构上需考虑未来多语言支持
7. **组织策略控制**：允许组织禁用反馈功能

## 2. 设计理由与备选方案

### 2.1 使用数字键进行调查响应

- **备选方案**：
  - 上/下箭头选择：终端标准，但无法区分用户打字 vs 选择
  - y/n/f 字母：语义清晰，但与正常输入冲突
  - 完整选择器：灵活，但打断用户流
  - 无 UI，仅分析：无打扰，但丢失定性反馈
- **选择理由**：避免与正常输入混淆（输入验证通过 `isValidResponseInput()`），减少用户记忆负担（1=好、2=中、3=差是直观顺序），实现简单，无需复杂选择 UI
- **证据**：实现中 `useDebouncedDigitInput` 专门处理数字输入，防抖防止误触，同时在用户输入非数字时隐藏调查

### 2.2 调查采用低概率随机触发

- **备选方案**：
  - 每次会话显示：样本多，但打扰严重
  - 仅在错误时显示：针对性强，但错过正面反馈
  - 用户请求才显示：无打扰，但样本量少
- **选择理由**：避免频繁打扰用户，仍能收集足够样本量（1/200 会话），用户可通过 `/feedback` 主动提供反馈
- **参数选择**：
  - `minTimeBeforeFeedbackMs: 10 * 60 * 1000` - 10 分钟，用户已体验
  - `minTimeBetweenFeedbackMs: 60 * 60 * 1000` - 1 小时，不重复
  - `minTimeBetweenGlobalFeedbackMs: 27.7 * 60 * 60 * 1000` - ~27 小时，全局冷却
  - `minUserTurnsBeforeFeedback: 5` - 5 轮，有内容评价
  - `probability: 0.005` - 0.5%，低概率
- **证据**：配置通过 `useDynamicConfig` 可远程调整，无需发布新版本

### 2.3 转录共享作为第二步，非默认

- **备选方案**：
  - 一步同时请求：步骤少，但放弃率高
  - 默认共享，可选退出：数据多，但隐私问题
  - 永不请求：隐私好，但无详细数据
- **选择理由**：建立信任，先收集低敏感的评分，再请求高敏感的转录；降低摩擦，快速评分无需思考，大多数人会完成；隐私优先，需要明确的 "Yes" 选择
- **证据**：`shouldOfferTranscriptShare()` 使用独立概率控制（`tengu_bad/good_survey_transcript_ask_config`），可配置为 0 完全禁用

### 2.4 提示采用冷却 + 相关性双重过滤

- **备选方案**：
  - 固定顺序循环：可预测，但不适应用户进度
  - 纯随机：简单，但重复烦人
  - 全量显示：完整，但信息过载
- **选择理由**：避免重复显示相同提示，上下文相关提示更有价值，允许新用户看到入门提示，高级用户看到进阶提示
- **提示选择流程**：
  ```
  所有提示
    → filter by isRelevant(context)
      → filter by sessionsSinceLastShown >= cooldownSessions
        → 随机选择一个显示
  ```
- **证据**：`tipRegistry.ts` 中 50+ 提示，每个都有 `cooldownSessions` 和 `isRelevant()` 实现

### 2.5 LogoV2 双模式（Condensed/Full）

- **备选方案**：
  - 总是 Full：信息全，但启动慢
  - 总是 Condensed：启动快，但错过更新
  - 用户设置：灵活，但增加配置负担
- **选择理由**：新用户/新版本需要引导，老用户日常使用希望快速开始，平衡信息展示和启动速度
- **条件**：有新发布说明 +/或 项目引导 → Full；否则 → Condensed
- **证据**：`LogoV2.tsx` 中 `isCondensedMode` 逻辑，配合 `CLAUDE_CODE_FORCE_FULL_LOGO` 覆盖

### 2.6 敏感信息清理

- **备选方案**：
  - 不清理：简单，但高风险
  - 要求用户手动删除：安全，但体验差
  - 端到端加密：最安全，但复杂
- **选择理由**：自动清理常见凭证格式，用户仍可在提交前查看和编辑
- **清理内容**：
  - Anthropic API keys (sk-ant-*)
  - AWS credentials (AKIA*, AWS*)
  - Google Cloud keys (AIza*, service accounts)
  - Authorization headers/Bearer tokens
  - x-api-key headers
  - Environment variables with API/TOKEN/SECRET/PASSWORD

## 3. 目标与非目标

### 3.1 目标

1. **可发现性**：帮助用户通过 `/help`、提示和启动画面发现功能
2. **反馈收集**：收集用户满意度评分和详细问题报告
3. **隐私保护**：默认不共享敏感信息，共享前清理凭证
4. **低打扰**：反馈调查低概率随机出现，有冷却期
5. **上下文相关**：提示根据用户当前行为显示相关功能
6. **组织控制**：支持组织策略禁用反馈功能
7. **紧急通知**：支持推送时间敏感的安全或重要通知

### 3.2 非目标

1. **不进行 A/B 测试**：当前无实验框架
2. **不进行行为分析**：不追踪用户行为用于广告
3. **不提供实时聊天支持**：无客服集成
4. **不收集 PII**：除非用户主动提供，否则不收集个人身份信息
5. **不支持多语言**：当前仅英文，架构考虑但不实现

## 4. 架构、模块与数据流

### 4.1 核心模块

```
Help & Feedback 系统
├── HelpV2 - 帮助对话框
│   ├── General - 常规帮助信息
│   └── Commands - 命令浏览
├── FeedbackSurvey - 会话质量调查
│   ├── 评分选择
│   ├── 转录共享提示
│   └── 记忆调查集成
├── Feedback - 详细反馈/Bug 报告
├── Tips - 旋转提示系统
│   ├── 加载中提示
│   └── 上下文相关提示
├── LogoV2 - 启动屏幕
│   ├── WelcomeV2 - 欢迎界面
│   ├── Feed - 最近活动/更新
│   └── EmergencyTip - 紧急通知
├── Passes - 访客通行证
└── ReleaseNotes - 版本说明
```

### 4.2 组件关系

- **HelpV2** 通过 `/help` 命令触发，展示快捷键和命令列表
- **FeedbackSurvey** 在会话中随机出现，收集快速质量评分
- **Feedback** 通过 `/feedback`（或 `/issue`）触发，收集详细报告
- **Tips** 在 LLM 思考时展示，帮助用户发现功能
- **LogoV2** 在会话启动时展示，包含版本信息和更新
- **EmergencyTip** 用于推送时间敏感的安全或重要通知

### 4.3 帮助内容组织

HelpV2 组件采用标签页结构组织内容：
- **General 标签页**：产品概述、快捷键列表
- **Commands 标签页**：内建命令列表（去重排序）
- **Custom Commands 标签页**：用户自定义技能列表
- **[ant-only] 标签页**：内部命令（仅 Anthropic 用户）

### 4.4 反馈调查状态机

```
closed → open → [good/bad/fine] → [transcript_prompt?] → [thanks]
        ↑
        概率触发
```

### 4.5 反馈提交流程

```
用户发起 /feedback
  ↓
显示表单（描述、可选转录、可选 Git 状态）
  ↓
用户提交
  ↓
敏感信息清理（redactSensitiveInfo）
  ↓
发送反馈 API
  ↓
成功 → 显示感谢；失败 → 显示错误，保留内容可重试
```

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 失败场景 | 处理方式 | 用户可见效果 |
|---------|---------|-------------|
| 策略拒绝反馈 | 静默关闭，无 UI 变化 | 无调查出现 |
| 网络错误（反馈提交） | 不重试，下次符合条件再尝试 | 显示错误，保留内容可重试 |
| 用户输入冲突 | 检测到用户打字时隐藏调查 | 调查自动消失 |
| 转录共享失败 | 显示感谢，不重试 | 显示感谢 |
| 命令加载失败（Help） | 显示可用命令的子集 | 部分命令可能缺失 |
| 终端太窄（Help） | 截断长描述 | 描述被截断 |
| 403 ZDR 组织 | 显示特定消息，禁用提交 | 提示组织策略禁用 |
| 401 认证失败 | 刷新 token 后重试一次 | 透明重试 |
| 标题生成失败 | 使用 fallback 标题 | 标题可能不完美 |
| GitHub URL 过长 | 智能截断，保留错误日志 | 部分日志可能被截断 |
| 提示注册表返回空 | 显示通用提示 | 提示可能不太相关 |
| 自定义提示解析失败 | 回退到内建提示 | 使用默认提示 |
| 上下文检测失败 | 跳过相关性检查 | 提示可能不太相关 |

### 5.2 工程取舍

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 调查交互 | 数字键 1/2/3 | 可能误触单独数字 | 简单，不打断用户流 |
| 触发概率 | 0.5% + 多层冷却 | 样本收集慢 | 用户体验好 |
| 转录共享 | 第二步，非默认 | 放弃率较高 | 建立信任，隐私优先 |
| 提示选择 | 冷却 + 相关性 | 选择逻辑复杂 | 适时显示合适提示 |
| Logo 模式 | Condensed/Full 自动切换 | 逻辑稍复杂 | 平衡信息与速度 |
| 敏感清理 | 正则匹配常见格式 | 新格式可能遗漏 | 覆盖大多数情况 |
| 远程配置 | useDynamicConfig | 依赖网络 | 无需发布调整参数 |

## 6. 现状验收标准

### 6.1 功能验收标准

- **Help 系统**：
  - `/help` 命令显示帮助对话框
  - General 标签页显示产品概述和快捷键
  - Commands 标签页显示内建命令列表，去重排序
  - Custom Commands 标签页显示用户自定义技能
  - [ant-only] 标签页仅对 Anthropic 用户可见
  - 终端太窄时截断长描述

- **Feedback Survey**：
  - 满足所有条件时概率显示（会话时间 ≥10 分钟、用户轮次 ≥5、冷却期已过、全局冷却已过、概率 ≤0.5%、模型在列表中、未禁用、策略允许、无活跃提示框、未加载中）
  - 数字键 1/2/3 响应评分（1=Good、2=Fine、3=Bad）
  - 评分后（Good/Bad）询问是否共享转录
  - 用户可选择 "Don't ask again"
  - 用户输入非数字时隐藏调查
  - ZDR 组织无法提交反馈
  - 环境变量 `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` 完全禁用

- **Feedback 命令**：
  - `/feedback`（或 `/issue`）显示反馈表单
  - 提交前清理敏感信息
  - 网络超时（30 秒）显示错误，保留内容可重试
  - 401 认证失败刷新 token 后重试一次
  - GitHub Issue URL 过长时智能截断

- **Tips 系统**：
  - LLM 思考时显示旋转提示
  - 提示通过 `isRelevant(context)` 过滤
  - 提示有 `cooldownSessions` 冷却期
  - 用户可通过 `spinnerTipsOverride` 自定义
  - 自定义提示解析失败回退到内建提示

- **LogoV2**：
  - 有新发布说明 +/或 项目引导 → Full 模式
  - 否则 → Condensed 模式
  - `CLAUDE_CODE_FORCE_FULL_LOGO` 覆盖
  - 窄终端（<80 列）→ Compact 模式
  - 显示版本信息、当前模型、Git 状态

- **Release Notes**：
  - `/release-notes` 显示最新变更日志
  - 尝试从 `CHANGELOG_URL` 获取
  - 500ms 超时后回退到缓存版本
  - 失败时提供 GitHub 链接

- **EmergencyTip**：
  - 来自动态配置 `tengu-top-of-feed-tip`
  - 支持颜色（dim/warning/error）
  - 每个提示只显示一次（通过 `lastShownEmergencyTip` 追踪）
  - 在 LogoV2 后展示

## 7. 代码与测试证据

### 7.1 核心实现文件

- **HelpV2**：
  - `src/components/HelpV2.tsx` - 主帮助对话框
  - `src/components/help/General.tsx` - 常规帮助
  - `src/components/help/Commands.tsx` - 命令列表

- **FeedbackSurvey**：
  - `src/components/FeedbackSurvey.tsx` - 调查组件
  - `src/hooks/useFeedbackSurvey.ts` - 调查逻辑
  - `src/hooks/useDebouncedDigitInput.ts` - 数字输入处理
  - `src/utils/feedback-survey-config.ts` - 配置与条件

- **Feedback**：
  - `src/commands/feedback/index.tsx` - `/feedback` 命令
  - `src/utils/redact-sensitive-info.ts` - 敏感信息清理
  - `src/utils/github-issue-url.ts` - GitHub Issue URL 生成

- **Tips**：
  - `src/components/Tips.tsx` - 提示显示
  - `src/tipRegistry.ts` - 提示注册表（50+ 提示）
  - `src/hooks/useTip.ts` - 提示选择逻辑

- **LogoV2**：
  - `src/components/LogoV2.tsx` - 启动画面
  - `src/components/WelcomeV2.tsx` - 欢迎界面
  - `src/components/Feed.tsx` - 更新/活动流
  - `src/components/EmergencyTip.tsx` - 紧急通知

- **ReleaseNotes**：
  - `src/commands/release-notes/index.tsx` - `/release-notes` 命令
  - `src/utils/release-notes.ts` - 变更日志加载

### 7.2 测试覆盖

现有测试覆盖：
- 反馈调查显示逻辑
- 敏感信息清理
- 数字输入处理
- 帮助命令功能

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/help-feedback.yaml)

### 8.1 相关子系统

- **Commands Framework**：`/help`、`/feedback`、`/release-notes` 等命令通过本框架实现
- **Settings System**：`spinnerTipsOverride` 等设置
- **Dynamic Config**：`useDynamicConfig` 用于远程调整调查参数、紧急通知
- **Session System**：会话元数据用于调查显示条件
- **Git Integration**：Git 状态可包含在反馈中
- **Telemetry**：反馈提交可能关联遥测（如果启用）

## 9. 改进建议

### 9.1 短期改进

1. **调查反馈与行动关联**：评分后标记该消息 ID，用于微调或提示工程，形成反馈闭环
2. **提示有效性测量**：添加机制测量提示是否实际引导用户尝试功能，优化提示选择
3. **更多敏感格式**：扩展 `redactSensitiveInfo` 覆盖更多凭证格式（Azure、OpenAI、本地数据库等）

### 9.2 中期改进

4. **多语言支持**：添加 i18n 框架，支持英文以外语言
5. **提示用户编辑**：反馈提交前让用户明确看到清理后的内容，并可编辑
6. **反馈分类**：让用户选择反馈类型（Bug、Feature Request、Usage Question、Other）
7. **更丰富提示**：添加 GIF/动画提示（终端支持时），或更详细的示例

### 9.3 长期改进

8. **功能引导教程**：交互式教程引导用户完成常见任务
9. **反馈仪表板**：内部仪表板可视化反馈趋势和热点问题
10. **社区知识库**：常见问题和解决方案的可搜索知识库
11. **个性化提示**：基于用户历史行为的个性化提示排序
