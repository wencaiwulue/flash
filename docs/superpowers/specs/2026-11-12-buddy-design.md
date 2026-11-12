---
id: buddy
batch: 5
title: Buddy 伙伴会话与通知设计
date: 2026-11-12
status: draft
---

# Buddy 伙伴会话与通知设计

## 1. 概述

Buddy (Companion) 是一个常驻的、个性化的终端伙伴精灵，它会根据用户的会话内容生成幽默、鼓励性的评论，并以 ASCII 艺术的形式显示在输入框旁边。Buddy 具有独特的物种、稀有度、眼睛样式、帽子等属性，通过确定性算法从用户身份派生而来。

## 2. 生命周期

### 2.1 孵化流程

Buddy 的"孵化"（hatch）是一个三步过程：

```
用户首次交互
     ↓
roll(userId) → 生成确定性骨骼（骨骼不持久化）
     ↓
fireCompanionObserver → LLM 生成灵魂（姓名 + 性格）
     ↓
持久化到全局配置
```

#### 关键设计决策 1：骨骼与灵魂分离

**设计选择**：Companion 数据分为两部分：
- **骨骼**：`CompanionBones` — 由 `userId` 哈希 + 确定性算法生成，永不持久化
- **灵魂**：`CompanionSoul` — LLM 生成的 `{name, personality}`，持久化到全局配置

**备选方案**：
1. 持久化完整 Companion 对象
   - 缺点：用户无法通过重新认证获得新稀有度
   - 缺点：物种/外观重命名会破坏现有数据
2. 完全随机生成
   - 缺点：用户每次启动看到不同精灵

**证据/权衡**：
- `roll(userId)` 每次调用都产生相同结果，确保视觉一致性
- 骨骼重算发生在 `getCompanion()` 时，支持物种/外观的版本升级

### 2.2 会话参与流程

```
用户发送消息
     ↓
fireCompanionObserver() 调用
     ↓
检查：inFlight? / muted? / 已有灵魂?
     ↓
  ┌─────────────────┬───────────────┐
  │ 已有灵魂        │ 新孵化        │
  ├─────────────────┼───────────────┤
  │ 仅生成评论      │ 生成+孵化     │
  └─────────────────┴───────────────┘
     ↓
onReaction(reaction)
     ↓
AppState.companionReaction = reaction
     ↓
CompanionSprite 显示气泡
     ↓
10 秒后气泡淡出消失
```

#### 关键设计决策 2：观察者单飞限制

**设计选择**：使用 `inFlight` 标志防止并发 LLM 调用。

```typescript
// companionObserver.ts:21
let inFlight = false;

// fireCompanionObserver 开头检查
if (!context || inFlight) return;
// ...
// finally 块清理
inFlight = false;
```

**备选方案**：
1. Promise 队列
   - 缺点：消息快速时队列累积，评论过时
2. 取消前一个请求
   - 缺点：实现复杂，需要上下文支持 AbortController

**证据/权衡**：
- 用户消息通常间隔 > 10 秒（气泡持续时间）
- 单飞设计足够，无用户可见损失

### 2.3 静音/取消静音

通过 `/buddy mute` 和 `/buddy unmute` 命令控制：

```typescript
// config.ts:271
companionMuted?: boolean;
```

静音时：
- CompanionSprite 仍然显示（保持 UI 一致性）
- 但不会触发 `fireCompanionObserver`
- `/buddy pet` 仍然有效

## 3. Fork 与通知集成

### 3.1 Side Question 调用链

Buddy 使用 `sideQuestion`（子问题）机制生成评论，不阻塞主对话：

```typescript
// companionObserver.ts:94
// 已有灵魂时仅生成反应
const question = stored
  ? `You are ${stored.name}, ... Write one short reaction...`
  : `Create a coding companion... Write JSON only: {"name":...,"personality":...,"reaction":...}`;
```

#### 关键设计决策 3：Buddy 与主 Agent 的职责边界

**设计选择**：
- Buddy 仅通过气泡发言（独立于主对话）
- 主 Agent 收到 Buddy intro attachment，但不会代表 Buddy 说话
- 用户直接与 Buddy 对话时，主 Agent 保持简洁

**备选方案**：
1. Buddy 作为 Agent Swarm 成员
   - 缺点：与现有 swarms 架构目标不符（聚焦协作完成任务）
2. Buddy 消息混入主对话
   - 缺点：打断对话流，用户无法忽略

**证据/权衡**：
- 气泡设计：非侵入式，用户可以选择忽略
- intro attachment：让主 Agent 知道 Buddy 存在，不抢话

### 3.2 通知集成（预告期）

在 2026 年 4 月 1-7 日的预告期，Buddy 未孵化用户看到彩虹色通知：

```typescript
// useBuddyNotification.tsx:45
if (!feature('BUDDY')) return;
const config = getGlobalConfig();
if (config.companion || !isBuddyTeaserWindow()) return;
addNotification({
  key: 'buddy-teaser',
  jsx: <RainbowText text="/buddy" />,
  priority: 'immediate',
  timeoutMs: 15_000,
});
```

#### 关键设计决策 4：时区滚动的预告期

**设计选择**：使用本地时间而非 UTC 判断预告期：

```typescript
// useBuddyNotification.tsx:11
const d = new Date();
return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() <= 7;
```

**备选方案**：
1. UTC 固定时间窗口
   - 缺点：某些地区用户在工作时间看不到预告
2. 无预告期，直接上线
   - 缺点：错失话题热度

**证据/权衡**：
- 24 小时滚动唤醒：Twitter 讨论持续更长时间
- 降低 LLM 峰值负载（灵魂生成）

## 4. UI 状态与渲染

### 4.1 双模式布局

Buddy UI 支持两种布局模式，由终端宽度决定：

```
宽终端（≥ 100 列）
┌─────────────────────────────────────────┐
│  对话内容...                            │
│                                         │
│  💬 That was a clever approach!         │
│      🦊  [Alice] │ [Tasks]             │
│  ❯ 用户输入...                          │
└─────────────────────────────────────────┘

窄终端（< 100 列）
┌──────────────────────────┐
│  对话内容...             │
│                          │
│  🦊 "Nice one!" Alice    │
│  ❯ 用户输入...           │
└──────────────────────────┘
```

#### 关键设计决策 5：宽度阈值与内联气泡

**设计选择**：
- 阈值：`MIN_COLS_FOR_FULL_SPRITE = 100` 列
- 非全屏模式：气泡与精灵内联在输入行
- 全屏模式：气泡通过 `bottomFloat` 单独渲染，不占用输入空间

**证据/权衡**：
- `companionReservedColumns()` 动态计算预留宽度
- PromptInput 相应缩小，避免文本覆盖精灵

### 4.2 精灵动画序列

Buddy 使用帧动画表达情绪：

```typescript
// CompanionSprite.tsx:23
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0];
// -1 = 眨眼（替换眼睛字符为 "-"）
// 0-2 = 精灵帧索引
```

状态到动画的映射：
- **空闲**：播放 IDLE_SEQUENCE，偶尔眨眼
- **说话**：快速循环所有帧
- **被抚摸**：显示爱心上浮动画

### 4.3 气泡生命周期

```
reaction 设置
     ↓
lastSpokeTick = tick (当前帧序号)
     ↓
显示气泡 → 保持 20 个 tick（≈ 10 秒）
     ↓
最后 6 个 tick 淡出（fading = true）
     ↓
AppState.companionReaction = undefined
```

### 4.4 抚摸交互

用户通过导航到精灵并按 Enter（聚焦状态）触发"抚摸"：

```typescript
// AppStateStore.ts:171
companionPetAt?: number;

// CompanionSprite.tsx:187
const petAge = petAt ? tick - petStartTick : Infinity;
const petting = petAge * TICK_MS < PET_BURST_MS;
```

抚摸显示 5 帧爱心上浮动画（`PET_HEARTS`），持续 2.5 秒。

## 5. 与 Agent 的边界

### 5.1 Attachment 集成

Buddy 通过 `companion_intro` attachment 让主 Agent 知道其存在：

```typescript
// prompt.ts:29-35
return [
  {
    type: 'companion_intro',
    name: companion.name,
    species: companion.species,
  },
];
```

Attachment 处理流程：
1. 首次出现时，发送 intro 提示主 Agent
2. 后续对话不再重复发送
3. 主 Agent 收到后，不会"冒充"Buddy

### 5.2 提示工程

Buddy intro 的精确措辞：

```typescript
// prompt.ts:8-13
`# Companion

A small ${species} named ${name} sits beside the user's input box and occasionally comments in a speech bubble. You're not ${name} — it's a separate watcher.

When the user addresses ${name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE line or less, or just answer any part of the message meant for you. Don't explain that you're not ${name} — they know. Don't narrate what ${name} might say — the bubble handles that.`
```

#### 关键设计决策 6：严格的角色分离

**设计选择**：明确告诉主 Agent "You're not X"，避免角色混淆。

**备选方案**：
1. 让主 Agent 同时扮演 Buddy
   - 缺点：上下文混乱，Agent 身份分裂
2. 不做特殊处理
   - 缺点：用户与 Buddy 对话时主 Agent 抢话

**证据/权衡**：
- 清晰的职责边界：Buddy 气泡评论，主 Agent 完成任务

## 6. 失败处理与 Feature 门控

### 6.1 Feature Gate

Buddy 完整功能需要：

```typescript
// useBuddyNotification.tsx:1
import { feature } from 'bun:bundle';

// 所有 Buddy 相关代码条件化
if (!feature('BUDDY')) return null;
if (!feature('BUDDY')) return [];
```

### 6.2 软失败模式

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

### 6.3 响应解析

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

### 6.4 上线窗口控制

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

## 7. 设计决策总结

| 决策 | 选择 | 备选方案 | 权衡 |
|------|------|----------|------|
| 1. 数据分离 | 骨骼重算 + 灵魂持久化 | 完整持久化 / 完全随机 | 一致性 + 可演进性 |
| 2. 并发控制 | inFlight 单飞标志 | Promise 队列 / 取消请求 | 简单够用 |
| 3. 边界划分 | 气泡单独发言 | Agent Swarm / 混入对话 | 非侵入式 UX |
| 4. 预告窗口 | 本地时间 4/1-7 | UTC 固定时间 / 无预告 | 时区滚动热度 |
| 5. 布局阈值 | 100 列切换 | 固定全屏 / 固定内联 | 终端自适应 |
| 6. 角色分离 | 明确 "You're not X" | 兼任 / 无特殊处理 | 避免身份混乱 |
| 7. 响应解析 | 宽松提取 + 长度限制 | 严格 JSON / 仅提示词 | 现实鲁棒性 |

## 8. 覆盖率

[Coverage](../../architecture/coverage/buddy.yaml)

## 9. 开放问题与未来工作

### 9.1 边界疑虑

**疑虑一：`companion_intro` attachment 的去重逻辑依赖消息顺序**

当前实现在 `getCompanionIntroAttachment` 中检查历史消息是否已有 intro，但仅匹配 `name`，不检测重命名（未来功能）。

**疑虑二：多设备体验不一致**

Buddy 骨骼基于 userId 哈希，灵魂持久化在本地配置。同一用户在不同设备：
- 精灵外观相同（同 userId）
- 姓名/性格可能不同（不同设备的本地配置）
- 可能需要云端同步，但当前未规划

**疑虑三：静音状态与反应气泡的交互**

`companionMuted` 阻止 `fireCompanionObserver` 调用，但已设置的 `companionReaction` 仍然显示。这可能导致用户"静音前最后一句话"一直显示。

### 9.2 未来工作

- Buddy 记忆：记住用户偏好的话题、语气
- Buddy 技能：主动建议使用某个 skill
- 多物种扩展：社区贡献精灵
- 换装系统：帽子/眼睛可自定义
