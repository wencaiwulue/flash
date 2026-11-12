---
id: help-feedback
title: Help & Feedback 帮助、提示与用户反馈设计
status: draft
---

## 1. 概述

Claude Code 的帮助与反馈系统提供多种用户支持渠道：内联帮助命令、上下文提示、版本信息展示、反馈调查和 Bug 报告功能。这些组件共同构成用户发现功能、解决问题和提供产品改进建议的核心机制。

## 2. 架构

帮助与反馈系统分为几个主要模块：

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

### 2.1 组件关系

- **HelpV2** 通过 `/help` 命令触发，展示快捷键和命令列表
- **FeedbackSurvey** 在会话中随机出现，收集快速质量评分
- **Feedback** 通过 `/feedback`（或 `/issue`）触发，收集详细报告
- **Tips** 在 LLM 思考时展示，帮助用户发现功能
- **LogoV2** 在会话启动时展示，包含版本信息和更新
- **EmergencyTip** 用于推送时间敏感的安全或重要通知

## 3. 帮助内容组织

### 3.1 帮助对话框结构

HelpV2 组件采用标签页结构组织内容：

- **General 标签页**：产品概述、快捷键列表
- **Commands 标签页**：内建命令列表（去重排序）
- **Custom Commands 标签页**：用户自定义技能列表
- **[ant-only] 标签页**：内部命令（仅 Anthropic 用户）

### 3.2 内容来源

帮助内容来自几个地方：

1. **静态提示**：`General` 组件中的产品描述和快捷键
2. **命令注册表**：通过 `builtInCommandNames()` 获取内建命令
3. **用户配置**：从 `customCommands` 目录加载自定义技能
4. **动态过滤**：根据 `process.env.USER_TYPE` 过滤可见命令

### 3.3 命令展示格式

每个命令条目显示为：

```
/<命令名> - <描述> [来自 <源>]
```

- 按字母排序
- 自定义命令去重（同名只显示一个）
- 来源标记用户级/项目级
- 终端宽度适配截断

## 4. 反馈采集与隐私

### 4.1 调查流程

反馈调查有三种类型：

| 类型 | 触发时机 | 问题 |
|------|---------|------|
| session | 会话期间随机 | How was that response? (1-3) |
| memory | 记忆操作后 | How did memory work? |
| post_compact | 压缩操作后 | How was the compact? |

状态机：

```
closed → open → [good/bad/fine] → [transcript_prompt?] → [thanks]
         ↑
         概率触发
```

### 4.2 隐私控制

关键隐私机制：

1. **组织策略**：`isPolicyAllowed('allow_product_feedback')` 控制是否启用
2. **环境禁用**：`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` 完全禁用
3. **数据保留**：ZDR（自定义数据保留）组织无法提交反馈
4. **用户选择**：转录共享需要明确同意
5. **不要再次询问**：用户可选择 `transcriptShareDismissed`

### 4.3 敏感信息清理

提交反馈前会清理以下内容：

```typescript
// redactSensitiveInfo() 处理
- Anthropic API keys (sk-ant-*)
- AWS credentials (AKIA*, AWS*)
- Google Cloud keys (AIza*, service accounts)
- Authorization headers/Bearer tokens
- x-api-key headers
- Environment variables with API/TOKEN/SECRET/PASSWORD
```

清理在提交前进行，敏感数据不会离开用户设备。

### 4.4 反馈数据结构

提交的反馈包含：

| 字段 | 说明 | 隐私状态 |
|------|------|---------|
| latestAssistantMessageId | 最后消息 ID | 匿名化 |
| message_count | 消息数量 | 匿名 |
| datetime | 提交时间 | 匿名 |
| description | 用户描述 | 用户提供 |
| platform | 平台 | 匿名 |
| terminal | 终端类型 | 匿名 |
| version | 版本 | 匿名 |
| transcript | 会话转录 | 需要同意 |
| errors | 错误日志 | 已清理 |
| gitRepo | 是否 Git 仓库 | 匿名 |
| gitState | Git 状态（可选） | 用户可查看 |
| subagentTranscripts | 子代理转录 | 需要同意 |
| rawTranscriptJsonl | 原始转录 | 需要同意 |

## 5. 提示与调查时机

### 5.1 反馈调查显示条件

调查需要满足所有条件才会出现：

```typescript
shouldOpen() {
  // 会话条件
  - 会话已启动 ≥ minTimeBeforeFeedbackMs (默认 10 分钟)
  - 用户已提交 ≥ minUserTurnsBeforeFeedback 轮次 (默认 5 轮)
  - 距离上次出现 ≥ minTimeBetweenFeedbackMs (默认 1 小时)
  - 距离上次出现 ≥ minUserTurnsBetweenFeedback 轮次 (默认 10 轮)
  
  // 全局条件
  - 距离全局上次出现 ≥ minTimeBetweenGlobalFeedbackMs (默认 ~27 小时)
  
  // 概率
  - Math.random() ≤ probability (默认 0.5%)
  
  // 功能门控
  - 模型在 onForModels 列表
  - 未被环境变量禁用
  - 未被分析配置禁用
  - 组织策略允许
  - 无活跃提示框
  - 未在加载中
}
```

### 5.2 提示显示时机

旋转提示（Spinner Tips）在 LLM 思考时展示：

- **提示选择**：从 `tipRegistry` 中筛选相关提示
- **冷却**：每个提示有 `cooldownSessions` 会话冷却期
- **相关性检查**：每个提示有 `isRelevant()` 谓词
- **自定义覆盖**：用户可通过 `spinnerTipsOverride` 自定义

### 5.3 紧急通知

EmergencyTip 用于时间敏感通知：

- 来自动态配置 `tengu-top-of-feed-tip`
- 支持颜色（dim/warning/error）
- 每个提示只显示一次（通过 `lastShownEmergencyTip` 追踪）
- 在 LogoV2 后展示

## 6. 版本信息展示

### 6.1 LogoV2 展示模式

LogoV2 有三种显示模式：

| 模式 | 条件 | 内容 |
|------|------|------|
| Condensed | 无发布说明 + 无项目引导 | 简单欢迎 + 版本 + 模型 |
| Compact | 窄终端（< 80 列） | 水平压缩布局 |
| Full | 新发布说明 +/或 项目引导 | 双列布局 + Feed |

### 6.2 信息展示区域

左面板（Full 模式）：

```
┌───────────────────────────────────────────────────────────┐
│ Claude Code vX.Y.Z                                         │
├───────────────────────────────────────────────────────────┤
│  Welcome to Claude Code                                    │
│                                                           │
│        █████████                                          │
│        ██▄█████▄██                                        │
│        █████████                                          │
│        █ █   █ █                                          │
│                                                           │
│  Model: Claude 3.5 Sonnet · Pro                           │
│  @agent-name · ~/project/path (truncated)                │
└───────────────────────────────────────────────────────────┘
```

右面板（Feed）：

- **最近活动**：文件、分支等上下文提示
- **新功能**：最近版本的更新说明（来自 `CHANGELOG_URL`）
- **项目引导**：新用户入门步骤
- **访客通行证**：分享计划提示
- **超额积分**：额外使用量提示

### 6.3 版本信息来源

版本信息从几个地方获取：

```typescript
// 构建时注入
MACRO.VERSION        // 版本字符串
MACRO.CHANGELOG      // 变更日志（可选）

// 运行时获取
getMainLoopModel()   // 当前模型
getGitState()        // Git 分支/提交
```

### 6.4 ReleaseNotes 命令

`/release-notes` 命令：

- 尝试从 `CHANGELOG_URL` 获取最新变更日志
- 500ms 超时后回退到缓存版本
- 格式化显示最近版本的要点
- 失败时提供 GitHub 链接

## 7. 错误与降级

### 7.1 调查降级路径

调查失败的安全处理：

1. **策略拒绝** → 静默关闭，无 UI 变化
2. **网络错误** → 不重试，下次符合条件再尝试
3. **用户输入冲突** → 检测到用户打字时隐藏调查
4. **转录共享失败** → 显示感谢，不重试

### 7.2 帮助系统降级

帮助命令降级：

1. **命令加载失败** → 显示可用命令的子集
2. **终端太窄** → 截断长描述
3. **重复自定义命令** → 按名称去重

### 7.3 反馈提交降级

反馈失败处理：

| 错误 | 处理 |
|------|------|
| 网络超时（30s） | 显示错误，保留内容可重试 |
| 403 ZDR 组织 | 显示特定消息，禁用提交 |
| 401 认证失败 | 刷新 token 后重试一次 |
| 标题生成失败 | 使用 fallback 标题 |
| GitHub URL 过长 | 智能截断，保留错误日志 |

### 7.4 提示系统降级

提示加载失败：

- 提示注册表返回空数组 → 显示通用提示
- 自定义提示解析失败 → 回退到内建提示
- 上下文检测失败 → 跳过相关性检查

## 8. 设计决策与替代方案

### 8.1 决策 1：使用数字键进行调查响应

**决策**：使用 1/2/3 数字键进行快速评分

| 选项 | 评分 |
|------|------|
| 1 | 👍 Good |
| 2 | 👌 Fine |
| 3 | 👎 Bad |

**原因**：

- 避免与正常输入混淆（输入验证通过 `isValidResponseInput()`）
- 减少用户记忆负担（1=好、2=中、3=差是直观顺序）
- 实现简单，无需复杂选择 UI

**替代方案**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 上/下箭头选择 | 终端标准 | 无法区分用户打字 vs 选择 |
| y/n/f 字母 | 语义清晰 | 与正常输入冲突 |
| 完整选择器 | 灵活 | 打断用户流 |
| 无 UI，仅分析 | 无打扰 | 丢失定性反馈 |

**证据**：实现中 `useDebouncedDigitInput` 专门处理数字输入，防抖防止误触，同时在用户输入非数字时隐藏调查。

### 8.2 决策 2：调查采用低概率随机触发

**决策**：默认 0.5% 概率显示调查，配合会话/全局冷却

**原因**：

- 避免频繁打扰用户
- 仍能收集足够样本量（1/200 会话）
- 用户可通过 `/feedback` 主动提供反馈

**替代方案**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 每次会话显示 | 样本多 | 打扰严重 |
| 仅在错误时显示 | 针对性强 | 错过正面反馈 |
| 用户请求才显示 | 无打扰 | 样本量少 |

**参数选择理由**：

```typescript
DEFAULT_FEEDBACK_SURVEY_CONFIG = {
  minTimeBeforeFeedbackMs: 10 * 60 * 1000,  // 10分钟 - 用户已体验
  minTimeBetweenFeedbackMs: 60 * 60 * 1000, // 1小时 - 不重复
  minTimeBetweenGlobalFeedbackMs: 27.7 * 60 * 60 * 1000, // ~1/27 天
  minUserTurnsBeforeFeedback: 5,            // 5轮 - 有内容评价
  minUserTurnsBetweenFeedback: 10,           // 间隔
  probability: 0.005,                        // 0.5% - 低概率
  onForModels: ['*']                         // 所有模型
}
```

**证据**：配置通过 `useDynamicConfig` 可远程调整，无需发布新版本。

### 8.3 决策 3：转录共享作为第二步，非默认

**决策**：评分后询问是否共享转录，默认不共享

**原因**：

- 建立信任：先收集低敏感的评分，再请求高敏感的转录
- 降低摩擦：快速评分无需思考，大多数人会完成
- 隐私优先：需要明确的 "Yes" 选择

**流程**：

```
1. How was that response? [1/2/3]
   ↓ 用户选择 (good/bad)
2. Can Anthropic look at your session transcript?
   [1] Yes  [2] No  [3] Don't ask again
```

**替代方案**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 一步同时请求 | 步骤少 | 放弃率高 |
| 默认共享，可选退出 | 数据多 | 隐私问题 |
| 永不请求 | 隐私好 | 无详细数据 |

**证据**：`shouldOfferTranscriptShare()` 使用独立概率控制（`tengu_bad/good_survey_transcript_ask_config`），可配置为 0 完全禁用。

### 8.4 决策 4：提示采用冷却 + 相关性双重过滤

**决策**：提示显示需要同时满足冷却期和相关性检查

**原因**：

- 避免重复显示相同提示
- 上下文相关提示更有价值
- 允许新用户看到入门提示，高级用户看到进阶提示

**提示选择流程**：

```
所有提示
  → filter by isRelevant(context)
    → filter by sessionsSinceLastShown >= cooldownSessions
      → 随机选择一个显示
```

**替代方案**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 固定顺序循环 | 可预测 | 不适应用户进度 |
| 纯随机 | 简单 | 重复烦人 |
| 全量显示 | 完整 | 信息过载 |

**证据**：`tipRegistry.ts` 中 50+ 提示，每个都有 `cooldownSessions` 和 `isRelevant()` 实现，覆盖新用户引导、功能发现、工作流建议等类别。

### 8.5 决策 5：LogoV2 双模式（Condensed/Full）

**决策**：根据是否有新内容切换显示模式

| 条件 | 模式 |
|------|------|
| 有新发布说明 +/或 项目引导 | Full |
| 无新内容 + 无强制标志 | Condensed |

**原因**：

- 新用户/新版本需要引导
- 老用户日常使用希望快速开始
- 平衡信息展示和启动速度

**替代方案**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 总是 Full | 信息全 | 启动慢 |
| 总是 Condensed | 启动快 | 错过更新 |
| 用户设置 | 灵活 | 增加配置负担 |

**证据**：`LogoV2.tsx` 中 `isCondensedMode` 逻辑，配合 `CLAUDE_CODE_FORCE_FULL_LOGO` 覆盖。

## 9. 开放问题与边界疑虑

### 9.1 开放问题

1. **调查反馈与行动的关联**：当前评分未关联到具体 LLM 响应改进
   - 可能方向：评分后标记该消息 ID，用于微调或提示工程

2. **提示有效性测量**：无机制测量提示是否实际引导用户尝试功能
   - 可能方向：提示显示后追踪相关命令使用率

3. **多语言支持**：当前帮助内容仅英文
   - 可能方向：按系统语言选择内容

### 9.2 边界疑虑

1. **调查输入与正常输入冲突**

   **风险**：用户打字时调查显示，数字被误识别为评分

   **缓解**：`isValidResponseInput()` 检查输入是否为有效数字，非数字时隐藏调查

   **剩余风险**：用户恰好输入单独 "1"/"2"/"3" 时可能误触

2. **敏感信息清理不完整**

   **风险**：新的密钥格式可能未被 `redactSensitiveInfo()` 覆盖

   **缓解**：
   - 清理逻辑有测试覆盖
   - 用户可在提交前查看内容
   - 反馈仅用于调试，不用于训练

   **剩余风险**：自定义环境变量名可能漏网

3. **GitHub Issue URL 截断**

   **风险**：长错误日志导致 URL 超过 GitHub 限制（7250 字符）

   **缓解**：`createGitHubIssueUrl()` 智能截断，优先保留描述

   **剩余风险**：截断后的错误日志可能不完整

4. **提示注册表膨胀**

   **风险**：持续添加新提示导致选择逻辑变慢

   **当前状态**：~50 提示，每次 `getRelevantTips()` 过滤

   **缓解**：提前过滤，并行执行 `isRelevant()` 检查

---

[Coverage](../../architecture/coverage/help-feedback.yaml)
