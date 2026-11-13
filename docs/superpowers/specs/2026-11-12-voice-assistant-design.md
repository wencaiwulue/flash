---
id: voice-assistant
batch: 4
title: Voice Assistant 语音输入与生命周期设计
date: 2026-11-12
status: draft
---

# Voice Assistant 语音输入与生命周期设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 作为 CLI 工具，需要提供便捷的语音输入方式，让用户可以通过按住键（默认空格键）来录音并自动转录为文本，无需手动输入。同时需要适配不同终端环境和平台，处理各种错误场景。如果没有统一的语音输入系统，会导致：

- 用户需要手动转录语音，效率低下
- 跨平台录音方式不一致（macOS 原生 vs Linux arecord/sox vs Windows 原生）
- 录音和 STT 服务连接的启动延迟影响用户体验
- 终端自动重复键事件处理复杂，容易误触发或漏触发
- 静音、录音失败、权限问题等错误场景处理不完善
- 多语言支持不明确
- focus 缺乏实时的反馈
- focus 缺乏针对特定领域术语（如代码、项目名、分支名）的转录准确率低

因此本子系统必须在以下约束下完成语音输入：

- Feature flag 控制：VOICE_MODE 控制整个功能；tengu_amber_quartz_disabled 提供 kill-switch
- 支持多种录音方式：原生 native addon（优先）→ arecord（Linux fallback）→ sox rec（Linux/macOS 旧版）
- 终端键重复检测：通过两次按键间隔判断按住/松开
- 支持多语言：settings.language → 归一化到 Deepgram 支持的语言码
- 权限检查：录音前检查录音权限，请求授权
- 依赖 Anthropic OAuth：必须是 Claude.ai 用户，使用 voice_stream endpoint
- 静默检测失败、静默检测失败（录音失败）
- 支持 Focus 模式：终端获得焦点时自动录音，失去焦点时停止（仅 hold-to-talk + 静默超时
- 静默drop 处理：录音但无转录时，重放一遍（st 重放一遍）

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 延迟加载音频模块 | voice.ts 只在第一次使用时才 import，不在启动时 import | 加载 audio-capture-napi 会触发权限弹窗，且同步 open 阻塞 event loop 数百毫秒，启动时加载会导致启动延迟 | 启动时预加载：权限弹窗过早出现，阻塞启动，影响体验 | 用户第一次按键需要等待模块加载 | `src/hooks/useVoice.ts:136-141, src/services/voice.ts:40-60` |
| 音频缓冲 + 并行连接 | 同时启动录音和连接 voice_stream WebSocket，音频先缓冲，连接成功后 flush | 避免连接延迟 300-1000 毫秒，用户体验更流畅 | 先连接再录音：用户按住键后等待连接成功才开始录，体验差 | 需要处理连接失败时丢弃缓冲的音频 | `src/hooks/useVoice.ts:626-632` |
| 静默drop 检测与重放 | fullAudioRef 缓存完整音频，finalize() 检测 no-data timeout 且有音频信号时重放一遍 | 约 1% 会话遇到 conversation-engine pod 静默drop bug，重放一遍可以解决问题 | 不重放：用户白录音，体验差；每次都重放：延迟增加，不必要 | 内存占用 2MB 左右（32KB/s × 60s max） | `src/hooks/useVoice.ts:336-369` |
| 键释放检测：两个 timeout（auto-repeat）+ 一个 fallback 定时器 | 收到 auto-repeat 事件后启动 releaseTimer，间隔 > RELEASE_TIMEOUT_MS (200ms) 视为释放；fallback 处理没 auto-repeat 的情况 | 终端自动重复键事件的间隔通常 30-80ms，200ms 足够区分按住 vs 正常打字；fallback 处理 modifier 组合键等没有 auto-repeat 的情况 | 只用键盘按下/弹起事件：终端没有弹起事件，不可靠；只用一个 timer：容易误触发或漏触发 | 需要维护多个 timer，处理竞态条件 | `src/hooks/useVoice.ts:160-167, 1092-1098, 1108-1119` |
| Key terms 提升 STT 准确率：全局术语 + 项目名 + 分支名 + 最近文件名 | getVoiceKeyterms() 生成最多 50 个术语，通过 query 参数传给 voice_stream endpoint | Deepgram 对特定领域术语识别率低，提升可以显著提升准确率；自动适配当前项目上下文 | 不用 key terms：术语识别错误多 | 需要合理拆分标识符为单词，限制 50 个避免溢出 | `src/services/voiceKeyterms.ts:66-106` |
| 录音可用性预检查：probe arecord 等，检测环境 | checkRecordingAvailability() 检查权限、是否有可用音频设备 | 避免用户按了键才发现无法录音 | 不预检查：用户体验差 | 需要 probe，Linux arecord probe 有竞态条件，需要 memoize 结果 | `src/services/voice.ts:282-336` |
| Focus 模式 5s 静默超时：focus 模式下停止录音机制 | focusSilenceTimer 在 5s 静默超时后调用 finishRecording() | 避免无限期保持录音浪费资源，用户停顿后需要重新触发（通过按键或重新 focus） | 无超时：无限期保持连接；更短超时：用户易被打断 | Focus 模式静默超时硬编码为 5s | `src/hooks/useVoice.ts:234-239` |
| 语音 API 端点自带 silence detection：voice_stream 使用 Deepgram 语音活动检测 | 通过 voice_stream 的 endpointing_ms（300ms）和 utterance_end_ms（1000ms）参数配置 | Deepgram 内置 VAD 自动检测语音结束，提升转录准确率 | 无端点检测：需要手动确定何时结束语音 | 端点检测参数通过 voice_stream WebSocket URL 传递 | `src/services/voiceStreamSTT.ts:145-150` |

## 3. 目标与非目标

### 状态与生命周期

- **目标**：`useVoice()` hook 提供 hold-to-talk 语音输入，返回状态并调用转录结果回调
- **目标**：语音输入状态通过 `VoiceContext` 共享，包含 idle/recording/processing、错误、中间转录文本、音频电平
- **目标**：支持 Focus 模式，终端获得焦点自动开始录，失去焦点停止，或 5 秒静默停止
- **目标**：自动处理静默检测失败、WebSocket 连接失败、权限问题、权限问题等错误场景
- **目标**：/voice 命令启用/禁用语音模式，运行预检查
- **非目标**：不提供连续语音识别（只支持 hold-to-talk 单次输入）
- **非目标**：不支持离线 STT（必须连接 Anthropic voice_stream 服务）

### 接口与数据

- **目标**：`isVoiceModeEnabled()` 完整检查：OAuth + growthbook kill-switch
- **目标**：`hasVoiceAuth()` 检查是否有有效的 Anthropic OAuth token
- **目标**：`connectVoiceStream()` 连接 WebSocket，提供 onTranscript/onError/onClose/onReady 回调
- **目标**：`getVoiceKeyterms()` 生成 STT 提升术语
- **目标**：`checkRecordingAvailability()` 检查录音环境
- **目标**：`requestMicrophonePermission()` 触发权限请求（macOS）
- **非目标**：不提供 OAuth 授权流程（由 `/login` 命令负责）

### 执行与环境

- **目标**：支持 macOS（CoreAudio 原生）、Linux（ALSA arecord 或 SoX rec）、Windows（原生）
- **目标**：支持远程环境检测（CCR）并禁用语音
- **目标**：支持代理（通过环境变量或设置）
- **目标**：支持 mTLS（通过 getWebSocketTLSOptions）
- **非目标**：不支持 Web 浏览器环境

### 依赖边界

- **Auth**：voice 依赖 OAuth token 认证，本文只描述边界
- **Settings**：voice.enabled、language 从 settings 读取，本文只描述边界
- **OAuth**：voice 复用 OAuth token，不负责授权流程

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 主要 hook
function useVoice({
  onTranscript,
  onError,
  enabled,
  focusMode
}: UseVoiceOptions): UseVoiceReturn

// 主要检查入口
function isVoiceModeEnabled(): boolean
function hasVoiceAuth(): boolean
function isVoiceStreamAvailable(): boolean
function checkRecordingAvailability(): Promise<RecordingAvailability>
function requestMicrophonePermission(): Promise<boolean>

// 主要录音入口
async function startRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
  options?: { silenceDetection?: boolean }
): Promise<boolean>
function stopRecording(): void

// STT 连接入口
async function connectVoiceStream(
  callbacks: VoiceStreamCallbacks,
  options?: { language?: string, keyterms?: string[] }
): Promise<VoiceStreamConnection | null>

// Key terms 入口
async function getVoiceKeyterms(
  recentFiles?: ReadonlySet<string>
): Promise<string[]>
```

调用方式：

1. **启用路径**：用户运行 `/voice` 命令，检查权限、OAuth、录音环境，启用 voice.enabled 设置
2. **Hold-to-talk 路径**：用户按住语音键（默认空格）→ startRecordingSession() 启动录音 + connectVoiceStream() → 缓冲音频 → onReady flush → onTranscript 累积 → 释放键 → stopRecording() → finalize() → onTranscript 最终转录
3. **Focus 模式路径**：终端获得焦点 → startRecordingSession() → 录音/转录 → 失去焦点或静默超时 → finishRecording()

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `voiceModeEnabled.ts` | 无（纯函数） | isVoiceGrowthBookEnabled()、hasVoiceAuth()、isVoiceModeEnabled() | 实际录音或 STT | 调用 auth.ts、growthbook |
| `voice.ts` | audioNapi、audioNapiPromise、activeRecorder、nativeRecordingActive、arecordProbe、linuxAlsaCardsMemo | loadAudioNapi()、startRecording()、stopRecording()、checkVoiceDependencies()、checkRecordingAvailability()、requestMicrophonePermission() | STT、键处理 | 提供录音、spawn 子进程 |
| `voiceStreamSTT.ts` | FINALIZE_TIMEOUT_MS、KEEPALIVE_INTERVAL_MS、VOICE_STREAM_PATH、（连接状态） | connectVoiceStream()、isVoiceStreamAvailable() | 录音、UI | 提供 STT 连接、WebSocket 连接、代理/mTLS 支持 |
| `voiceKeyterms.ts` | GLOBAL_KEYTERMS（只读） | getVoiceKeyterms()、splitIdentifier()、fileNameWords() | 实际 STT | 提供术语列表、调用 git.ts、bootstrap/state.ts |
| `useVoice.ts` | stateRef、connectionRef、accumulatedRef、cleanupTimerRef、releaseTimerRef、seenRepeatRef、repeatFallbackTimerRef、focusTriggeredRef、focusSilenceTimerRef、silenceTimedOutRef、recordingStartRef、sessionGenRef、retryUsedRef、fullAudioRef、silentDropRetriedRef、attemptGenRef、focusFlushedCharsRef、hasAudioSignalRef、everConnectedRef、audioLevelsRef、onTranscriptRef、onErrorRef | handleKeyEvent()、startRecordingSession()、finishRecording()、cleanup()、computeLevel() | 键事件绑定、UI | 使用 VoiceContext、useTerminalFocus |
| `voice.tsx` | 无（React context） | VoiceProvider()、useVoiceState()、useSetVoiceState()、useGetVoiceState() | 实际语音逻辑 | 提供状态共享 |
| `useVoiceIntegration.tsx` | voicePrefixRef、voiceSuffixRef、lastSetInputRef、rapidCountRef、charsInInputRef、recordingFloorRef、isHoldActiveRef、resetTimerRef | stripTrailing()、resetAnchor()、handleKeyEvent()、useVoiceKeybindingHandler() | 实际语音逻辑（委托给 voice.ts 和 useVoice.ts） | 与 PromptInput 集成、处理键事件、管理临时文本占位符 |
| `voice/voice.ts` | LANG_HINT_MAX_SHOWS（只读） | call() 命令实现 | 实际语音逻辑 | 调用 voice.ts、voiceStreamSTT.ts、voiceKeyterms.ts |

状态位置与理由：

- **voice.ts** 中 audioNapi、audioNapiPromise、activeRecorder、nativeRecordingActive 等放在模块级变量：单例，避免多次加载 native 模块，避免多个同时录音
- **voiceStreamSTT.ts** 中连接状态放在 closure 中（connectVoiceStream 返回的对象）：每个连接独立
- **useVoice.ts** 中状态放在 useRef 中：避免 React re-render 丢失状态，同时保持与 React 生命周期的集成
- **voice.tsx** 中状态放在 createStore 中：跨多个组件共享语音状态

### 4.3 主控制流

完整 hold-to-talk 语音输入流（端到端）：

```text
用户按住语音键（空格）
  ↓
handleKeyEvent(fallbackMs)
  ↓
currentState === idle → startRecordingSession()
  ↓
同步 updateState(recording) 立即更新状态（避免竞态）
  ↓
并行：
  ├─ checkRecordingAvailability() 检查录音环境
  ├─ startRecording() 立即启动录音（缓冲音频）
  └─ getVoiceKeyterms() + connectVoiceStream() 连接 STT
       ↓
       WebSocket onopen → send KeepAlive → onReady(connection)
       ↓
       flush 缓冲的音频（ coalesce 到 ~32KB 切片）
       ↓
       发送实时音频块
       ↓
       onTranscript(text, isFinal) → 累积 accumulatedRef + 显示中间文本
  ↓
用户释放键（auto-repeat 事件停止 > RELEASE_TIMEOUT_MS）
  ↓
finishRecording()
  ↓
stopRecording()
  ↓
connection.finalize() → 发送 CloseStream → 等待 TranscriptEndpoint 或 timeout
  ↓
检测静默drop：no-data timeout + 有音频信号 + wsConnected + !focusTriggered + !silentDropRetried
  ↓
  ├─ 是 → 重放 fullAudioRef 到新连接
  └─ 否 → 继续
  ↓
累积最终转录文本
  ↓
onTranscript(最终文本)
  ↓
cleanup() → 关闭连接、清除状态
  ↓
updateState(idle)
```

静默检测与错误重试流：

```text
连接建立后 early 错误（收到 onError 且无 transcript）
  ↓
检查 retryUsedRef → 未使用
  ↓
retryUsedRef = true
  ↓
延迟 250ms（避免 rapid reconnect race）
  ↓
重连 getVoiceKeyterms() + connectVoiceStream()
  ↓
onReady → flush 新累积的音频 + 继续
```

Focus 模式流：

```text
终端获得焦点 → startRecordingSession() → armFocusSilenceTimer()
  ↓
用户说话 → onTranscript(isFinal=true) → focus 模式立即 flush onTranscript → reset focusSilenceTimer
  ↓
静默 > FOCUS_SILENCE_TIMEOUT_MS (5s) → finishRecording()
  ↓
或终端失去焦点 → finishRecording()
  ↓
silenceTimedOutRef = true（下次 focus 不自动录音，直到键事件）
```

WebSocket 连接与协议流：

```text
connectVoiceStream()
  ↓
检查并刷新 OAuth token
  ↓
构建 wss:// URL（含 encoding=linear16、sample_rate=16000、channels=1、endpointing_ms=300、utterance_end_ms=1000、language、keyterms）
  ↓
ws:// 连接（支持代理、mTLS）
  ↓
onopen → send KeepAlive → 启动 keepalive 定时器（每 8s）→ 调用 callbacks.onReady
  ↓
收到消息：
  ├─ TranscriptText → 调用 callbacks.onTranscript
  ├─ TranscriptEndpoint → 调用 callbacks.onTranscript(last, isFinal=true)
  ├─ TranscriptError → 调用 callbacks.onError
  └─ error → 调用 callbacks.onError
  ↓
finalize() → send CloseStream → 等待 TranscriptEndpoint/no-data timeout/safety timeout/ws close
  ↓
关闭连接
```

### 4.4 数据结构与持久化

关键数据结构：

```typescript
// Voice 状态
type VoiceState = {
  voiceState: 'idle' | 'recording' | 'processing'
  voiceError: string | null
  voiceInterimTranscript: string
  voiceAudioLevels: number[]
  voiceWarmingUp: boolean
}

// STT 回调
type VoiceStreamCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: string, opts?: { fatal?: boolean }) => void
  onClose: () => void
  onReady: (connection: VoiceStreamConnection) => void
}

// STT 连接
type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void
  finalize: () => Promise<FinalizeSource>
  close: () => void
  isConnected: () => boolean
}

// Finalize 触发源
type FinalizeSource =
  | 'post_closestream_endpoint'
  | 'no_data_timeout'
  | 'safety_timeout'
  | 'ws_close'
  | 'ws_already_closed'

// 录音可用性结果
type RecordingAvailability = {
  available: boolean
  reason: string | null
}

// 语言归一化结果
type NormalizedLanguage = {
  code: string
  fellBackFrom?: string
}
```

持久化：

- **设置**：`settings.voiceEnabled` 存储在用户设置中
- **全局配置**：`~/.claude.json` 中存储 `voiceLangHintShownCount`、`voiceLangHintLastLanguage`
- **临时状态**：语音状态在内存中，进程退出后丢失

恢复时：

- 启动时读取 `settings.voiceEnabled` 决定是否启用语音 UI
- `/voice` 命令重新运行预检查

### 4.5 跨子系统依赖

- **Auth**：voice 依赖 `getClaudeAIOAuthTokens()`、`checkAndRefreshOAuthTokenIfNeeded()`、`isAnthropicAuthEnabled()`
- **Settings**：voice 读取 `settings.voiceEnabled`、`settings.language`
- **Growthbook**：voice 检查 `tengu_amber_quartz_disabled`、`tengu_cobalt_frost`（Nova 3 开关）
- **Git**：getVoiceKeyterms 调用 `getBranch()` 获取分支名
- **Proxy/mTLS**：connectVoiceStream 调用 `getWebSocketProxyUrl()`、`getWebSocketProxyAgent()`、`getWebSocketTLSOptions()`
- **Keybindings**：useVoiceIntegration 使用 keybindings 获取语音键配置

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 原生音频模块加载失败 | loadAudioNapi() | log debug，返回 unavailableAudioNapi | 否（只尝试一次） | 无，fallback 到子进程 | 继续尝试 arecord/sox |
| 录音启动失败 | startRecording() | log error，返回 false | 否 | cleanup() → idle | onError("Failed to start audio capture") |
| WebSocket 连接失败 | connectVoiceStream() | log debug，返回 null | 否（onError 如果是 early error 且无 transcript 则重试一次） | cleanup() → idle | onError("Voice mode requires a Claude.ai account") 或具体错误 |
| 收到 onError 且尚未收到 transcript | useVoice.ts onError 回调 | 检查 !fatal && !sawTranscript && recording → 重试一次 | 1 次（250ms 延迟） | 清 connectionRef，音频继续缓冲到 audioBuffer，重连后 flush | 用户体验不受影响（透明重试） |
| Finalize 时 no-data timeout 且有音频信号且 wsConnected 且 !focusTriggered 且 !silentDropRetried | useVoice.ts finalize().then() | log debug，重放音频到新连接 | 1 次 | 关闭旧连接，建立新连接，重放 fullAudioRef | 静默drop 时用户无需重新录音 |
| 终端失去焦点（Focus 模式） | useFocus 效果回调 | 无消息，静默 finishRecording | 否 | finishRecording() → cleanup() → idle | 转录已累积的最终文本 |
| 音频静默 > 5s（Focus 模式） | focusSilenceTimer 回调 | 无消息，静默 finishRecording | 否 | finishRecording() → cleanup() → idle | 转录已累积的最终文本 |
| 权限被拒绝 | requestMicrophonePermission() / startRecording() 失败 | 检查麦克风权限拒绝（macOS） | 否 | cleanup() → idle | onError 显示权限设置引导 |
| CCR/远程环境 | checkRecordingAvailability() | 检测到远程环境，返回不可用 | 否 | 无 | onError 或 /voice 命令显示“Voice mode requires microphone access, but no audio device is available in this environment.” |
| 语言不受支持 | normalizeLanguageForSTT() | 静默 fallback 到 en | 否 | 无 | 继续使用英文，有提示 |

工程取舍：

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 延迟加载音频模块：第一次按键才 import voice.ts | 避免启动时权限弹窗和阻塞 | 第一次按键需要等待模块加载（~100-500ms） | 启动时不阻塞，权限弹窗在用户实际使用时才出现 |
| 同时启动录音和连接 WebSocket：录音立即启动，音频缓冲到连接成功 | 需要实现缓冲和 flush 逻辑，处理连接失败时丢弃缓冲 | 消除连接延迟，用户按住键立即开始录音，体验流畅 |
| 键释放检测：两个定时器（releaseTimer + repeatFallbackTimer）+ 看到 auto-repeat 才启动 releaseTimer | 状态机复杂，容易漏触发或误触发 | 可靠处理不同终端和不同键（裸键 vs modifier 组合键） |
| 静默drop 检测与重放：fullAudioRef 缓存完整音频 60 秒（约 2MB） | 内存占用 2MB 左右 | 1% 的静默drop 会话可以无需用户重新录音 |
| Key terms 最多 50 个：避免 URL 过长 | 可能无法覆盖所有项目术语，但 50 个足够大多数场景 | 显著提升特定领域术语识别准确率，不造成 URL 过长问题 |
| arecord probe memoize：避免每次按键都 probe | 设备中途插拔不会检测到（极少见） | 避免每次按键 150ms 延迟 |
| early error 重试一次（带 250ms 延迟）：解决 rapid reconnect 到同一 pod 的 race 问题 | 失败后用户需要等待 250ms+ 重连时间 | 透明解决 1% 的早期连接失败问题 |
| Focus 模式静默超时 5 秒：避免无期限保持连接浪费资源 | 5 秒停顿后需要重新触发（通过按键或重新 focus） | 平衡用户体验和资源占用 |
| Nova 3 禁用 auto-finalize：Nova 3 跨段累积，新段不覆盖旧段 | 只有最终 TranscriptEndpoint 才最终确认 | Nova 3 准确率更高，中间段不会覆盖旧段造成丢失 |
| 安全性：音频块在发送前复制一份 Buffer.from(chunk) | 多一次内存拷贝（音频速率 32KB/s，可接受） | 避免 native 模块复用同一 ArrayBuffer 造成的数据竞争 |
| 安全性：WebSocket 关闭前 defer CloseStream 到下一个 event loop tick | 延迟 1 个 tick | 确保在 CloseStream 前发送所有已回调的音频块（避免 race condition） |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| voice.enabled=true、OAuth token 有效、权限已授权 | 用户按住空格键 5 秒然后释放 | 显示录音中状态，音频波形动画，释放后显示转录文本并插入输入框 | 不应该插入多余的空格或其他字符 |
| voice.enabled=true、OAuth token 有效、权限已授权 | 用户按住修饰键组合（如 Ctrl+X）5 秒然后释放 | 触发录音，修饰键本身不插入文本，释放后插入转录文本 | 不应该插入多余的 X 或修饰符字符 |
| voice.enabled=true、OAuth token 有效、权限已授权、Focus 模式启用 | 用户 focus 终端 → 说话 → unfocus 终端 | focus 时自动开始录音，说话时显示中间转录，unfocus 时停止并插入最终转录文本 | 不应该在 unfocus 后继续录音 |
| 用户在 macOS 上第一次使用语音 | 用户按空格键触发录音请求权限 | 显示系统权限请求弹窗 | 不应该在未授权的情况下尝试录音 |
| 用户设置 language=ja | 用户用日语说话 | 使用 ja 语言代码请求 STT，正确转录日语 | 不应该 fallback 到英文（除非未列入允许列表） |
| 用户设置 language=invalid_lang | 用户说话 | fallback 到 en，LANG_HINT_MAX_SHOWS 次后不再提示 | 不应该崩溃或无法使用语音 |
| 遇到静默drop（有音频信号但无转录） | 用户说话然后释放 | 自动重放一遍音频到新连接，最终得到转录 | 不应该要求用户重新录音（重试一次后仍然失败才提示错误） |
| WebSocket 连接在收到 transcript 前失败 | 用户按住键录音 | 透明重试一次连接（250ms 延迟），音频继续缓冲，重连后 flush | 不应该丢失缓冲的音频或要求用户重新按住键 |
| 用户在远程/CCR 环境 | 用户尝试启用语音 | /voice 命令或按键显示“Voice mode requires microphone access, but no audio device is available in this environment.” | 不应该尝试录音或连接 STT |
| 用户在 macOS 上，没有 arecord/sox | 用户尝试启用语音 | 使用原生 CoreAudio 录音（audio-capture-napi） | 不应该要求安装 sox 或 arecord |
| 用户在 Linux 上，原生模块不可用但 arecord 可用 | 用户尝试启用语音 | 使用 arecord 录音 | 不应该要求安装 sox |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 延迟加载音频模块：第一次按键才 import voice.ts | `src/hooks/useVoice.ts:136-141, src/services/voice.ts:40-60` | 无直接测试覆盖 | 手动验证第一次按键触发权限弹窗 |
| 音频缓冲 + 并行连接：同时启动录音和连接 WebSocket | `src/hooks/useVoice.ts:626-632` | 无直接测试覆盖 | 手动验证音频在连接前被缓冲 |
| 静默drop 检测与重放：fullAudioRef 缓存完整音频，finalize() 检测 no-data timeout 且有音频信号时重放一遍 | `src/hooks/useVoice.ts:336-369` | 无直接测试覆盖 | 手动验证静默drop 时重放逻辑 |
| 键释放检测：两个 timeout（releaseTimer + repeatFallbackTimer）+ 看到 auto-repeat 才启动 releaseTimer | `src/hooks/useVoice.ts:160-167, 1092-1098, 1108-1119` | 无直接测试覆盖 | 手动验证按键释放检测逻辑 |
| Key terms 提升 STT 准确率：全局术语 + 项目名 + 分支名 + 最近文件名 | `src/services/voiceKeyterms.ts:66-106` | 无直接测试覆盖 | 手动验证 key terms 通过 query 参数传递 |
| 录音可用性预检查：probe arecord 等，检测环境 | `src/services/voice.ts:282-336, 99-142` | 无直接测试覆盖 | 手动验证 arecord probe 逻辑 |
| Focus 模式 5s 静默超时：focus 模式下停止录音机制 | `src/hooks/useVoice.ts:234-239` | 无直接测试覆盖 | 手动验证 Focus 模式静默超时 |
| 语音 API 端点自带 silence detection：voice_stream 使用 Deepgram 语音活动检测 | `src/services/voiceStreamSTT.ts:145-150` | 无直接测试覆盖 | 手动验证端点检测参数传递 |
| 语音状态共享：VoiceContext + useVoiceState() 钩子 | `src/context/voice.tsx` | 无直接测试覆盖 | 手动验证状态共享机制 |
| 终端输入集成：stripTrailing() 清理占位空格，handleVoiceTranscript() 插入最终文本，锚定前缀后缀 | `src/hooks/useVoiceIntegration.tsx:163-213, 306-338, 405-710` | 无直接测试覆盖 | 手动验证输入集成逻辑 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/voice/voiceModeEnabled.ts` | `isVoiceGrowthBookEnabled()`、`hasVoiceAuth()`、`isVoiceModeEnabled()` | 语音模式启用检查（Growthbook kill-switch + OAuth） |
| `src/services/voice.ts` | `loadAudioNapi()`、`startRecording()`、`stopRecording()`、`checkVoiceDependencies()`、`checkRecordingAvailability()`、`requestMicrophonePermission()`、`probeArecord()`、`linuxHasAlsaCards()` | 录音核心逻辑、平台适配（原生/arecord/sox）、环境检查、权限请求 |
| `src/services/voiceKeyterms.ts` | `getVoiceKeyterms()`、`splitIdentifier()`、`fileNameWords()` | STT 提升术语生成 |
| `src/services/voiceStreamSTT.ts` | `connectVoiceStream()`、`isVoiceStreamAvailable()`、`FINALIZE_TIMEOUT_MS`、`KEEPALIVE_INTERVAL_MS` | voice_stream WebSocket 连接、协议处理、finalize 逻辑、重连逻辑、Nova 3 开关 |
| `src/context/voice.tsx` | `VoiceProvider`、`useVoiceState()`、`useSetVoiceState()`、`useGetVoiceState()` | 语音状态共享上下文 |
| `src/hooks/useVoice.ts` | `useVoice()`、`startRecordingSession()`、`finishRecording()`、`cleanup()`、`handleKeyEvent()`、`computeLevel()`、`normalizeLanguageForSTT()`、`RELEASE_TIMEOUT_MS`、`FOCUS_SILENCE_TIMEOUT_MS`、`AUDIO_LEVEL_BARS` | 语音主 hook、hold-to-talk 逻辑、focus 模式逻辑、静默drop 重放、early error 重试、键释放检测 |
| `src/hooks/useVoiceEnabled.ts` | `useVoiceEnabled()` | React hook，结合 user intent + auth + growthbook |
| `src/hooks/useVoiceIntegration.tsx` | `useVoiceIntegration()`、`stripTrailing()`、`resetAnchor()`、`useVoiceKeybindingHandler()`、`VoiceKeybindingHandler()` | 与终端输入框集成、键事件处理、占位文本管理、临时占位符波形显示锚定 |
| `src/commands/voice/voice.ts` | `call()` | `/voice` 命令实现、预检查、启用/禁用、提示显示 |

### 7.2 未覆盖行为（基于代码阅读）

- 完整 hold-to-talk 端到端流程测试
- Focus 模式自动录音/停止/静默超时测试
- 静默drop 检测与重放测试
- early error 透明重试测试
- arecord/sox 子进程 fallback 测试
- 键释放检测 timer 竞态测试（auto-repeat 到达顺序、fallback 定时器等）
- stripTrailing() 清理多余空格、锚定前缀后缀测试
- 多语言代码列表外语言 fallback 到英文测试
- 远程/CCR 环境禁用语音测试
- macOS 权限请求与拒绝测试
- 音频电平直方图波形显示测试
- Nova 3 开关行为测试（禁用 auto-finalize、使用 conversation-engine）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/voice-assistant.yaml)

### 8.1 本 spec 主拥有的文件

| 分组 | 主拥有职责 |
|---|---|
| voice-mode-enabled | 语音模式启用检查（Growthbook kill-switch + OAuth） |
| voice-service | 录音核心逻辑、平台适配（原生/arecord/sox）、环境检查、权限请求 |
| voice-keyterms | STT 提升术语生成（全局术语 + 项目名 + 分支名 + 最近文件名） |
| voice-stream-stt | voice_stream WebSocket 连接、协议处理、finalize 逻辑、重连逻辑、Nova 3 开关、代理/mTLS 支持 |
| voice-context | 语音状态共享上下文（React context） |
| use-voice | 语音主 hook、hold-to-talk 逻辑、focus 模式逻辑、静默drop 重放、early error 重试、键释放检测、音频电平计算、语言归一化 |
| use-voice-enabled | React hook，结合 user intent + auth + growthbook |
| use-voice-integration | 与终端输入框集成、键事件处理、占位文本管理、临时占位符波形显示锚定、键绑定处理 |
| cmd-voice | /voice 命令实现、预检查、启用/禁用、提示显示 |

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/auth.ts` → 主归 auth，本文只描述 OAuth token 依赖边界
- `src/utils/settings/*` → 主归 settings，本文只描述 voice.enabled/language 读取边界
- `src/services/analytics/growthbook.ts` → 主归 telemetry/analytics，本文只描述 feature flag 检查边界
- `src/utils/git.ts` → 主归 git integration，本文只描述 getBranch() 调用边界
- `src/utils/proxy.ts`、`src/utils/mtls.ts` → 主归其他 spec，本文只描述 getWebSocketProxyUrl()、getWebSocketProxyAgent()、getWebSocketTLSOptions() 调用边界
- `src/keybindings/*` → 主归 keybindings，本文只描述语音键配置读取边界

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 当前没有语音相关测试（tests 目录下无 *voice* 文件） | 添加端到端和单元测试覆盖主要流程：hold-to-talk、focus 模式、静默drop 重放、early error 重试、键释放检测、stripTrailing() 等 | 低（只加测试） | 所有主要语音场景都有测试覆盖 | L | 已证实 |
| P2 | 当前音频块每次发送前都 Buffer.from() 拷贝一份（虽然速率只有 32KB/s，可接受） | 检查 native 模块是否可以保证 chunk 不再复用，或使用更高效的零拷贝方式 | 中（需要修改 native 模块或验证其行为） | 发送音频时不进行不必要的内存拷贝 | M | 设计推断 |
| P2 | 当前 arecord probe 只在第一次检查，设备中途插拔不会重新检测（极少见） | 在每次 startRecording() 前重新 probe（但 memoize 一小段时间避免频繁 probe） | 低（probe 只有 150ms） | 设备中途插拔也能正确检测并 fallback | S | 设计推断 |
| P3 | 当前静默drop 只重试一次；可以考虑增加重试计数器或更智能的检测 | 增加重试次数（最多 2-3 次），或检测是否是 server 返回错误码 | 中（需要调整静默drop 检测逻辑） | 静默drop 场景恢复概率更高 | S | 设计推断 |
| P3 | 当前 Focus 模式静默超时是硬编码 5 秒，可以考虑可调或自适应 | 让 FOCUS_SILENCE_TIMEOUT_MS 可配置，或根据用户说话习惯自适应调整 | 低（只加设置或调整逻辑） | 用户可以根据自己习惯调整静默超时时间 | S | 设计推断 |
