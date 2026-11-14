---
id: buddy
batch: 2
title: Buddy 伙伴会话与通知设计
date: 2026-11-12
status: draft
---

# Buddy 伙伴会话与通知设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Buddy (Companion) 是一个常驻的、个性化的终端伙伴精灵，它会根据用户的会话内容生成幽默、鼓励性的评论，并以 ASCII 艺术的形式显示在输入框旁边。Buddy 具有独特的物种、稀有度、眼睛样式、帽子等属性，通过确定性算法从用户身份派生而来。

核心约束：
- 精灵外观必须由 `userId` 确定性派生，名称和性格由 LLM 生成并本地持久化；骨骼重算与灵魂持久化不能相互污染。
- Buddy 是主对话之外的观察者，评论通过 `sideQuestion` 和气泡呈现，不得阻塞主回合或让主 Agent 冒充 Buddy。
- 同时最多一个 observer 调用，静音阻止新观察但保留精灵和 `/buddy pet`；所有 LLM、解析和配置失败必须软降级。
- UI 必须适应宽窄终端，气泡和动画依赖 tick 生命周期，不能无限占用输入区域或在组件卸载后残留状态。
- 全部功能受 `BUDDY` feature gate 与上线窗口控制；预告通知只在未孵化且处于预告期时显示。

## 2. 设计理由与备选方案

下表汇总关键选择；各决策的完整流程、代码证据和局部权衡保留在第 4 节相应模块中。

| 决策 | 选择 | 备选方案 | 权衡 |
|------|------|----------|------|
| 1. 数据分离 | 骨骼重算 + 灵魂持久化 | 完整持久化 / 完全随机 | 一致性 + 可演进性 |
| 2. 并发控制 | inFlight 单飞标志 | Promise 队列 / 取消请求 | 简单够用 |
| 3. 边界划分 | 气泡单独发言 | Agent Swarm / 混入对话 | 非侵入式 UX |
| 4. 预告窗口 | 本地时间 4/1-7 | UTC 固定时间 / 无预告 | 时区滚动热度 |
| 5. 布局阈值 | 100 列切换 | 固定全屏 / 固定内联 | 终端自适应 |
| 6. 角色分离 | 明确 "You're not X" | 兼任 / 无特殊处理 | 避免身份混乱 |
| 7. 响应解析 | 宽松提取 + 长度限制 | 严格 JSON / 仅提示词 | 现实鲁棒性 |

这些选择共同以"非侵入、可忽略、失败不影响主任务"为优先级：骨骼/灵魂分离牺牲跨设备灵魂一致性，单飞牺牲快速连续消息下的评论覆盖率，宽松 JSON 解析牺牲严格 schema 以换取模型输出兼容性。

## 3. 目标与非目标

### 目标

- 首次交互时生成确定性 `CompanionBones`，通过 observer 生成并保存 `{name, personality}`，随后发出短评论。
- 以 ASCII 精灵、气泡、眨眼/说话/抚摸动画提供宽窄终端可用的非侵入式交互。
- 支持 `/buddy mute`、`/buddy unmute` 和 `/buddy pet`，并通过 `companion_intro` 让主 Agent 理解角色边界。
- 在预告期显示一次性语义的彩虹通知，在功能关闭、已孵化或不在窗口期时不显示。
- 对 observer 并发、Markdown 包裹 JSON、字段超长和软失败提供确定行为。

### 非目标

- 不把 Buddy 作为 Agent Swarm worker，不让其执行工具、修改文件或代替主 Agent 完成任务。
- 不在主消息流插入 Buddy 评论，不承诺每条用户消息都有反应。
- 当前不提供跨设备灵魂同步、重命名迁移、长期记忆或社区精灵包。
- 不把本地时间预告窗口解释为全球同一时刻的精确发布控制。

## 4. 架构、模块与数据流

### 4.1 模块设计卡：孵化/生命周期

#### 真实入口签名与关键类型

```typescript
// src/buddy/companion.ts
export function roll(userId: string): Roll
export function getCompanion(): Companion | undefined
export function companionUserId(): string

// src/buddy/types.ts
export type CompanionBones = {
  rarity: Rarity
  species: Species
  eye: Eye
  hat: Hat
  shiny: boolean
  stats: Record<StatName, number>
}
export type CompanionSoul = { name: string; personality: string }
export type Companion = CompanionBones & CompanionSoul & { hatchedAt: number }
export type StoredCompanion = CompanionSoul & { hatchedAt: number }

// src/buddy/companionObserver.ts
export async function fireCompanionObserver(
  messages: Message[],
  onReaction: (reaction: string) => void,
  context?: ToolUseContext,
  dependencies: ObserverDependencies = {},
): Promise<void>
```

#### 输入输出

**孵化路径输入**：
- `userId`: `config.oauthAccount?.accountUuid ?? config.userID ?? 'anon'`
- `messages[]`: 当前对话历史（用于去重检查）
- `context?: ToolUseContext`: 工具上下文

**孵化路径输出**：
- `config.companion` 持久化（首次）
- `onReaction(reaction)` 回调被调用

**仅评论路径输入**：
- `stored`: `config.companion`（已存在）
- `userText`: 最新用户消息文本

**仅评论路径输出**：
- 回调：`onReaction(reaction)`

#### 状态与附件

**骨骼缓存状态**：
```typescript
// companion.ts:106
let rollCache: { key: string; value: Roll } | undefined
// key = userId + SALT ('friend-2026-401')
```

**观察者飞行状态**：
```typescript
// companionObserver.ts:21
let inFlight = false  // 模块级单例锁
```

**持久化状态（全局配置）**：
```typescript
config.companion?: StoredCompanion
config.companionMuted?: boolean
```

**AppState 渲染状态**：
```typescript
AppState.companionReaction?: string
AppState.companionPetAt?: number
```

#### 创建流程

```
[用户首次交互触发]
     ↓
roll(userId) ──┬─→ Mulberry32 PRNG（hash(userId + SALT) 为种子）
               ├─→ 按权重选稀有度（legendary 1%）
               ├─→ 选物种（19 种之一）
               ├─→ 选眼睛/帽子（非 common 稀有度才有帽子）
               ├─→ shiny 判定（1% 概率）
               └─→ 生成 stats（一峰值一低谷，稀有度提下限）
     ↓
fireCompanionObserver(messages, onReaction, context)
     ├─→ 前置检查：!context || inFlight || companionMuted → return
     ├─→ 提取 latestUserText(messages)（取最后 4000 字符）
     ├─→ 构建 sideQuestion prompt：Create a coding companion...
     ├─→ 调用 runSideQuestion()（复用 fork 基础设施）
     ├─→ parseCompanionObserverResponse() 宽松解析 JSON
     ├─→ saveGlobalConfig() 持久化灵魂
     └─→ onReaction(reaction) 触发气泡
     ↓
getCompanion() ──┬─→ 从 config 读 StoredCompanion
                 └─→ roll() 重算骨骼并合并（骨骼永不持久化）
```

#### 交互与关闭流程

**交互路径（已有灵魂）**：
```
用户新消息
     ↓
fireCompanionObserver() ──┬─→ inFlight 检查
                          ├─→ muted 检查
                          ├─→ 已有灵魂判断（跳过孵化）
                          ├─→ 构建仅评论 prompt
                          ├─→ sideQuestion → parse → onReaction
                          └─→ finally 释放 inFlight
     ↓
CompanionSprite useEffect 检测到变化
     ├─→ lastSpokeTick.current = tick
     └─→ 启动 10s 后清除的定时器
     ↓
气泡显示 20 ticks (10s) ──┬─→ 前 14 ticks：正常显示
                            └─→ 后 6 ticks：fading（dimColor）
     ↓
setTimeout 触发清除 AppState.companionReaction
```

**关闭流程**：
- 气泡自动清除：reaction 设置后 10s 定时器
- Observer 调用失败：catch 块仅记录 debug log，finally 必释放 inFlight
- 组件卸载：clearInterval(tickTimer)，但不影响已持久化状态

#### 错误与 Feature 门控

**Feature 门控层级**：
```typescript
// 所有渲染入口
if (!feature('BUDDY')) return null

// 通知入口
if (!feature('BUDDY')) return

// 精灵渲染
if (!feature('BUDDY')) return null
```

**软降级点**：
| 位置 | 错误类型 | 降级行为 | 证据 |
|------|----------|----------|------|
| `fireCompanionObserver` | sideQuestion 失败 | catch log，释放 inFlight | companionObserver.ts:111-114 |
| `parseCompanionObserverResponse` | 无 {} 或 JSON 无效 | 返回 undefined，不保存 | companionObserver.ts:35-54 |
| `parseCompanionObserverResponse` | 字段超长 | 截断至 40/300/500 字符 | companionObserver.ts:44-49 |
| `fireCompanionObserver` | name/personality 缺失 | 不保存灵魂，仅用 reaction（如有） | companionObserver.ts:99 |
| `getCompanion` | config.companion 缺失 | 返回 undefined | companion.ts:127-133 |

**预告期窗口控制**：
```typescript
// useBuddyNotification.ts:11-22
export function isBuddyTeaserWindow(): boolean {
  if (process.env.USER_TYPE === 'ant') return true
  const d = new Date()
  return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() <= 7
}
// 4月1日-7日（本地时间，非 UTC）→ 24h 时区滚动上线
```

#### 设计取舍与备选

| 决策 | 当前选择 | 备选方案 | 权衡 |
|------|----------|----------|------|
| 骨骼持久化策略 | 骨骼永不持久化，每次 roll() 重算 | 完整持久化骨骼 | + 支持物种重命名/升级；+ 防止用户编辑配置改稀有度；- 跨设备骨骼可能不一致（若 userId 不同） |
| 并发控制 | inFlight 布尔标志 | Promise 队列 / AbortController | + 简单正确；+ 避免过时评论；- 快速消息时可能丢失评论 |
| 灵魂生成 | LLM 生成 name/personality | 预定义模板库 | + 个性化；+ 趣味性；- 成本；- 不可控输出（需截断） |
| PRNG 选择 | Mulberry32 | Math.random() | + 可复现；+ 轻量；- 加密不安全（但不需要） |

#### 源码测试证据

**源码证据**：
- 骨骼生成：`src/buddy/companion.ts`（roll 函数、mulberry32、rollStats）
- 类型定义：`src/buddy/types.ts`（CompanionBones/CompanionSoul/StoredCompanion）
- 孵化流程：`src/buddy/companionObserver.ts:65-116`（fireCompanionObserver）
- 缓存：`src/buddy/companion.ts:106-112`（rollCache）

**测试证据**：
- `tests/buddyFork.test.ts` 覆盖 `roll()` 确定性
- `tests/buddyFork.test.ts` 覆盖 `parseCompanionObserverResponse()` 解析
- 无直接测试覆盖完整孵化持久化路径（需依赖注入 config）

---

### 4.2 模块设计卡：fork/side question

#### 真实入口签名与关键类型

```typescript
// src/buddy/companionObserver.ts
type ObserverDependencies = {
  run?: (question: string, cacheSafeParams: CacheSafeParams) => Promise<string | null>
  now?: () => number
  getConfig?: typeof getGlobalConfig
  saveConfig?: typeof saveGlobalConfig
}

async function runObserverModel(
  question: string,
  cacheSafeParams: CacheSafeParams,
): Promise<string | null> {
  const { runSideQuestion } = await import('../utils/sideQuestion.js')
  return (await runSideQuestion({ question, cacheSafeParams })).response
}

// src/utils/sideQuestion.ts（被调用但不拥有）
export async function runSideQuestion(...): Promise<{ response: string | null }>
```

#### 输入输出

**Side Question 输入**：
- `question`: 纯文本 prompt（JSON 输出指令）
- `cacheSafeParams`: 完整的 fork 上下文

**Side Question 输出**：
- `response: string | null` — LLM 原始文本响应
- 无 tool use，无主对话污染

**解析后输出**：
- `CompanionObserverResponse {name?, personality?, reaction?}`
- 字段截断：name ≤40, personality ≤300, reaction ≤500

#### 状态与附件

**Side Question 与 Agent Swarm 的区别**：

| 维度 | Buddy Side Question | Agent Swarm Fork |
|------|---------------------|------------------|
| 目标 | 生成气泡评论 | 并行执行工具/子任务 |
| 输出去向 | 仅 `companionReaction` 状态 | 主对话消息历史 |
| Tool Use | ❌ 禁用 | ✅ 启用 |
| 阻塞主流程 | ❌ 异步非阻塞 | ✅ 可选阻塞 |
| 上下文复用 | ✅ 完整 forkContextMessages | ✅ 完整上下文 |
| 持久化影响 | ✅ 可写入 config.companion | ❌ 只读/临时 |
| 错误处理 | 软降级（log only） | 完整错误报告 |

**无附件注入 Side Question**：
- Side Question prompt 不包含 `companion_intro` attachment
- Buddy 自己的 observer 不会递归触发自己

#### 创建流程

```
[fireCompanionObserver 内部]
     ↓
构建 CacheSafeParams ──┬─→ systemPrompt（当前渲染后的）
                       ├─→ userContext（当前）
                       ├─→ systemContext（当前）
                       ├─→ toolUseContext（当前）
                       └─→ forkContextMessages（当前 messages）
     ↓
构建 question prompt ──┬─→ 已孵化：You are ${name}, a ${rarity} ${species}...
                       └─→ 未孵化：Create a coding companion from these traits...
     ↓
调用 runObserverModel() ──→ dynamic import('../utils/sideQuestion.js')
     ↓
runSideQuestion() ──┬─→ 创建独立 LLM 调用（复用同一个模型网关）
                    ├─→ 不使用 tool use
                    └─→ 返回原始字符串响应
     ↓
parseCompanionObserverResponse() ──┬─→ 寻找首尾 {}
                                   ├─→ JSON.parse()
                                   └─→ 截断字段
```

#### 交互与关闭流程

**Observer 与主 Agent 交互边界**：
- Observer 在主 turn 完成后触发（不阻塞）
- Observer 无取消机制（启动后必须运行完成）
- Observer 失败不影响主 turn 结果

**关闭流程**：
```typescript
// companionObserver.ts:113-114
finally {
  inFlight = false  // 无论成功失败必释放
}
```

#### 错误与 Feature 门控

**Side Question 层错误**：
- 被 `fireCompanionObserver` try/catch 捕获
- 仅 `logForDebugging()`，用户不可见
- `inFlight` 仍在 finally 释放

**无独立 Feature 门控**：
- 统一由 `feature('BUDDY')` 控制
- sideQuestion 基础设施始终可用（给其他功能用）

#### 设计取舍与备选

| 决策 | 当前选择 | 备选方案 | 权衡 |
|------|----------|----------|------|
| 调用机制 | 复用 sideQuestion/fork | 直接调用模型 | + 代码复用；+ 缓存友好；- 稍重 |
| Tool Use | 禁用 | 启用 | + 安全；+ 简单；- 无法让 Buddy 主动做事 |
| 阻塞行为 | 完全异步非阻塞 | await 阻塞主流程 | + UX 好；- 评论可能在下一轮后才出现 |
| Prompt 位置 | 纯 question 字符串 | System Prompt | + 灵活；- 缓存效率略低 |

#### 源码测试证据

**源码证据**：
- Observer 依赖注入：`src/buddy/companionObserver.ts:14-19`（ObserverDependencies）
- Side Question 调用：`src/buddy/companionObserver.ts:57-63`（runObserverModel）
- Prompt 构建：`src/buddy/companionObserver.ts:91-93`

**测试证据**：
- 无直接测试覆盖 sideQuestion 集成路径
- `tests/buddyFork.test.ts` 仅测试 parse 和 roll，不测试 fork 调用

---

### 4.3 模块设计卡：companion_intro/reaction

#### 真实入口签名与关键类型

```typescript
// src/buddy/prompt.ts
export function companionIntroText(name: string, species: string): string
export function getCompanionIntroAttachment(
  messages: Message[] | undefined,
): Attachment[]

// src/utils/attachments.ts（被使用，不拥有）
type Attachment = { type: 'companion_intro'; name: string; species: string }

// src/state/AppStateStore.ts
companionReaction?: string
```

#### 输入输出

**Attachment 生成输入**：
- `messages[]`: 当前对话历史（用于去重检查）
- 隐式输入：`config.companion`、`config.companionMuted`、`feature('BUDDY')`

**Attachment 生成输出**：
- `Attachment[]`：0 或 1 个元素（去重后）
- 空数组条件：feature 关闭 / 无灵魂 / 已静音 / 历史中已有同名 intro

**Reaction 输入输出**：
- 输入：`reaction: string`（来自 observer 回调）
- 输出：`AppState.companionReaction = reaction`（React 渲染触发）

#### 状态与附件

**去重状态（历史消息扫描）**：
```typescript
// prompt.ts:23-27
for (const msg of messages ?? []) {
  if (msg.type !== 'attachment') continue
  if (msg.attachment.type !== 'companion_intro') continue
  if (msg.attachment.name === companion.name) return []  // 已发过
}
```

**Attachment 与 Reaction 的区别**：

| 维度 | companion_intro Attachment | companionReaction |
|------|---------------------------|-------------------|
| 所有者 | 主 Agent（提示用） | Buddy Sprite（渲染用） |
| 持久化 | 进入消息历史 | 仅内存状态 |
| 生命周期 | 每会话 0-1 次 | 每次评论 1 次（10s） |
| 消费者 | LLM（系统提示） | 用户（UI 气泡） |
| 静音影响 | 静音时不发送 | 静音前已设置的保留 |

#### 创建流程

**Attachment 创建流程**：
```
[每个新 turn 构建提示时]
     ↓
getCompanionIntroAttachment(messages)
     ├─→ feature('BUDDY')?
     ├─→ getCompanion() 存在?
     ├─→ companionMuted?
     ├─→ 扫描 messages[] 找 companion_intro
     └─→ 同名已存在? → return []
     ↓
返回 [{type: 'companion_intro', name, species}]
     ↓
主 Agent 提示系统注入 companionIntroText()
```

**Reaction 创建流程**：
```
[observer 返回时]
     ↓
fireCompanionObserver(..., onReaction, ...)
     ↓
onReaction(reaction) 回调被调用
     ↓
setAppState(prev => ({ ...prev, companionReaction: reaction }))
     ↓
CompanionSprite useEffect 检测到变化
     ├─→ lastSpokeTick.current = tick
     └─→ setTimeout(clearReaction, 10s)
```

#### 交互与关闭流程

**主 Agent 交互规则（来自 intro 文本）**：
- "You're not ${name} — it's a separate watcher."
- 用户直接称呼 Buddy 时：主 Agent "respond in ONE line or less"
- "Don't narrate what ${name} might say — the bubble handles that."

**Reaction 关闭流程**：
```typescript
// CompanionSprite.tsx:159-174
useEffect(() => {
  if (!reaction) return
  lastSpokeTick.current = tick
  const timer = setTimeout(
    () => setAppState(prev =>
      prev.companionReaction === undefined
        ? prev
        : { ...prev, companionReaction: undefined }
    ),
    BUBBLE_SHOW * TICK_MS,  // 20 * 500ms = 10s
  )
  return () => clearTimeout(timer)
}, [reaction, setAppState])
```

#### 错误与 Feature 门控

**Attachment 层无错误路径**：
- 纯同步读操作
- 无网络/IO
- 无持久化

**Reaction 层无错误路径**：
- React 状态更新保证成功
- 渲染失败不影响主流程

**Feature 门控**：
- `getCompanionIntroAttachment()` 顶部检查 `feature('BUDDY')`
- 无 gate 时返回空数组

#### 设计取舍与备选

| 决策 | 当前选择 | 备选方案 | 权衡 |
|------|----------|----------|------|
| 去重键 | `name` | 稳定 companion ID | + 简单；- 若未来支持重命名会重复发送 |
| intro 传递方式 | Attachment + 文本注入 | 仅 System Prompt | + 显式；+ 可去重；- 稍复杂 |
| 静音时行为 | 不发送 intro，但保留已存在的 reaction | 静音时清除 reaction | + 状态一致；- 用户困惑（见 9.1 疑虑） |
| 角色边界措辞 | 强硬 "You're not X" | 温和提示 | + 减少角色混淆；- 提示词较长 |

#### 源码测试证据

**源码证据**：
- Intro 文本：`src/buddy/prompt.ts:7-13`
- Attachment 生成：`src/buddy/prompt.ts:15-36`
- Reaction 状态：`src/buddy/CompanionSprite.tsx:133`、`159-174`

**测试证据**：
- 无直接测试覆盖 attachment 去重逻辑
- 无直接测试覆盖主 Agent 遵循 intro 的行为（模型行为不可单元测试）

---

### 4.4 模块设计卡：muted/bubble

#### 真实入口签名与关键类型

```typescript
// src/commands/buddy/index.ts
const buddy: Command = {
  type: 'local',
  name: 'buddy',
  argumentHint: '[status|mute|unmute]',
  call: async (args: string) => { ... }
}

// src/buddy/CompanionSprite.tsx
export function companionReservedColumns(
  terminalColumns: number,
  speaking: boolean,
): number

// config.ts（全局配置类型，不拥有）
companionMuted?: boolean
```

#### 输入输出

**命令输入输出**：
- `/buddy` 或 `/buddy status` → 显示当前状态
- `/buddy mute` → `config.companionMuted = true`
- `/buddy unmute` → `config.companionMuted = false`

**静音检查点输出**：
- `fireCompanionObserver()` → 静音时直接 return
- `getCompanionIntroAttachment()` → 静音时返回空数组
- `CompanionSprite` → 静音时返回 null（不渲染）
- `companionReservedColumns()` → 静音时返回 0

#### 状态与附件

**静音状态持久化**：
```typescript
// src/commands/buddy/index.ts:16-20
saveGlobalConfig(current => ({
  ...current,
  companionMuted: action === 'mute',
}))
```

**静音对各子系统的影响边界**：

| 子系统 | 静音前 | 静音后 | 备注 |
|--------|--------|--------|------|
| `fireCompanionObserver` | 触发 observer | 直接 return | 新评论不生成 |
| `AppState.companionReaction` | 可设置 | 已设置的保留 | **旧气泡不自动清除** |
| `CompanionSprite` 渲染 | 渲染精灵 | 返回 null | 精灵隐藏 |
| `companion_intro` | 发送 | 不发送 | |
| `/buddy pet` | 可用 | 不可用（精灵消失） | |
| 预告通知 | 符合条件显示 | 不影响（独立检查） | 预告只看 `config.companion` 存在与否 |

#### 创建流程

**静音设置流程**：
```
用户输入 /buddy mute
     ↓
buddy command call('mute')
     ↓
saveGlobalConfig({ ..., companionMuted: true })
     ↓
[下一次 user turn]
fireCompanionObserver() ──→ 检查 config.companionMuted ──→ return
getCompanionIntroAttachment() ──→ 检查 muted ──→ return []
CompanionSprite ──→ 检查 muted ──→ return null
companionReservedColumns() ──→ 检查 muted ──→ return 0
```

**气泡生命周期流程**：
```
onReaction(reaction) 被调用
     ↓
AppState.companionReaction = reaction
     ↓
lastSpokeTick.current = tick（同步，渲染期间）
     ↓
setTimeout(clearReaction, 10s)
     ↓
[每 500ms tick]
bubbleAge = tick - lastSpokeTick
fading = bubbleAge >= 20 - 6 = 14
     ↓
[10s 后]
AppState.companionReaction = undefined
```

#### 交互与关闭流程

**静音与现有 reaction 的交互边界（当前行为）**：
```
[时间线]
T0: 用户发送消息 → reaction 显示（10s 计时器启动）
T3: 用户输入 /buddy mute
T3-T10: reaction 仍然显示（淡出）
T10: reaction 清除
T10+: 无新 reaction 生成
```

**键盘交互边界**：
- 精灵可聚焦：`footerSelection === 'companion'`
- 聚焦时按 Enter 触发 `/buddy pet`（设置 `companionPetAt`）
- 静音时精灵不渲染 → 无法聚焦/抚摸

#### 错误与 Feature 门控

**命令层无错误路径**：
- 纯配置读写
- `/buddy invalid` 返回用法提示，不抛错

**静音与 Feature Gate 关系**：
- `feature('BUDDY')` = false → 整个系统禁用，静音状态不读取
- `feature('BUDDY')` = true, muted = true → 系统部分禁用（精灵隐藏，无新评论）

#### 设计取舍与备选

| 决策 | 当前选择 | 备选方案 | 权衡 |
|------|----------|----------|------|
| 静音时精灵显示 | 隐藏 | 显示但不动画 | + 清晰；- 状态突变 |
| 静音时旧 reaction | 保留至超时 | 立即清除 | + 简单；- 用户困惑（见 9.1 疑虑） |
| 静音持久化 | 全局配置持久化 | 会话临时 | + 跨会话记住；- 用户可能忘了 |
| 静音命令位置 | `/buddy mute` | 单独 `/mute` | + 命名空间清晰；- 输入稍长 |

#### 源码测试证据

**源码证据**：
- 命令实现：`src/commands/buddy/index.ts`
- 静音检查点：
  - `companionObserver.ts:73`
  - `prompt.ts:19`
  - `CompanionSprite.tsx:178`、`125`
- 气泡生命周期：`CompanionSprite.tsx:159-174`

**测试证据**：
- 无直接测试覆盖静音行为
- 无直接测试覆盖气泡超时逻辑

---

### 4.5 模块设计卡：UI 双模式与动画

#### 真实入口签名与关键类型

```typescript
// src/buddy/CompanionSprite.tsx
export const MIN_COLS_FOR_FULL_SPRITE = 100
export function companionReservedColumns(
  terminalColumns: number,
  speaking: boolean,
): number
export function CompanionSprite(): React.ReactNode
export function CompanionFloatingBubble(): React.ReactNode

// src/buddy/sprites.ts（被使用，不拥有）
export function renderSprite(companion: Companion, frame: number): string[]
export function renderFace(companion: Companion): string
export function spriteFrameCount(species: Species): number

// 常量
const TICK_MS = 500
const BUBBLE_SHOW = 20        // ticks (10s)
const FADE_WINDOW = 6         // ticks (3s)
const PET_BURST_MS = 2500
const NARROW_QUIP_CAP = 24    // chars
```

#### 输入输出

**布局输入**：
- `columns`: 终端宽度（来自 `useTerminalSize()`）
- `isFullscreenActive()`: 全屏模式状态
- `companionReservedColumns()`: 输入行预留宽度

**布局输出（宽终端 ≥100 列）**：
- 非全屏：精灵 + 内联气泡（输入行预留宽度）
- 全屏：仅精灵 + `CompanionFloatingBubble`（bottomFloat 插槽）

**布局输出（窄终端 <100 列）**：
- 单行：`renderFace()` + 名称或短引语（无预留宽度，PromptInput 换行）

**动画输入**：
- `tick`: 本地计数器（每 500ms +1）
- `reaction`: 是否有气泡
- `petAt`: 抚摸时间戳
- `IDLE_SEQUENCE`: [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]（-1 = 眨眼）

#### 状态与附件

**本地组件状态（无持久化）**：
```typescript
const [tick, setTick] = useState(0)
const lastSpokeTick = useRef(0)
const [{ petStartTick, forPetAt }, setPetStart] = useState(...)
```

**布局模式决策表**：

| `columns` | `isFullscreenActive()` | `reaction` | 布局模式 | 气泡位置 |
|-----------|-------------------------|------------|----------|----------|
| <100 | 任意 | 任意 | 窄模式 | 内联名称行（截断至 24 字符） |
| ≥100 | false | 有 | 宽内联 | 精灵左侧 |
| ≥100 | false | 无 | 宽内联 | 无气泡 |
| ≥100 | true | 有 | 宽全屏 | bottomFloat 插槽（独立组件） |
| ≥100 | true | 无 | 宽全屏 | 无气泡 |

**动画状态机**：

| 状态 | 条件 | 精灵帧 | 眨眼 | 爱心 |
|------|------|--------|------|------|
| 空闲 | !reaction && !petting | `IDLE_SEQUENCE[tick % 15]` | `step === -1` | 无 |
| 兴奋（说话） | reaction | `tick % frameCount` | 无 | 无 |
| 兴奋（被摸） | petting | `tick % frameCount` | 无 | `PET_HEARTS[petAge % 5]` |

#### 创建流程

**双模式布局选择流程**：
```
CompanionSprite 渲染
     ↓
读取 columns（useTerminalSize）
     ↓
columns < MIN_COLS_FOR_FULL_SPRITE?
     ├─→ 是 → 窄模式：renderFace() + 名称/短引语
     └─→ 否 → 宽模式
             ↓
      isFullscreenActive()?
             ├─→ 是 → 仅精灵，气泡由 CompanionFloatingBubble 渲染
             └─→ 否 → 精灵 + 内联 SpeechBubble
```

**动画帧同步流程**：
```
useEffect 启动 setInterval(TICK_MS)
     ↓
每 500ms: setTick(t => t + 1)
     ↓
[每次渲染，同步计算]
reaction 存在? ──→ spriteFrame = tick % frameCount
petting? ──→ heartFrame = PET_HEARTS[petAge % 5]
否则 ──→ step = IDLE_SEQUENCE[tick % 15]
        ├─→ step === -1 → blink = true, spriteFrame = 0
        └─→ else → spriteFrame = step % frameCount
     ↓
renderSprite(companion, spriteFrame)
     ↓
blink ? replaceAll(eye, '-') : no-op
```

**抚摸同步（渲染期间，无 useEffect）**：
```typescript
// CompanionSprite.ts:142-148
if (petAt !== forPetAt) {
  setPetStart({ petStartTick: tick, forPetAt: petAt })
}
// 同步更新避免丢帧
```

#### 交互与关闭流程

**键盘交互边界**：
- 聚焦：`footerSelection === 'companion'`
- 聚焦时：名称反白显示（`inverse={focused}`）
- Enter：设置 `AppState.companionPetAt = Date.now()`（触发抚摸动画）
- 窄模式无独立聚焦视觉行

**关闭与清理流程**：
```typescript
// CompanionSprite.ts:150-157
useEffect(() => {
  const timer = setInterval(..., TICK_MS)
  return () => clearInterval(timer)  // 组件卸载停止 tick
}, [])

// reaction 清除超时
useEffect(() => {
  ...
  return () => clearTimeout(timer)  // reaction 变化或组件卸载清除
}, [reaction, setAppState])
```

**组件卸载边界**：
- 卸载不影响 `AppState.companionReaction`
- 但气泡不再渲染（状态可能 "leaked"，但重新挂载会恢复）

#### 错误与 Feature 门控

**渲染层 Feature 门控**：
```typescript
// CompanionSprite.tsx:192
if (!feature('BUDDY')) return null

// CompanionFloatingBubble.tsx:336
if (!feature('BUDDY') || !reaction) return null

// companionReservedColumns.ts:124
if (!feature('BUDDY')) return 0
```

**无错误路径**：
- 渲染纯同步
- 无网络/IO
- 非法状态降级：无 reaction 时无气泡，无 companion 时不渲染

#### 设计取舍与备选

| 决策 | 当前选择 | 备选方案 | 权衡 |
|------|----------|----------|------|
| 宽度阈值 | 100 列 | 80/120 列 | + 平衡；- 某些终端仍可能拥挤 |
| Tick 频率 | 500ms | 250ms/1000ms | + 动画流畅度与性能平衡 |
| 气泡时长 | 10s | 5s/15s | + 阅读时间足够；- 占用屏幕较长 |
| 窄模式气泡 | 替换名称行 | 独立气泡行 | + 节省空间；- 气泡不明显 |
| 全屏气泡 | bottomFloat 独立组件 | 绝对定位 | + 不占用输入空间；+ 不被 clip；- 双组件通信 |
| 抚摸同步 | 渲染期间 setState | useEffect | + 无丢帧；- React 模式不常见 |

#### 源码测试证据

**源码证据**：
- 布局常量：`CompanionSprite.tsx:103-108`
- 窄模式：`CompanionSprite.tsx:192-228`
- 宽模式：`CompanionSprite.tsx:230-304`
- 浮动气泡：`CompanionSprite.tsx:311-348`
- 动画序列：`CompanionSprite.tsx:23-33`
- 预留宽度计算：`CompanionSprite.tsx:119-130`

**测试证据**：
- 无直接测试覆盖布局切换
- 无直接测试覆盖动画序列
- 无直接测试覆盖 companionReservedColumns 计算

---

### 4.6 预告期子模块设计

#### 窗口规则（本地时间滚动）

```typescript
// useBuddyNotification.ts:11-22
export function isBuddyTeaserWindow(): boolean {
  if (process.env.USER_TYPE === 'ant') return true
  const d = new Date()
  return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() <= 7
}
// 4月1日-7日（本地时间，非 UTC）→ 24h 时区滚动上线
```

#### 通知渲染

```typescript
// useBuddyNotification.ts:46-51
addNotification({
  key: 'buddy-teaser',
  jsx: <RainbowText text="/buddy" />,
  priority: 'immediate',
  timeoutMs: 15_000,
})
```

**通知显示条件**：
- `feature('BUDDY')` = true
- `config.companion` = undefined（未孵化）
- `isBuddyTeaserWindow()` = true
- 启动时触发一次（useEffect 无依赖）

**预告期与完整功能的关系**：
- 预告期（4.1-4.7）：显示彩虹通知 + `/buddy` 命令可用 + observer 可孵化
- 预告期后（4.8+）：不显示通知 + 功能继续可用
- 4.1 前：功能关闭（`isBuddyLive()` = false）

## 5. 失败语义与工程取舍

### 5.1 Feature Gate

Buddy 完整功能需要：

```typescript
// useBuddyNotification.tsx:1
import { feature } from 'bun:bundle';

// 所有 Buddy 相关代码条件化
if (!feature('BUDDY')) return null;
if (!feature('BUDDY')) return [];
```

### 5.2 软失败模式

Buddy 失败不影响主对话：

```typescript
// companionObserver.ts:112
} catch (error) {
  logForDebugging(`Companion observer failed: ${String(error)}`);
} finally {
  inFlight = false;
}
```

可能的失败场景：
- LLM API 调用失败
- 返回 JSON 格式错误
- 名称/性格长度超限
- 配置持久化失败

### 5.3 响应解析

Buddy 响应使用宽松的 JSON 解析：

```typescript
// companionObserver.ts:35-54
function parseCompanionObserverResponse(text: string): CompanionObserverResponse | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return {
      name: typeof value.name === 'string' ? value.name.slice(0, 40) : undefined,
      personality: typeof value.personality === 'string' ? value.personality.slice(0, 300) : undefined,
      reaction: typeof value.reaction === 'string' ? value.reaction.slice(0, 500) : undefined,
    };
  } catch {
    return undefined;
  }
}
```

#### 关键设计决策 7：宽松的 Markdown 包裹处理

**设计选择**：提取第一个 `{` 和最后一个 `}` 之间的内容，忽略周围的 Markdown 围栏和其他文本。

**备选方案**：
1. 严格要求 LLM 返回纯 JSON
   - 缺点：现实中 LLM 经常添加额外说明
2. 使用提示词工程避免围栏
   - 缺点：仍有不确定性

**证据/权衡**：
- 宽松解析：`"```{...}```"` → 提取 `" {...} "`
- 长度限制：姓名 ≤ 40，性格 ≤ 300，反应 ≤ 500

### 5.4 上线窗口控制

Buddy 有两个上线检查函数：

```typescript
// useBuddyNotification.tsx:10-23
export function isBuddyTeaserWindow(): boolean {
  // 2026 年 4 月 1-7 日，仅预告
}

export function isBuddyLive(): boolean {
  // 2026 年 4 月 1 日起，完整功能
}
```

### 5.5 工程取舍

- observer 失败仅记录调试日志并在 `finally` 释放 `inFlight`，主对话继续；代价是用户可能没有评论，也看不到完整错误原因。
- 宽松提取首尾花括号可容忍 Markdown 围栏，但不能修复缺字段或非法 JSON；此时必须返回 `undefined`，不得保存半有效灵魂。
- 名称、性格和反应分别截断到 40/300/500 字符，限制 UI 与提示词膨胀，但可能切断多字节文本的语义完整性。
- 静音只阻止新 observer，不自动清空既有 `companionReaction`；该边界简单但会留下最后一条气泡，列入第 9 节改进。
- 本地时间窗口让各时区逐步上线并平滑 LLM 峰值，但不同地区看到预告和完整功能的具体时刻不同。

## 6. 现状验收标准

1. 给定同一 `userId`，多次 `roll(userId)` 必须生成相同物种、稀有度、眼睛和帽子等骨骼，且统计值有界；重新计算不得读取或改写已保存灵魂。
2. 给定未孵化用户且 observer 未在飞行中，首次调用必须生成名称、性格和反应，持久化合法灵魂并显示反应；随后调用只生成反应，不重复孵化。
3. 给定纯 JSON、Markdown 围栏 JSON、非法 JSON、缺少花括号和字段超长响应，解析器必须分别接受可恢复格式、拒绝 malformed output，并执行 40/300/500 字符上限。
4. 给定 observer 已 `inFlight`、Buddy 已静音或 feature 关闭，新调用必须直接返回；已开始的调用无论成功失败都必须在 `finally` 清除 `inFlight`。
5. 给定宽窄终端和 reaction/pet 状态，100 列阈值必须选择对应布局；气泡约 20 tick 后清理且最后 6 tick 淡出，抚摸爱心约 5 帧/2.5 秒后结束。
6. 给定主 Agent 收到 `companion_intro`，后续提示必须明确 Buddy 是独立 watcher；用户直接称呼 Buddy 时主 Agent 保持一行以内或仅回答属于自己的部分。
7. 给定未孵化且本地日期处于 2026 年 4 月 1—7 日，可显示 15 秒预告通知；已有 companion、feature 关闭或窗口外不得显示。

## 7. 代码与测试证据

| 设计陈述 | 代码证据 | 测试证据与边界 |
|---|---|---|
| 确定性骨骼与统计边界 | `src/buddy/companion.ts`、`src/buddy/types.ts`、`src/buddy/sprites.ts` | `tests/buddyFork.test.ts` 的 "rolls deterministic bones and bounded stats" 覆盖确定性和有界性。 |
| 宽松响应解析与 malformed 拒绝 | `src/buddy/companionObserver.ts:35-54` | `tests/buddyFork.test.ts` 的 "parses JSON responses without accepting malformed output" 覆盖核心解析不变量。 |
| 孵化、灵魂持久化与反应 | `src/buddy/companionObserver.ts`、`src/commands/buddy/index.ts` | `tests/buddyFork.test.ts` 的 "hatches and persists a soul, then emits a reaction" 覆盖成功路径；配置写失败和重复并发仍需故障注入。 |
| 精灵布局、气泡与动画 | `src/buddy/CompanionSprite.tsx` | 无直接测试；需用 tick/宽度测试固定 100 列、20 tick、淡出和 pet 生命周期。 |
| 预告窗口和通知 | `src/buddy/useBuddyNotification.tsx` | 无直接测试；需要注入本地日期、feature 与 config，覆盖 4 月 1 日、4 月 7 日和窗口外边界。 |
| 主 Agent 角色隔离 | `src/buddy/prompt.ts` 与 `companion_intro` attachment | 提示文本提供静态证据；实际模型是否抢话属于行为验收，不能仅由字符串测试证明。 |
| 静音后行为 | `src/buddy/companionObserver.ts:73`、`src/buddy/CompanionSprite.tsx:177-178` | 无直接测试；当前实现：静音后不触发新 observer，但已设置的 `companionReaction` 仍然显示（最后一条气泡保留）。 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/buddy.yaml)

| 文件分组 | 主拥有职责 | 相关子系统与边界 |
|---|---|---|
| `src/buddy/companion.ts`、`types.ts`、`sprites.ts` | 骨骼派生、类型与精灵素材 | 用户身份来自认证上下文；不拥有账户系统 |
| `src/buddy/companionObserver.ts` | sideQuestion、单飞、孵化、解析与软失败 | 模型调用复用查询基础设施，但评论不进入主对话 |
| `src/buddy/CompanionSprite.tsx` | 布局、动画、气泡和抚摸渲染 | 读写 AppState 的 `companionReaction`、`companionPetAt` |
| `src/buddy/prompt.ts` | `companion_intro` 与角色边界提示 | Attachments 负责附件注入，主 Agent 负责遵守提示 |
| `src/buddy/useBuddyNotification.tsx` | 预告窗口和通知 | Notifications 负责优先级、展示和 timeout |
| `src/commands/buddy/index.ts` | mute/unmute/pet 等命令入口 | 全局配置负责灵魂和静音持久化 |

`tests/buddyFork.test.ts` 同时包含 Buddy 与 fork 证据；其中 fork 部分属于 agent-swarms，不作为 Buddy 功能覆盖。

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|--------|----------------|----------|----------|----------|--------|--------|
| P2 | `getCompanionIntroAttachment` 仅按 `name` 去重，未来重命名功能可能导致重复发送 intro | 为 `companion_intro` 增加稳定 companion 标识，同时检测名称变更 | 低 | 验证重命名场景下历史去重正确工作 | S | 设计推断 |
| P2 | 跨设备体验不一致：骨骼基于 userId 哈希但灵魂仅本地持久化 | 明确跨设备策略（保持本地灵魂并在 UI/文档说明，或引入云同步并定义冲突解决语义） | 低 | 文档清晰说明当前跨设备行为，或云同步功能符合定义的语义 | M | 设计推断 |
| P1 | 静音时已设置的 `companionReaction` 仍然显示，用户可能困惑"静音前最后一句话"一直保留 | 静音时立即清理或按剩余生命周期淡出当前 reaction | 低 | 补充"静音前最后一条气泡"的回归测试，验证静音后反应正确消失 | M | 设计推断 |
| P2 | 窗口边界、动画清理、并发及软失败缺乏测试覆盖 | 将日期、tick、配置写入和 observer 注入为可测试依赖，补齐相关测试 | 中 | 测试覆盖预告窗口、动画清理、并发调用及软失败场景 | L | 设计推断 |
| P3 | 未来扩展（记忆、技能、多物种、换装）可能破坏现有行为 | 在扩展前先定义配置版本迁移与内容大小上限 | 中 | 验证配置版本迁移正常工作，内容超过上限时有合理降级 | M | 设计推断 |
