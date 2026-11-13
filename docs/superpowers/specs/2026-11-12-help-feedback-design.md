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

### 4.3 模块设计卡：HelpV2 帮助内容

#### 入口签名/关键类型

```typescript
// src/components/HelpV2/HelpV2.tsx
function HelpV2({ onClose, commands }: Props): React.ReactNode

type Props = {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void
  commands: Command[]
}

// 标签页结构
[
  { id: 'general', title: 'general', content: <General /> },
  { id: 'commands', title: 'commands', content: <Commands /> },
  { id: 'custom', title: 'custom-commands', content: <Commands /> },
  { id: 'ant-only', title: '[ant-only]', content: <Commands /> } // conditionally
]
```

#### 输入输出

**输入**：
- `commands`: Command[] 完整命令列表
- 用户按键输入：
  - `Esc` 或 `help:dismiss` 快捷键 → 关闭对话框
  - `Ctrl+C` → 退出应用
  - `Enter` → 确认操作

**输出**：
- 渲染标签页界面
- 调用 `onClose()` 回调

#### 状态与触发条件

**触发条件**：
- 用户输入 `/help` 命令
- 内部命令调用

**展示条件**：
- 非活动模态框状态（`useIsInsideModal()` 检查）
- 终端宽度足够（`useTerminalSize()` 获取宽度）

#### 展示流程

```
/help 触发
  ↓
Dialog 容器显示
  ↓
Tabs 组件切换 (General/Commands/Custom Commands/[ant-only])
  ↓
用户按 Esc → 调用 onClose()
```

#### 错误与隐私

- **终端太窄处理**：长描述自动截断
- **无隐私影响**：仅本地显示，不发送数据
- **命令列表来源**：从注册命令动态获取，无硬编码

#### 设计取舍/备选

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 内容组织 | 标签页切换 | 需要多轮导航 | 内容分类清晰，避免信息过载 |
| 关闭方式 | Esc 快捷键 | 需要记住按键 | 快速退出，符合 CLI 习惯 |

#### 源码测试证据

- **实现文件**：`src/components/HelpV2/HelpV2.tsx`, `src/components/HelpV2/General.tsx`, `src/components/HelpV2/Commands.tsx`
- **命令入口**：`src/commands/help/help.tsx`

---

### 4.4 模块设计卡：FeedbackSurvey 反馈调查

#### 入口签名/关键类型

```typescript
// src/components/FeedbackSurvey/FeedbackSurvey.tsx
function FeedbackSurvey({
  state, lastResponse, handleSelect, handleTranscriptSelect,
  inputValue, setInputValue, onRequestFeedback, message
}: Props): React.ReactNode

// src/components/FeedbackSurvey/useFeedbackSurvey.tsx
function useFeedbackSurvey(
  messages: Message[],
  isLoading: boolean,
  submitCount: number,
  surveyType: FeedbackSurveyType = 'session',
  hasActivePrompt: boolean = false
): {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted'
  lastResponse: FeedbackSurveyResponse | null
  handleSelect: (selected: FeedbackSurveyResponse) => boolean
  handleTranscriptSelect: (selected: TranscriptShareResponse) => void
}

type FeedbackSurveyResponse = 'bad' | 'fine' | 'good' | 'dismissed'
type FeedbackSurveyType = 'session' | 'memory' | 'post_compact'

// src/components/FeedbackSurvey/useDebouncedDigitInput.ts
function useDebouncedDigitInput<T extends string = string>({
  inputValue, setInputValue, isValidDigit, onDigit, enabled, once, debounceMs
}: {...}): void
```

#### 输入输出

**输入**：
- `messages`: Message[] 完整消息历史
- `isLoading`: boolean 是否正在加载
- `submitCount`: number 用户提交次数
- `inputValue`: string 实时用户输入（用于数字输入冲突检测）

**输出**：
- 调查 UI 组件（显示 1/2/3/0 选项）
- 事件记录到 analytics

#### 状态与触发条件

**状态机**：
```
closed → open → [good/bad/fine/dismissed] → [transcript_prompt?] → thanks
  ↑              ↓
  └─────────────┘ 概率重试
```

**触发条件**（全部满足）：
1. `state === 'closed'` - 当前未显示
2. `!isLoading` - 不在加载中
3. `!hasActivePrompt` - 无活动提示框
4. `isModelAllowed` - 当前模型在允许列表中
5. `!CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` - 环境变量未禁用
6. `!isFeedbackSurveyDisabled()` - 遥测配置未禁用
7. `isPolicyAllowed('allow_product_feedback')` - 组织策略允许
8. **会话本地冷却**：
   - 首次出现：会话时长 ≥ 10分钟 (`minTimeBeforeFeedbackMs`) 且用户轮次 ≥ 5
   - 再次出现：距上次 ≥ 1小时 (`minTimeBetweenFeedbackMs`) 且用户轮次 ≥ 10
9. **全局冷却**：距上次（跨会话）≥ ~27.7小时 (`minTimeBetweenGlobalFeedbackMs`)
10. **概率通过**：`Math.random() <= 0.005` (0.5%)
11. `probabilityPassedRef` - 每个合格提交计数只掷一次随机数

**隐藏条件**：
- 用户输入非数字 (`!isValidResponseInput(inputValue)`) → 自动隐藏
- 用户输入非 1/2/3 且在转录提示阶段 → 自动隐藏

#### 数字输入冲突处理

核心问题：用户正常打字（如 "s3cmd"）中的数字可能被误识别为调查响应

解决方案：
1. **防抖延迟**：`DEFAULT_DEBOUNCE_MS = 400ms` - 等待 400ms 确认是否为单独数字
2. **输入验证**：`isValidResponseInput()` 检查是否为 0/1/2/3
3. **自动隐藏**：检测到非有效输入时组件不渲染（`return null`）
4. **修剪输入**：接受响应后自动从输入中移除数字字符

源码实现：
```typescript
// 检测逻辑
if (inputValue && !isValidResponseInput(inputValue)) {
  return null  // 用户在打字，隐藏调查
}

// useDebouncedDigitInput 防抖
const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
// 400ms 后才确认，期间用户继续输入则取消
```

#### 展示/提交/冷却流程

```
会话进行中
  ↓
检查所有触发条件（时间、轮次、冷却、概率、策略...）
  ↓
open 状态显示："How is Claude doing this session? (optional)"
  ├─ 1: Bad
  ├─ 2: Fine
  ├─ 3: Good
  └─ 0: Dismiss
  ↓
用户选择 [1/2/3] → handleSelect()
  ↓
记录 tengu_feedback_survey_event { event_type: 'responded' }
  ↓
更新 lastShown 时间 + submitCount
  ↓
[good 或 bad 且概率通过] → transcript_prompt 状态
  ├─ "Share this transcript to help us improve? (optional)"
  ├─ 1: Yes
  └─ 0: No
  ↓
用户选择 → handleTranscriptSelect()
  ↓
thanks 状态
  ├─ [good] → "Press 1 to tell us what went well · /feedback"
  ├─ [bad] → "Use /issue to report model behavior issues."
  └─ [fine] → "Use /feedback to share detailed feedback anytime."
  ↓
hideThanksAfterMs (3s) 后自动回到 closed
```

#### 冷却配置

```typescript
const DEFAULT_FEEDBACK_SURVEY_CONFIG: FeedbackSurveyConfig = {
  minTimeBeforeFeedbackMs: 600000,        // 10分钟（首次出现前）
  minTimeBetweenFeedbackMs: 3600000,      // 1小时（同会话内）
  minTimeBetweenGlobalFeedbackMs: 100000000, // ~27.7小时（跨会话）
  minUserTurnsBeforeFeedback: 5,          // 5轮对话
  minUserTurnsBetweenFeedback: 10,        // 10轮对话
  hideThanksAfterMs: 3000,                // 感谢显示3秒
  onForModels: ['*'],                     // 所有模型
  probability: 0.005                      // 0.5% 概率
}
```

#### Frustration 检测

当前实现：`useFrustrationDetection()` 返回 `{ state: 'closed' }` - **占位实现，未激活**

设计意图（未实现）：检测用户不满（如连续修正、负面措辞、错误重试）后主动触发调查

#### 错误与隐私

- **组织策略禁用**：`!isPolicyAllowed('allow_product_feedback')` → 静默不显示
- **ZDR 组织**：反馈提交时检测并拒绝（403 响应）
- **隐私保护**：评分仅记录响应类型，转录共享需要明确二次确认
- **数字输入无副作用**：接受响应后数字会从输入中自动移除

#### 设计取舍/备选

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 交互方式 | 直接数字输入 | 需要处理输入冲突 | 无模态打断，轻量快捷 |
| 触发频率 | 0.5% + 多层冷却 | 样本收集慢 | 低打扰，用户体验好 |
| 转录共享 | 二次确认 | 放弃率高 | 建立信任，隐私优先 |
| 输入验证 | 400ms 防抖 | 响应稍显延迟 | 避免误触（如 "s3cmd"） |
| 概率实现 | per-submitCount 一次掷骰 | 需要 ref 保存 | 避免每次 render 重掷导致概率过高 |

#### 源码测试证据

- **实现文件**：
  - `src/components/FeedbackSurvey/FeedbackSurvey.tsx` - 主组件
  - `src/components/FeedbackSurvey/FeedbackSurveyView.tsx` - 视图
  - `src/components/FeedbackSurvey/useFeedbackSurvey.tsx` - 触发逻辑
  - `src/components/FeedbackSurvey/useDebouncedDigitInput.ts` - 数字输入防抖
  - `src/components/FeedbackSurvey/useSurveyState.tsx` - 状态管理
  - `src/components/FeedbackSurvey/useFrustrationDetection.ts` - 未实现
  - `src/components/FeedbackSurvey/TranscriptSharePrompt.tsx` - 转录提示
  - `src/components/FeedbackSurvey/feedbackSurveyShared.ts` - 共享逻辑
  - `src/components/FeedbackSurvey/utils.ts` - 类型定义

---

### 4.5 模块设计卡：Feedback 详细反馈与脱敏

#### 入口签名/关键类型

```typescript
// src/components/Feedback.tsx
function Feedback({
  abortSignal, messages, initialDescription, onDone, backgroundTasks
}: Props): React.ReactNode

type Props = {
  abortSignal: AbortSignal
  messages: Message[]
  initialDescription?: string
  onDone: (result: string, options?: { display?: CommandResultDisplay }) => void
  backgroundTasks?: {...}
}

// src/commands/feedback/feedback.tsx
function renderFeedbackComponent(onDone, abortSignal, messages, initialDescription, backgroundTasks): React.ReactNode
function call(onDone, context, args): Promise<React.ReactNode>

// 敏感信息清理
function redactSensitiveInfo(text: string): string

// GitHub Issue URL 生成
function createGitHubIssueUrl(feedbackId, title, description, errors): string
```

#### 输入输出

**输入**：
- `messages`: Message[] - 会话历史
- `initialDescription`: string - 预填描述（可选）
- 用户文本输入：问题描述
- 用户确认：Enter 继续/提交

**输出**：
- 反馈表单 UI
- POST `https://api.anthropic.com/api/claude_cli_feedback`
- GitHub Issue URL（浏览器打开）

#### 状态与触发条件

**状态机**：
```
userInput → consent → submitting → done
    ↓         ↓
    └─ Esc → cancel
```

**触发条件**：
- 用户输入 `/feedback` 或 `/issue` 命令
- FeedbackSurvey 感谢页按 1（仅 good 响应）

#### 敏感信息脱敏

**清理范围**：

| 类型 | 模式 | 替换 |
|------|------|------|
| Anthropic API Key | `sk-ant[^\s"'']{24,}` | `[REDACTED_API_KEY]` |
| AWS AKIA Key | `AKIA[A-Z0-9]{16}` | `[REDACTED_AWS_KEY]` |
| AWS Key (带引号) | `AWS key: "(AWS[A-Z0-9]{20,})"` | `AWS key: "[REDACTED_AWS_KEY]"` |
| GCP API Key | `AIza[A-Za-z0-9_-]{35}` | `[REDACTED_GCP_KEY]` |
| GCP Service Account | `[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com` | `[REDACTED_GCP_SERVICE_ACCOUNT]` |
| x-api-key Header | `["']?x-api-key["']?\s*[:=]\s*["']?[^"',\s)}\]]+` | `$1[REDACTED_API_KEY]` |
| Authorization Header | `["']?authorization["']?\s*[:=]\s*["']?(bearer\s+)?[^"',\s)}\]]+` | `$1[REDACTED_TOKEN]` |
| AWS Env Var | `(AWS[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?` | `$1[REDACTED_AWS_VALUE]` |
| GCP Env Var | `(GOOGLE[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?` | `$1[REDACTED_GCP_VALUE]` |
| Generic API Key | `((API[-_]?KEY\|TOKEN\|SECRET\|PASSWORD)\s*[=:]\s*)["']?[^"',\s)}\]]+["']?` | `$1[REDACTED]` |

**实现位置**：`src/components/Feedback.tsx` 第 82-149 行

#### 反馈数据内容

```typescript
const reportData = {
  latestAssistantMessageId: string | null,  // 最后一条助手消息 ID
  message_count: number,                     // 消息总数
  datetime: string,                          // ISO 时间戳
  description: string,                       // 用户描述
  platform: string,                          // 平台信息
  gitRepo: boolean,                          // 是否 Git 仓库
  terminal: string,                          // 终端类型
  version: string | null,                    // Claude Code 版本
  transcript: NormalizedMessage[],           // 完整会话转录
  errors: Array<{ error?: string, timestamp?: string }>,  // 内存错误日志
  lastApiRequest: {...},                     // 最后 API 请求
  subagentTranscripts?: {...},               // 子代理转录（如有）
  rawTranscriptJsonl?: string                // 原始转录 JSONL（< MAX_TRANSCRIPT_READ_BYTES）
}
```

#### GitHub Issue 截断

**限制**：`GITHUB_URL_LIMIT = 7250` 字符

**截断策略**：
1. 优先保留用户描述
2. 错误日志按需要截断
3. 添加 `**Note:** Content was truncated.` 提示
4. 避免在 `%XX` URL 编码序列中间截断（检查最后 `%` 位置）
5. 50 字符安全缓冲区

**实现**：`createGitHubIssueUrl()` 第 516-584 行

#### 展示/提交流程

```
/feedback 触发
  ↓
userInput 状态
  ├─ 文本框输入描述
  ├─ Enter → consent
  └─ Esc → cancel
  ↓
consent 状态
  ├─ 显示将包含的内容：
  │  ├─ 描述预览
  │  ├─ 环境信息（平台、终端、版本）
  │  ├─ Git 元数据（分支、commit、remote、是否同步、是否有修改）
  │  └─ 会话转录
  ├─ Enter → submitReport()
  └─ Esc → cancel
  ↓
submitting 状态
  ├─ 敏感信息清理（redactSensitiveInfo）
  ├─ 生成标题（Haiku 生成 / fallback 截取）
  ├─ POST 反馈 API（30s 超时）
  └─ 失败 → 回 userInput，保留内容，显示错误
  ↓
done 状态
  ├─ Enter → 浏览器打开 GitHub Issue URL
  └─ 任意键 → 关闭
```

#### 标题生成

**主方式**：Haiku 模型生成
- System prompt：要求简洁、技术化、<80 字符、带 `[Bug]` 或 `[Feature Request]` 前缀
- 检查：如标题包含 API 错误前缀 → 降级到 fallback

**Fallback 方式**：截取描述第一行（单词边界，≤60 字符）

#### 错误与隐私

| 错误场景 | 处理方式 | 用户可见效果 |
|---------|---------|-------------|
| 网络超时 (30s) | 回 userInput 步骤 | "Could not submit feedback. Please try again later."，保留内容可重试 |
| 401 认证失败 | `checkAndRefreshOAuthTokenIfNeeded()` 刷新重试 | 透明处理 |
| 403 ZDR 组织 | 拒绝提交 | "Feedback collection is not available for organizations with custom data retention policies." |
| 标题生成失败 | 使用 fallback 标题 | 标题可能不够理想 |
| isEssentialTrafficOnly | 完全禁用 | 静默不提交 |
| 提交取消 (AbortSignal) | 静默忽略 | 无提示 |

**隐私保护**：
- 所有数据提交前经 `redactSensitiveInfo()` 清理
- 1P 事件单独记录描述（已脱敏）
- 用户在 consent 步骤可预览全部内容
- 无默认自动提交

#### 设计取舍/备选

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 脱敏方式 | 正则匹配常见模式 | 新凭证类型可能遗漏 | 覆盖绝大多数场景 |
| 提交确认 | 两步（输入+consent） | 稍显繁琐 | 用户知情并同意 |
| GitHub 集成 | 预填 Issue URL | URL 长度限制需截断 | 方便用户公开报告 |
| 错误重试 | 保留内容可重试 | 状态管理复杂 | 用户无需重新输入 |
| 标题生成 | Haiku + fallback | API 依赖 | 高质量但有保底 |

#### 源码测试证据

- **实现文件**：
  - `src/components/Feedback.tsx` - 主组件（含 redactSensitiveInfo, createGitHubIssueUrl, submitFeedback, generateTitle）
  - `src/commands/feedback/feedback.tsx` - 命令入口
  - `src/commands/feedback/index.ts` - 命令注册
  - `src/commands/feedback/feedbackAvailability.ts` - 可用性检查

---

### 4.6 模块设计卡：Tips 提示注册表

#### 入口签名/关键类型

```typescript
// src/services/tips/tipRegistry.ts
type Tip = {
  id: string
  content: (context?: TipContext) => Promise<string> | string
  cooldownSessions: number
  isRelevant: (context?: TipContext) => Promise<boolean> | boolean
}

async function getRelevantTips(context?: TipContext): Promise<Tip[]>
function getCustomTips(): Tip[]

// src/services/tips/tipScheduler.ts
function selectTipWithLongestTimeSinceShown(availableTips: Tip[]): Tip | undefined
async function getTipToShowOnSpinner(context?: TipContext): Promise<Tip | undefined>
function recordShownTip(tip: Tip): void

// src/services/tips/tipHistory.ts
function getSessionsSinceLastShown(tipId: string): number
function recordTipShown(tipId: string): void
```

#### 输入输出

**输入**：
- `context?: TipContext` - 可选上下文（bashTools, readFileState, theme 等）
- `settings.spinnerTipsEnabled` - 可禁用
- `settings.spinnerTipsOverride` - 用户自定义提示

**输出**：
- `Tip | undefined` - 选中的提示或无
- 记录 `tengu_tip_shown` 事件

#### 提示注册结构

**内置提示**：`externalTips` 数组（约 50+ 个）

每个提示包含：
```typescript
{
  id: 'unique-identifier',
  content: async (context) => '提示内容',  // 可使用上下文主题颜色
  cooldownSessions: 10,                    // 冷却会话数（0-30）
  isRelevant: async (context) => boolean   // 相关性检查
}
```

**自定义提示**：
```typescript
{
  tips: string[],         // 用户自定义提示文本列表
  excludeDefault: boolean // 是否排除内置提示
}
```

#### 提示去重与选择流程

```
1. 过滤用户禁用状态
   ↓
2. 收集所有相关提示
   ├─ 自定义提示（如有）
   ├─ externalTips.filter(tip => tip.isRelevant(context))
   └─ [ant-only] internalOnlyTips
   ↓
3. 冷却过滤
   └─ filter(tip => getSessionsSinceLastShown(tip.id) >= tip.cooldownSessions)
   ↓
4. 选择策略
   └─ selectTipWithLongestTimeSinceShown()  // 最久未显示优先
   ↓
5. 记录显示
   └─ recordTipShown(tip.id) + tengu_tip_shown 事件
```

#### 冷却机制

- **存储**：全局配置 `config.tipHistory`
- **单位**：会话数（不是时间）
- **范围**：0（每次都可显示）到 30（30 会话冷却）
- **查询**：`getSessionsSinceLastShown(tipId)` - 返回未显示会话数

#### 相关性检查示例

| 提示 ID | 相关性条件 |
|---------|-----------|
| `new-user-warmup` | `config.numStartups < 10` |
| `plan-mode-for-complex-tasks` | `!isAnt && daysSinceLastUse > 7` |
| `git-worktrees` | `worktreeCount <= 1 && numStartups > 50` |
| `terminal-setup` | `!config.optionAsMetaKeyInstalled [Apple Terminal]` 或 `!config.shiftEnterKeyBindingInstalled` |
| `frontend-design-plugin` | `isMarketplacePluginRelevant('frontend-design', context, { filePath: /\.(html\|css\|htm)$/i })` |
| `effort-high-nudge` | `is1PApiCustomer && modelSupportsEffort && !settings.effortLevel` |
| `guest-passes` | `!config.hasVisitedPasses && checkCachedPassesEligibility().eligible` |

#### 市场插件提示检测

```typescript
async function isMarketplacePluginRelevant(
  pluginName: string,
  context: TipContext | undefined,
  signals: { filePath?: RegExp; cli?: string[] }
): Promise<boolean> {
  // 1. 检查官方市场是否已安装
  if (!(await isOfficialMarketplaceInstalled())) return false
  // 2. 检查用户是否已安装该插件（已安装则不提示）
  if (isPluginInstalled(`${pluginName}@${OFFICIAL_MARKETPLACE_NAME}`)) return false
  // 3. 检查 CLI 信号
  if (signals.cli && bashTools?.size) {
    if (signals.cli.some(cmd => bashTools.has(cmd))) return true
  }
  // 4. 检查文件路径信号
  if (signals.filePath && context?.readFileState) {
    const readFiles = cacheKeys(context.readFileState)
    if (readFiles.some(fp => signals.filePath!.test(fp))) return true
  }
  return false
}
```

#### 错误与隐私

- **无禁用处理**：`spinnerTipsEnabled === false` → 返回 `undefined`
- **解析失败**：自定义提示解析错误 → 回退到内置提示
- **相关性错误**：`isRelevant()` 抛错 → 返回 `false`（不显示该提示）
- **无隐私影响**：仅本地选择，提示 ID 记录到 analytics

#### 设计取舍/备选

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 选择策略 | 最久未显示优先 | 需要历史追踪 | 公平轮换，避免重复 |
| 冷却单位 | 会话数 | 频繁重启会话冷却快 | 简单可靠，跨会话 |
| 相关性 | 按需检查 | 启动时稍慢 | 上下文精准 |
| 自定义 | 可覆盖内置 | 需要验证 | 用户灵活控制 |
| 内容生成 | 可异步 | 渲染需等待 | 支持动态内容 |

#### 源码测试证据

- **实现文件**：
  - `src/services/tips/tipRegistry.ts` - 提示注册与过滤
  - `src/services/tips/tipScheduler.ts` - 选择调度
  - `src/services/tips/tipHistory.ts` - 历史记录
  - `src/services/tips/types.ts` - 类型定义
  - `src/components/Tips.tsx` - 显示组件

---

### 4.7 模块设计卡：ReleaseNotes 版本与发布信息

#### 入口签名/关键类型

```typescript
// src/utils/releaseNotes.ts
export const CHANGELOG_URL = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md'
const RAW_CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md'

const MAX_RELEASE_NOTES_SHOWN = 5

function getChangelogCachePath(): string
async function migrateChangelogFromConfig(): Promise<void>
async function fetchAndStoreChangelog(): Promise<void>
async function getStoredChangelog(): Promise<string>
function getStoredChangelogFromMemory(): string
function parseChangelog(content: string): Record<string, string[]>
function getRecentReleaseNotes(currentVersion, previousVersion, changelogContent): string[]
function getAllReleaseNotes(changelogContent): Array<[string, string[]]>
async function checkForReleaseNotes(lastSeenVersion, currentVersion): Promise<{ hasReleaseNotes: boolean; releaseNotes: string[] }>
function checkForReleaseNotesSync(lastSeenVersion, currentVersion): { hasReleaseNotes: boolean; releaseNotes: string[] }

// src/commands/release-notes/release-notes.ts
export async function getReleaseNotesForCommand(): Promise<string[]>
export async function getLatestChangelog(): Promise<string>
```

#### 输入输出

**输入**：
- `lastSeenVersion`: string | null | undefined - 上次看到的版本
- `currentVersion`: string - 当前版本（默认 `MACRO.VERSION`）
- `isEssentialTrafficOnly()` - 网络流量策略
- `getIsNonInteractiveSession()` - 是否非交互会话

**输出**：
- `hasReleaseNotes: boolean` - 是否有新版本说明
- `releaseNotes: string[]` - 变更点列表（最多 5 条）
- 缓存到 `~/.claude/cache/changelog.md`

#### 数据边界

**Changelog 格式**：
```markdown
## 1.2.3 - 2024-01-15
- Feature: Add X
- Fix: Repair Y

## 1.2.2
- Improve Z
```

**解析规则**：
- 按 `^## ` 分割版本节
- 提取版本（`##` 后第一行，`-` 前部分）
- 提取以 `- ` 开头的变更点
- 忽略其他内容

**版本比较**：
- 使用 `semver.coerce()` 去除 SHA 后缀
- 使用 `gt()` 比较版本新旧

**数量限制**：
- `MAX_RELEASE_NOTES_SHOWN = 5` - 最多显示 5 条变更
- 优先显示最新版本的变更

#### 缓存策略

```
启动时
  ↓
checkForReleaseNotes()
  ├─ [Ant build] → 使用 MACRO.VERSION_CHANGELOG（编译时打包）
  └─ [OSS build]
      ├─ 检查内存缓存
      ├─ 读取 ~/.claude/cache/changelog.md（异步填充内存）
      └─ 版本变化或无缓存 → 后台 fetchAndStoreChangelog()
          ├─ GET RAW_CHANGELOG_URL
          ├─ 写入缓存文件
          ├─ 更新 config.changelogLastFetched
          └─ 500ms 超时后使用缓存
```

**缓存位置**：
- 内存：`changelogMemoryCache`（同步读取）
- 文件：`~/.claude/cache/changelog.md`
- 旧格式迁移：从 `config.cachedChangelog` 迁移到文件（2024-01 前后）

**网络条件**：
- 非交互会话 → 跳过获取
- `isEssentialTrafficOnly()` → 跳过获取
- 后台获取，不阻塞 UI

#### 展示流程

```
LogoV2 启动
  ↓
checkForReleaseNotesSync(lastSeenVersion)
  ↓
hasReleaseNotes === true
  ↓
Full 模式显示变更点
  ↓
用户确认后 → 更新 lastSeenVersion
```

#### 错误与隐私

| 错误场景 | 处理方式 | 用户可见效果 |
|---------|---------|-------------|
| 网络超时 | 使用缓存版本 | 显示旧变更或无 |
| 解析失败 | 返回 `{}` | 无变更显示 |
| 版本比较失败 | 不显示变更 | LogoV2 使用 Condensed 模式 |
| 缓存文件过大 | 限制读取（无） | 无，依赖 GitHub 内容 |
| 无网络 | 使用缓存 | 无变更或旧变更 |

**隐私保护**：
- 仅从 GitHub 获取公开 Changelog
- 无用户数据发送
- 缓存本地存储

#### 设计取舍/备选

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 获取时机 | 版本变化时 | 首次更新后下次启动才显示 | 不阻塞当前会话 |
| 缓存策略 | 文件 + 内存 | 内存占用 | 同步读取快，React 渲染可用 |
| 数量限制 | 最多 5 条 | 可能遗漏细节 | 避免信息过载 |
| 版本处理 | semver.coerce() | 非标准版本可能失败 | 兼容带 SHA 的构建版本 |
| Ant 构建 | 编译时打包 | 发布流程稍复杂 | 无网络依赖，确定内容 |

#### 源码测试证据

- **实现文件**：
  - `src/utils/releaseNotes.ts` - 核心逻辑
  - `src/commands/release-notes/release-notes.ts` - `/release-notes` 命令
  - `src/commands/release-notes/index.ts` - 命令注册

---

### 4.8 反馈调查状态机

```
closed → open → [good/bad/fine] → [transcript_prompt?] → [thanks]
        ↑
        概率触发
```

### 4.9 反馈提交流程

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

**无直接测试覆盖**，相关功能可能在其他模块测试中间接验证。

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
