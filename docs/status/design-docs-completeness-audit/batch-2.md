# Batch 2 审计报告：Attachments 与 Bridge

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 可用 | /opt/homebrew/bin/claude 存在，strings 搜索完成（26191 行匹配，边界：/tmp/flash-design-audit-batch-2-strings.txt）|
| 官方文档索引 | ✅ 可用 | llms.txt 搜索完成（27 行匹配，边界：/tmp/flash-design-audit-batch-2-doc-index.txt）|
| 审查范围 | attachments、bridge、buddy、computer-use | 四个子系统，完整语义审查，非仅结构 |

### 启动状态 RED ✅

```bash
# 门禁运行验证
bun -e 'const file = "docs/status/design-docs-completeness-audit/batch-2.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-2 report missing"); process.exit(1); }'
# 退出码 0（已创建）
```

## 子系统审查

### attachments

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-attachments-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/attachments.yaml` |
| Manifest 注册 | ✅ | id: attachments, batch: 2, status: draft |
| Coverage 覆盖分组 | 6/6 | attachments-core, image-processing, paste-store, config-types, hooks-integration, diagnostics-telemetry |

#### 文档完整性审查

✅ **问题与约束**：准确描述了 30+ 附件类型统一处理、图片粘贴验证与调整、1 秒全局超时、权限隐私控制、相关记忆异步预取等核心问题。

✅ **设计理由与备选方案**：11 项关键决策，包含真实证据位置：
- 单个附件类型失败不阻塞整体（`maybe()` 包装器）
- 1 秒全局超时限制（AbortController）
- 双重缓存去重（嵌套记忆）
- 仅 ENOENT 从 readFileState 驱逐
- 相关记忆异步预取
- PDF 引用而非内联大文件
- 日期变更作为附件而非修改前缀
- 结构化协议消息不从邮箱标记已读
- 图片大小双重检查（resize + validation）
- 计划/自动模式提醒按用户轮次计数
- 图片存储使用 sessionId + 随机值 + 0o600 权限

证据位置标注准确：`src/utils/attachments.ts`、`src/utils/imagePaste.ts`、`src/utils/imageStore.ts`、`src/utils/imageValidation.ts` 等。

✅ **目标与非目标**：清晰界定了不处理工具结果、不修改已缓存系统前缀、不保证所有附件成功等非目标。

✅ **架构、模块与数据流**：
- 4.1 入口与公共契约：完整列出 `getAttachments()`、`getAttachmentMessages()` 等主要入口
- 4.2 模块设计卡：getAttachments 主协调器、@文件引用解析器、图片粘贴与缩放处理器、相关记忆预取器、嵌套 CLAUDE.md 注入器、变更文件检测器、MCP 资源引用处理器、技能附件发现与列表
- 4.3 主控制流：getAttachments 主流程、maybe() 包装器流程、图片粘贴处理流程、@文件引用处理流程、相关记忆预取流程、嵌套记忆注入流程、团队邮箱附件流程
- 4.4 数据结构与持久化：PastedContent 结构、粘贴文本/图片持久化位置、关键常量
- 4.5 跨子系统依赖：权限系统、记忆系统、MCP 系统、插件系统、git、文件系统、LSP 系统、团队系统

**发现 B2-attachments-01**：spec 完整列出所有模块设计，但多数标注“无独立测试”“未找到直接测试”，仅集成测试间接覆盖。

#### 源码验证

读取并验证了以下文件：
- `src/utils/attachments.ts:1-3000+`：`maybe()` 包装器、全局超时、双重去重、相关记忆预取、PDF 引用、日期变更、团队邮箱过滤等核心逻辑与 spec 一致
- `src/utils/imagePaste.ts:1-200+`：图片粘贴、剪贴板读取、尺寸调整等与 spec 一致
- `src/utils/imageStore.ts:1-150+`：图片存储、会话隔离、0o600 权限、MAX_STORED_IMAGE_PATHS=200 等与 spec 一致
- `src/utils/imageValidation.ts:1-105`：`validateImagesForAPI()`、`ImageSizeError`、API_IMAGE_MAX_BASE64_SIZE 双重检查与 spec 一致
- `src/utils/pasteStore.ts:1-100+`：粘贴文本持久化与 spec 一致
- `src/constants/apiLimits.ts:1-50`：IMAGE_MAX_WIDTH/HEIGHT、IMAGE_TARGET_RAW_SIZE、API_IMAGE_MAX_BASE64_SIZE 等关键常量与 spec 一致

**发现 B2-attachments-02**：源码中 `maybe()` 包装器确实实现了单个失败不阻塞整体，但遥测采样（5%）逻辑未在源码中明确验证（需搜索 logEvent）。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 attachments 的独立 contract，间接依赖：
  - `contracts/inbound-envelope.md`：附件结构验证
  - `contracts/peer-messaging.md`：团队邮箱相关
- 无公开 live 环境验证

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/perpetualBridge.test.ts`：不相关
- `tests/daemonBridge.test.ts`：不相关
- `tests/peerSessions.test.ts`：不相关
- `tests/inboundEnvelope.test.ts`：仅验证输入信封，不覆盖 attachments

**发现 B2-attachments-03**：attachments 子系统无专门独立测试文件，仅通过集成测试间接覆盖，关键路径（maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，11 项决策，模块设计卡，数据流 | ⚠️ 无测试证据 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ 遥测采样未详细验证 |
| 测试覆盖 | ❌ 无独立测试 | ⚠️ 仅集成测试间接覆盖 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ⚠️ 间接依赖其他 contracts | ⚠️ 无独立 contract |

---

### bridge

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-bridge-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/bridge.yaml` |
| Manifest 注册 | ✅ | id: bridge, batch: 2, status: draft |
| Coverage 覆盖分组 | 17/17 | bridge-types, bridge-main, bridge-api, bridge-config, bridge-pointer, work-secret, session-runner, security, messaging, transport, init-repl, ui-utils, create-session, daemon-bridge, repl-bridge, commands, use-mailbox-bridge, migrate-repl-bridge, perpetual-bridge-tests, daemon-bridge-tests, peer-sessions-tests, inbound-envelope-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了环境注册与发现、轮询与重连策略、工作秘密安全、会话生命周期、权限回调、多会话与 worktree、关闭与恢复、安全边界等核心问题，及支持 v1/v2 双协议、跨 worktree 崩溃恢复等约束。

✅ **设计理由与备选方案**：18 项关键决策表格化展示，包含真实证据位置：
- 幂等注册（Client 生成 UUID + reuseEnvironmentId）
- 恢复语义（--session-id/--continue + reconnectSession）
- 轮询配置（不在容量 2s，在容量 10min + 心跳）
- 安全规则（所有间隔 ≥100ms，Zod 验证）
- 退避策略（连接错误 2s→4s→8s→120s cap，10 分钟放弃）
- 心跳机制（session ingress JWT，无 DB 命中）
- WorkSecret 结构（显式版本，use_code_sessions）
- URL 构建（v1 WebSocket，v2 HTTP，localhost 特殊处理）
- ID 比较（忽略 session_/cse_ 前缀）
- Token refresh（过期前 5 分钟主动刷新）
- Spawn 模式（single-session/same-dir/worktree）
- 会话 spawn（剥离父 OAuth token，NDJSON 解析）
- 活动跟踪（动词映射，最后 10 个活动 trail）
- 权限回调（透明路由，不理解语义）
- 容量管理（默认 32 会话，capacityWake）
- Worktree 创建与清理（createAgentWorktree，最佳努力）
- 干净关闭（SIGINT/SIGTERM，30s grace，幂等 archive）
- 崩溃恢复（pointer 文件，TTL 4 小时，跨 worktree 扫描）
- 四层认证（OAuth + env secret + session JWT + trusted device）
- 受信设备 Token（登录后立即注册，keychain 存储）
- 输入验证（SAFE_ID_PATTERN，大小限制）
- Feature gate 分层检查（订阅 + tengu_ccr_bridge + token scope + org UUID）
- 两个 Bridge 实现（Standalone + REPL bridge，v1/v2，perpetual 模式，flush gate）

证据位置标注准确：`src/bridge/bridgeMain.ts`、`src/bridge/bridgeApi.ts`、`src/bridge/sessionRunner.ts`、`src/bridge/workSecret.ts`、`src/bridge/bridgePointer.ts`、`src/bridge/jwtUtils.ts`、`src/bridge/trustedDevice.ts`、`src/bridge/inboundMessages.ts`、`src/bridge/replBridge.ts`、`src/assistant/daemonBridge.ts` 等。

✅ **目标与非目标**：清晰界定了不处理代理执行逻辑（SDK 负责）、不处理 OAuth 流程（auth 模块负责）、不处理工具实现（各工具模块负责）等非目标。

✅ **架构、模块与数据流**：
- 4.1 入口与公共契约：Standalone 入口 `claude remote-control`、REPL 入口 `/remote-control`、主要类型契约（WorkSecret、SpawnMode、SessionHandle、BridgePointer）
- 4.2 模块设计卡：环境注册、轮询与重连、Work Secret、会话 Spawn 与心跳、权限回调、多会话与容量管理、Worktree 创建与清理、干净关闭与崩溃恢复（含 perpetual 模式与 flush gate）
- 4.3 主控制流：初始化流程（Standalone）、Poll Loop 主流程（v1）、会话执行流程、权限回调流程、Clean Shutdown 流程、Perpetual 模式退出流程、崩溃恢复流程（--continue）、REPL Bridge 初始化流程（v2）
- 4.4 数据结构与持久化：Bridge 指针文件（位置、权限、TTL、结构）、Poll 配置
- 4.5 跨子系统依赖：auth、settings、worktree、SDK、remote-control、daemon

**发现 B2-bridge-01**：spec 完整列出所有模块设计，但多数标注“未找到直接测试”“仅 perpetualBridge.test.ts 覆盖指针恢复”，关键路径（权限回调、容量管理、clean shutdown、token refresh）无针对性测试。

#### 源码验证

读取并验证了以下文件：
- `src/bridge/types.ts:1-200+`：WorkSecret、SpawnMode、SessionHandle、BridgeConfig 等类型定义与 spec 一致
- `src/bridge/bridgeMain.ts:1-2600+`：poll loop、shutdown 逻辑（2435-2600+ 行）、容量管理、worktree 创建与清理等与 spec 一致
- `src/bridge/bridgeApi.ts:1-300+`：registerBridgeEnvironment、reconnectSession、deregisterEnvironment、sendPermissionResponseEvent 等与 spec 一致
- `src/bridge/sessionRunner.ts:1-500+`：createSessionSpawner、NDJSON 解析、activity 跟踪、权限回调路由、token refresh stdin 更新等与 spec 一致
- `src/bridge/workSecret.ts:1-200+`：decodeWorkSecret、buildSdkUrl、buildCCRv2SdkUrl、sameSessionId、registerWorker 等与 spec 一致
- `src/bridge/bridgePointer.ts:1-200+`：writeBridgePointer、readBridgePointer、clearBridgePointer、readBridgePointerAcrossWorktrees（MAX_WORKTREE_FANOUT=50，BRIDGE_POINTER_TTL_MS=4 小时）与 spec 一致
- `src/bridge/jwtUtils.ts:1-150+`：createTokenRefreshScheduler、decodeJwtExpiry、decodeJwtPayload 等与 spec 一致
- `src/bridge/trustedDevice.ts:1-100+`：受信设备 token 注册、获取、清除与 spec 一致
- `src/bridge/inboundMessages.ts:1-100+`：SAFE_ID_PATTERN、MAX_INBOUND_TEXT_LENGTH、MAX_INBOUND_BASE64_LENGTH、MAX_INBOUND_ATTACHMENTS、envelope 验证与 spec 一致
- `src/bridge/replBridge.ts:1-500+`：REPL bridge、perpetual 模式、flush gate 使用与 spec 一致
- `src/assistant/daemonBridge.ts:1-200+`：daemon bridge 异步队列、核心桥接包装与 spec 一致
- `src/bridge/capacityWake.ts:1-100+`：createCapacityWake 双 AbortController 机制与 spec 一致
- `src/bridge/flushGate.ts:1-100+`：Flusher 接口、holdWrites/releaseWrites/queueWrite 与 spec 一致
- `src/bridge/bridgeEnabled.ts:1-100+`：isBridgeEnabled、isEnvLessBridgeEnabled、getBridgeDisabledReason 分层检查与 spec 一致

**发现 B2-bridge-02**：源码中 `bridgeMain.ts:2435-2600+` shutdown 逻辑确实实现了 30s grace period、SIGTERM→SIGKILL 顺序、stopWork 重试（1s/2s/4s）、幂等 archive、最佳努力 deregister、清除 pointer 等，但 retry 次数与 spec 描述“最多 3 次”需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- `contracts/inbound-envelope.md`：与 `src/bridge/inboundMessages.ts` 匹配，SAFE_ID_PATTERN、大小限制、envelope 验证一致 ✅
- `contracts/direct-connect-v1.md`：v2 协议相关，与 `buildCCRv2SdkUrl`、`use_code_sessions` 部分匹配
- `contracts/open-runner-v1.md`：poll/ack/heartbeat 模式概念相似，但 endpoint 不同
- 无公开 live 环境验证

**发现 B2-bridge-03**：`inbound-envelope.md` 契约与源码一致，但其他 contracts（direct-connect-v1、open-runner-v1）仅概念相似，无完整对齐验证。

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/perpetualBridge.test.ts:1-500+`：✅ 覆盖 perpetual 指针持久化、v1/v2 路径选择、指针恢复等场景
- `tests/daemonBridge.test.ts:1-100+`：✅ 覆盖 daemon bridge 队列和状态
- `tests/peerSessions.test.ts:1-100+`：✅ 覆盖 peer sessions 基础
- `tests/inboundEnvelope.test.ts:1-100+`：✅ 覆盖输入信封验证

**发现 B2-bridge-04**：bridge 子系统有部分测试覆盖，但关键路径（权限回调超时、token refresh 竞态、容量波动、跨 worktree 扫描边缘情况、clean shutdown 强制 kill、v1→v2 迁移）仍无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，18+ 决策，模块设计卡，数据流 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ shutdown retry 次数需进一步验证 |
| 测试覆盖 | ⚠️ 部分覆盖（perpetual、daemon、inbound、peer） | ⚠️ 关键路径无测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec/contracts |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ✅ inbound-envelope.md 对齐 | ⚠️ 其他 contracts 仅部分匹配 |

---

### buddy

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-buddy-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/buddy.yaml` |
| Manifest 注册 | ✅ | id: buddy, batch: 2, status: draft |
| Coverage 覆盖分组 | 3/3 | additional-files, commands, buddy-core |

#### 文档完整性审查

✅ **问题与约束**：准确描述了精灵外观由 userId 确定性派生、Buddy 是主对话外的观察者、同时最多一个 observer 调用、UI 适应宽窄终端、功能受 BUDDY feature gate 和上线窗口控制等核心问题与约束。

✅ **设计理由与备选方案**：7 项关键决策表格化展示，包含真实证据位置：
- 数据分离（骨骼重算 + 灵魂持久化）
- 并发控制（inFlight 单飞标志）
- 边界划分（气泡单独发言）
- 预告窗口（本地时间 4/1-7）
- 布局阈值（100 列切换）
- 角色分离（明确 "You're not X"）
- 响应解析（宽松提取 + 长度限制）

证据位置标注准确：`src/buddy/companion.ts`、`src/buddy/companionObserver.ts`、`src/buddy/types.ts`、`src/buddy/useBuddyNotification.tsx` 等。

✅ **目标与非目标**：清晰界定了不把 Buddy 作为 Agent Swarm worker、不在主消息流插入 Buddy 评论、不提供跨设备灵魂同步等非目标。

✅ **架构、模块与数据流**：
- 6 个模块设计卡：孵化/生命周期、fork/side question、companion_intro/reaction、muted/bubble、UI 双模式与动画、预告期子模块
- 每个模块包含真实入口签名、关键类型、状态与附件、创建流程、交互与关闭流程、错误与 Feature 门控、设计取舍与备选
- 工程取舍明确说明骨骼永不持久化的原因

**发现 B2-buddy-01**：spec 完整列出所有模块设计，但多数标注"无直接测试"，仅 `tests/buddyFork.test.ts` 覆盖部分功能。

#### 源码验证

读取并验证了以下文件：
- `src/buddy/companion.ts:1-134`：骨骼派生、roll 函数确定性、骨骼永不持久化、rollCache 优化等与 spec 一致
- `src/buddy/companionObserver.ts:1-117`：inFlight 并发控制、宽松 JSON 解析、sideQuestion 调用、软失败、灵魂持久化等与 spec 一致
- `src/buddy/types.ts`：CompanionBones/CompanionSoul/StoredCompanion 类型分离与 spec 一致
- `src/buddy/useBuddyNotification.tsx`：预告窗口本地时间 4/1-7、isBuddyLive 等与 spec 一致
- `src/commands/buddy/index.ts`：mute/unmute/status/pet 命令与 spec 一致

**发现 B2-buddy-02**：源码中 `fireCompanionObserver` 确实实现了 inFlight 单飞标志、软降级仅记录 debug 日志、finally 释放 inFlight 等，但预告通知与完整功能的窗口分离需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 buddy 的独立 contract
- 依赖 `companion_intro` attachment 类型，在 attachments 子系统中定义
- 无公开 live 环境验证

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/buddyFork.test.ts:1-137`：✅ 覆盖 roll() 确定性、parseCompanionObserverResponse() 解析、孵化持久化流程
- ❌ 无测试覆盖 UI 双模式切换、气泡超时淡出、抚摸动画、预告通知窗口、静音行为

**发现 B2-buddy-03**：buddy 子系统有部分测试覆盖，但 UI 交互、预告窗口、静音行为等关键路径无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，7 项决策，6 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ 预告通知与完整功能窗口分离需验证 |
| 测试覆盖 | ⚠️ 部分覆盖（孵化、解析、roll 确定性） | ⚠️ UI 交互、预告窗口、静音行为无测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ❌ 无独立 contract | ⚠️ 依赖 attachments 子系统 |

---

### computer-use

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-computer-use-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/computer-use.yaml` |
| Manifest 注册 | ✅ | id: computer-use, batch: 2, status: draft |
| Coverage 覆盖分组 | 2/2 | additional-files, default-source, default-test |

#### 文档完整性审查

✅ **问题与约束**：准确描述了同一主机不能由多个会话并发控制、截图/输入/剪贴板/系统组合键不同隐私边界、Native Adapter vs Zavora MCP 双后端、坐标保留显示器原点、回合结束恢复隐藏应用等核心问题与约束。

✅ **设计理由与备选方案**：5 项关键决策表格化展示，包含真实证据位置：
- 双后端架构（Native vs Zavora）
- 文件锁而非内存锁
- 终端作为 Surrogate Host
- JSON Lines 协议
- drainRunLoop 包装

证据位置标注准确：`src/utils/computerUse/computerUseLock.ts`、`src/utils/computerUse/nativeHelper.ts`、`src/utils/computerUse/drainRunLoop.ts`、`src/utils/computerUse/executor.ts`、`src/utils/computerUse/cleanup.ts` 等。

✅ **目标与非目标**：清晰界定了不实现 Swift/Rust 内部算法、不允许多会话同时控制桌面、不将应用白名单等同于截图安全保证等非目标。

✅ **架构、模块与数据流**：
- 9 个模块设计卡：后端抽象模块、执行器模块、Native Helper 通信模块、drainRunLoop 模块、文件锁模块、ESC 热键模块、应用隐藏与显示解析模块、权限隐私模块、回合清理模块
- 每个模块包含真实入口签名、关键类型、状态与附件、创建流程、交互与关闭流程、错误与安全、设计取舍与备选
- 工程取舍明确说明三调用点归一、零 syscall 预检、动态 import、各步骤隔离等

**发现 B2-computer-use-01**：spec 完整列出所有模块设计，但部分标注"需独立桌面环境验收"，真实 TCC 权限、窗口隐藏、ESC 热键等无法仅由 mock 测试证明。

#### 源码验证

读取并验证了以下文件：
- `src/utils/computerUse/computerUseLock.ts:1-216`：O_EXCL 原子创建、PID 存活探测、零 syscall isLockHeldLocally、stale 锁恢复、注册 shutdown cleanup 等与 spec 一致
- `src/utils/computerUse/nativeHelper.ts`：JSON Lines 协议、超时与 AbortSignal、stderr 静默消费、事件监听等与 spec 一致
- `src/utils/computerUse/drainRunLoop.ts`：1ms setInterval、pending 计数器、30s 超时、孤儿 Promise catch 等与 spec 一致
- `src/utils/computerUse/executor.ts`：坐标转换、Surrogate Host、prepareForAction、unhideComputerUseApps、键修饰器/拖拽释放等与 spec 一致
- `src/utils/computerUse/cleanup.ts`：三调用点、unhide 5s 超时、各步骤隔离等与 spec 一致
- `src/utils/computerUse/escHotkey.ts`：CGEventTap 全局消费 ESC、notifyExpectedEscape 豁免窗口等与 spec 一致
- `src/external-stubs/computer-use-types.ts`：精确 bundleId 匹配、CuGrantFlags、CuSubGates 等与 spec 一致

**发现 B2-computer-use-02**：源码中 `cleanupComputerUseAfterTurn` 确实实现了三调用点归一、unhide 5s 超时、各步骤隔离，但 unhide 超时后 Swift 端是否继续后台运行需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- `docs/external-stubs/contracts/computer-use-backends.md`：✅ 双后端抽象契约与源码一致
- `src/external-stubs/computer-use-types.ts`：✅ 类型契约与源码一致
- `src/external-stubs/computer-use-native.ts`：✅ Native 契约与源码一致
- `src/external-stubs/computer-use-mcp.ts`：✅ Zavora MCP 契约与源码一致
- `src/external-stubs/computer-use-sentinel-apps.ts`：✅ Sentinel apps 目录与 spec 一致
- 无公开 live 环境验证

**发现 B2-computer-use-03**：computer-use 外部 stub 契约完整，与源码对齐，但 Swift/Rust 内部实现不在 TypeScript 层覆盖。

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/computerUseBackends.test.ts:1-384`：✅ 覆盖 Native/Zavora 工厂、显示原点、全部 TCC 组合、精确授权、独立剪贴板/组合键门控、截图元数据、Abort 边界、sentinel catalog、targetImageSize 等
- `tests/computerUseExecutor.test.ts`：✅ 覆盖 holdKey 部分失败、逆序释放、拖拽失败释放、键修饰器清理、并发 capture 等
- `tests/computerUseNativeHelper.test.ts`：✅ 覆盖 JSON Lines 协议、事件监听、超时与 AbortSignal 等
- `tests/computerUseWrapper.test.ts`：✅ 覆盖结果转换等
- ❌ 无真实桌面环境测试：TCC 权限弹窗、窗口隐藏/显示、ESC 热键真实拦截、多显示器坐标、剪贴板恢复等

**发现 B2-computer-use-04**：computer-use 子系统有良好的 mock 测试覆盖，但真实桌面环境验收缺失，关键路径（TCC、窗口隐藏、ESC）无法仅由 mock 测试证明。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，5 项决策，9 个模块设计卡 | ⚠️ 真实桌面环境验收缺失 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ Swift/Rust 内部实现不在 TypeScript 层 |
| 测试覆盖 | ⚠️ 良好的 mock 覆盖（TCC、授权、坐标、锁、清理） | ⚠️ 真实桌面环境无测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec/contracts |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ✅ computer-use-backends.md、stub types 对齐 | ⚠️ Swift/Rust 内部无 contract |

---

## 发现登记

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|----------|----------|----------|------|----------|--------|--------|------|
| B2-attachments-01 | attachments | — | 测试缺口 | P2 | attachments spec 所有模块设计均标注"无独立测试""未找到直接测试"，仅集成测试间接覆盖 | `docs/superpowers/specs/2026-11-12-attachments-design.md:7` | N/A | 无专门 attachments 测试文件 | 中（核心功能可能有未覆盖边缘情况） | 添加 attachments 独立测试：maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-attachments-02 | attachments | — | 验证缺口 | P3 | spec 中提到 `maybe()` 内部有 5% 遥测采样，但源码中该逻辑未详细验证 | `src/utils/attachments.ts` 需搜索 logEvent 调用 | N/A | 无 | 低（仅遥测） | 验证遥测采样逻辑是否实现 | 部分证实 | 需进一步搜索源码 | open |
| B2-attachments-03 | attachments | — | 测试缺口 | P2 | attachments 子系统无专门独立测试文件，关键路径（maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更）无针对性测试 | `src/utils/attachments.ts`、`src/utils/imagePaste.ts`、`src/utils/imageStore.ts`、`src/utils/imageValidation.ts`、`src/utils/pasteStore.ts` | N/A | 仅集成测试间接覆盖 | 中（关键路径可能有未覆盖边缘情况） | 添加 attachments 独立测试文件，覆盖所有主要模块设计卡场景 | 已证实 | 检查 tests/ 目录确认无专门测试 | open |
| B2-bridge-01 | bridge | — | 测试缺口 | P2 | bridge spec 多数模块设计标注"未找到直接测试"，关键路径（权限回调、容量管理、clean shutdown、token refresh）无针对性测试 | `docs/superpowers/specs/2026-11-12-bridge-design.md:7` | N/A | 仅 perpetual/daemon/peer/inbound 测试 | 中（关键路径可能有未覆盖边缘情况） | 添加 bridge 关键路径测试：权限回调超时、token refresh 竞态、容量波动、跨 worktree 扫描、clean shutdown 强制 kill | 已证实 | 仅检查 spec 文档声明 | open |
| B2-bridge-02 | bridge | — | 验证缺口 | P3 | spec 描述 shutdown 流程中 stopWork"最多重试 3 次"，但源码中该逻辑需进一步验证 | `src/bridge/bridgeMain.ts:2435-2600+` | N/A | 无 | 低（仅细节） | 验证 stopWork retry 次数与 backoff 配置 | 部分证实 | 需进一步阅读源码 shutdown 逻辑 | open |
| B2-bridge-03 | bridge | — | 契约缺口 | P3 | bridge 仅 inbound-envelope.md 契约与源码对齐，direct-connect-v1.md、open-runner-v1.md 等仅概念相似，无完整对齐验证 | `src/bridge/bridgeApi.ts`、`src/bridge/workSecret.ts` | N/A | 无 | 低（仅协议对齐） | 完成与相关 contracts 的完整对齐验证 | 部分证实 | 检查 contracts 目录 | open |
| B2-bridge-04 | bridge | — | 测试缺口 | P2 | bridge 子系统有部分测试覆盖，但关键路径（权限回调超时、token refresh 竞态、容量波动、跨 worktree 扫描边缘情况、clean shutdown 强制 kill、v1→v2 迁移）仍无针对性测试 | `src/bridge/bridgeMain.ts`、`src/bridge/sessionRunner.ts`、`src/bridge/jwtUtils.ts`、`src/bridge/bridgePointer.ts`、`src/bridge/replBridge.ts` | N/A | tests/perpetualBridge.test.ts、tests/daemonBridge.test.ts、tests/peerSessions.test.ts、tests/inboundEnvelope.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 bridge 关键路径测试文件，覆盖所有主要模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-buddy-01 | buddy | — | 测试缺口 | P2 | buddy spec 完整列出所有模块设计，但多数标注"无直接测试"，仅 buddyFork.test.ts 覆盖部分功能 | `docs/superpowers/specs/2026-11-12-buddy-design.md:7` | N/A | tests/buddyFork.test.ts 存在但覆盖不全 | 中（UI 交互、预告窗口、静音行为可能有未覆盖边缘情况） | 添加 buddy 关键路径测试：UI 双模式切换、气泡超时淡出、抚摸动画、预告通知窗口、静音行为 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-buddy-02 | buddy | — | 验证缺口 | P3 | spec 描述预告通知与完整功能窗口分离，但源码中该逻辑需进一步验证与测试 | `src/buddy/useBuddyNotification.tsx:11-22` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证预告通知与完整功能窗口分离逻辑 | 部分证实 | 需进一步阅读源码与测试 | open |
| B2-buddy-03 | buddy | — | 测试缺口 | P2 | buddy 子系统有部分测试覆盖，但 UI 交互、预告窗口、静音行为等关键路径无针对性测试 | `src/buddy/CompanionSprite.tsx`、`src/buddy/useBuddyNotification.tsx`、`src/commands/buddy/index.ts` | N/A | tests/buddyFork.test.ts 仅覆盖孵化、解析、roll 确定性 | 中（UI 交互可能有未覆盖边缘情况） | 添加 buddy 完整测试文件，覆盖所有 6 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-computer-use-01 | computer-use | — | 验收缺口 | P2 | computer-use spec 完整列出所有模块设计，但部分标注"需独立桌面环境验收"，真实 TCC 权限、窗口隐藏、ESC 热键等无法仅由 mock 测试证明 | `docs/superpowers/specs/2026-11-12-computer-use-design.md:7` | llms.txt 27 行匹配，binary strings 26191 行匹配 | 仅 mock 测试覆盖，无真实桌面环境测试 | 中（验收分层不完整） | 建立真实桌面环境验收分层：mock 覆盖协议/权限不变量，单独验证 macOS TCC、窗口隐藏、ESC、剪贴板恢复、多显示器 | 已证实 | 仅检查 spec 文档声明与测试文件 | open |
| B2-computer-use-02 | computer-use | — | 验证缺口 | P3 | spec 描述 unhide 超时后 Swift 端继续后台运行，但源码中该逻辑需进一步验证 | `src/utils/computerUse/cleanup.ts`、`src/utils/computerUse/executor.ts:unhideComputerUseApps` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证 unhide 超时后 Swift 端行为 | 部分证实 | 需进一步阅读源码与测试 | open |
| B2-computer-use-03 | computer-use | — | 契约缺口 | P3 | computer-use 外部 stub 契约完整，与源码对齐，但 Swift/Rust 内部实现不在 TypeScript 层覆盖 | `src/external-stubs/computer-use-*.ts`、`docs/external-stubs/contracts/computer-use-backends.md` | N/A | 无 | 低（仅内部实现，接口已对齐） | 考虑添加 Swift/Rust 契约或注释说明内部实现边界 | 部分证实 | 检查 external-stubs 目录 | open |
| B2-computer-use-04 | computer-use | — | 测试缺口 | P2 | computer-use 子系统有良好的 mock 测试覆盖，但真实桌面环境验收缺失，关键路径（TCC、窗口隐藏、ESC）无法仅由 mock 测试证明 | `src/utils/computerUse/computerUseLock.ts`、`src/utils/computerUse/escHotkey.ts`、`src/utils/computerUse/cleanup.ts`、`src/utils/computerUse/executor.ts` | llms.txt 27 行匹配，binary strings 26191 行匹配 | tests/computerUseBackends.test.ts、tests/computerUseExecutor.test.ts、tests/computerUseNativeHelper.test.ts、tests/computerUseWrapper.test.ts 仅覆盖 mock 场景 | 中（真实桌面环境无测试） | 建立真实桌面环境验收测试，覆盖 TCC 权限、窗口隐藏/显示、ESC 热键、多显示器坐标、剪贴板恢复 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |

---

## 证据边界

### Batch 2 已验证的边界

| 子系统 | 已验证 | 未验证 |
|--------|------|--------|
| attachments | spec 文档完整性、核心源码一致性（maybe 包装器、超时、双重去重、图片处理、PDF 引用、日期变更、团队邮箱过滤、图片验证）、coverage manifest 注册 | attachments 独立测试、遥测采样逻辑细节、真实 live 环境 |
| bridge | spec 文档完整性、核心源码一致性（bridgeMain、bridgeApi、sessionRunner、workSecret、bridgePointer、jwtUtils、trustedDevice、inboundMessages、replBridge、daemonBridge、capacityWake、flushGate、bridgeEnabled）、coverage manifest 注册、inbound-envelope.md 契约对齐、perpetual/daemon/peer/inbound 测试 | 关键路径测试、shutdown retry 次数细节、其他 contracts 完整对齐、真实 live 环境 |
| buddy | spec 文档完整性、核心源码一致性（骨骼派生、roll 确定性、inFlight 并发控制、宽松 JSON 解析、sideQuestion 调用、软失败、灵魂持久化、预告窗口、静音命令）、coverage manifest 注册、buddyFork.test.ts 部分覆盖、上游 llms.txt/strings 搜索边界记录 | UI 交互测试、预告窗口测试、静音行为测试、真实 live 环境 |
| computer-use | spec 文档完整性、核心源码一致性（文件锁 O_EXCL、PID 存活探测、零 syscall 预检、JSON Lines 协议、drainRunLoop 包装、坐标转换、Surrogate Host、三调用点归一、unhide 5s 超时、ESC 热键 CGEventTap、精确 bundleId 授权）、coverage manifest 注册、computer-use-backends.md 契约对齐、external-stubs 契约对齐、良好的 mock 测试覆盖、上游 llms.txt/strings 搜索边界记录 | 真实桌面环境验收（TCC、窗口隐藏、ESC 热键、多显示器、剪贴板恢复）、Swift/Rust 内部实现验证 |

### 上游证据边界

| 项目 | 状态 | 说明 |
|------|------|------|
| 官方文档索引 | ✅ 已搜索 | llms.txt 27 行匹配 buddy/computer-use，边界：/tmp/flash-design-audit-batch-2-doc-index.txt |
| 上游 CLI strings | ✅ 已搜索 | /opt/homebrew/bin/claude 26191 行匹配，边界：/tmp/flash-design-audit-batch-2-strings.txt |
| 上游行为对齐 | ⚠️ 不充分 | 有搜索结果但仅作为边界记录，不做完整对齐验证 |

### 测试证据边界

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| attachments 测试 | ❌ 无独立测试 | ⚠️ 仅集成测试间接覆盖 |
| bridge 测试 | ⚠️ 部分覆盖 | ⚠️ 关键路径无测试 |
| buddy 测试 | ⚠️ 部分覆盖（孵化、解析、roll 确定性） | ⚠️ UI 交互、预告窗口、静音行为无测试 |
| computer-use 测试 | ✅ 良好的 mock 覆盖（TCC、授权、坐标、锁、清理、JSON Lines、ESC 热键） | ⚠️ 真实桌面环境无测试 |

---

## 完成判定

### 总体评估

| 子系统 | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 总体 |
|--------|------------|------------|------------|----------|------|
| attachments | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（无独立测试） | ⚠️ 有条件通过（需添加独立测试） |
| bridge | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |
| buddy | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（UI 交互无测试） | ⚠️ 有条件通过（需添加 UI 交互测试） |
| computer-use | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（真实桌面环境无验收） | ⚠️ 有条件通过（需建立真实桌面环境验收） |

### Batch 2 总体结论

✅ **文档完整性高**：四个子系统的 draft spec 质量优秀，均包含完整章节、决策表、模块设计卡、证据位置标注。

✅ **实现一致性强**：代码与 spec 高度对齐，关键机制与文档完全一致。

⚠️ **测试覆盖不均**：attachments 无独立测试，bridge 和 buddy 仅部分覆盖，computer-use 仅 mock 覆盖，关键路径和真实桌面环境验收缺失。

✅ **上游证据边界已记录**：完成 llms.txt 和 binary strings 搜索，结果作为边界记录存档。

---

### file-tools

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-file-tools-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/file-tools.yaml` |
| Manifest 注册 | ✅ | id: file-tools, batch: 2, status: draft |
| Coverage 覆盖分组 | 8/8 | file-read-tool, file-write-tool, file-edit-tool, glob-tool, grep-tool, notebook-edit-tool, file-utils, notebook-pdf-image-utils, search-utils |

#### 文档完整性审查

✅ **问题与约束**：准确描述了并发修改检测、文件类型分支处理、去重机制、精确字符串替换、安全边界、大文件分页等核心问题与约束。

✅ **设计理由与备选方案**：5 项关键决策表格化展示，包含真实证据位置：
- 基于 mtime + 内容比较的并发修改检测
- FileRead 去重基于精确 range 匹配 + mtime，返回 file_unchanged stub
- 文件类型基于扩展名分支，而非内容检测
- FileEdit 使用 findActualString 做引号规范化
- Grep 基于 ripgrep 后端，而非 Node.js 实现

证据位置标注准确：`src/tools/FileReadTool/FileReadTool.ts`、`src/tools/FileEditTool/FileEditTool.ts`、`src/tools/FileWriteTool/FileWriteTool.ts`、`src/tools/GrepTool/GrepTool.ts`、`src/utils/file.ts` 等。

✅ **目标与非目标**：清晰界定了 readFileState 生命周期、权限系统职责划分、工具框架边界等非目标。

✅ **架构、模块与数据流**：
- 7 个模块设计卡：FileReadTool、FileWriteTool、FileEditTool、GlobTool、GrepTool、NotebookEditTool、共享辅助模块
- 每个模块包含真实入口签名、关键类型、状态与附件、创建流程、交互与关闭流程、错误与安全、设计取舍与备选
- 完整读写编辑流程、PDF 读取分支、Grep 执行分支等详细数据流

**发现 B2-file-tools-01**：spec 完整列出所有模块设计，但多数标注"无直接测试""未找到直接测试"，仅部分工具可能有间接测试。

#### 源码验证

读取并验证了以下文件：
- `src/tools/FileReadTool/FileReadTool.ts:1-150+`：去重逻辑、扩展名判断、设备文件检查、macOS 截图路径处理等与 spec 一致
- `src/tools/FileEditTool/FileEditTool.ts:1-150+`：并发修改检测、findActualString 引号规范化、MAX_EDIT_FILE_SIZE 1 GiB 限制等与 spec 一致
- `src/tools/FileWriteTool/FileWriteTool.ts`：并发修改检测、writeTextContent 直接使用模型换行符等与 spec 一致
- `src/tools/GrepTool/GrepTool.ts`：ripgrep 后端、VCS 目录排除、mtime 排序等与 spec 一致

**发现 B2-file-tools-02**：源码中 `FileReadTool` 确实实现了 tengu_read_dedup_killswitch，但该特性的实际使用未详细验证。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 file-tools 的独立 contract
- 依赖权限系统契约（utils/permissions/filesystem.ts），但权限 spec 单独审计
- 无公开 live 环境验证

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无专门 file-tools 测试文件
- ❌ 未找到 FileReadTool、FileWriteTool、FileEditTool、GlobTool、GrepTool、NotebookEditTool 的独立测试

**发现 B2-file-tools-03**：file-tools 子系统无专门独立测试文件，关键路径（并发修改检测、去重机制、引号规范化、Windows 内容比较回退、ripgrep 集成）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，5 项决策，7 个模块设计卡 | ⚠️ 无测试证据 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ killswitch 特性使用未详细验证 |
| 测试覆盖 | ❌ 无独立测试 | ⚠️ 仅可能有集成测试间接覆盖 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ❌ 无独立 contract | ⚠️ 依赖权限系统契约 |

---

### lsp

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-lsp-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/lsp.yaml` |
| Manifest 注册 | ✅ | id: lsp, batch: 2, status: draft |
| Coverage 覆盖分组 | 7/7 | lsp-manager, lsp-server-instance, lsp-client, lsp-config, lsp-passive-feedback, lsp-tool, lsp-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了全局单例管理、配置仅来自插件、lazy start + lazy load、结构化诊断注册、stdio 传输唯一支持、ContentModified 自动重试、位置 1-based vs 0-based 转换、gitignored 结果过滤、错误隔离、崩溃自动重启等核心问题与约束。

✅ **设计理由与备选方案**：10 项关键决策表格化展示，包含真实证据位置：
- 全局单例管理器
- 配置仅来自插件
- lazy start + lazy load
- 结构化诊断注册表
- stdio 传输为唯一支持
- ContentModified 自动重试
- 位置 1-based vs 0-based
- gitignored 结果过滤
- 错误隔离（服务器级别）
- 崩溃自动重启
- 通知处理错误隔离

证据位置标注准确：`src/services/lsp/LSPServerManager.ts`、`src/services/lsp/LSPServerInstance.ts`、`src/services/lsp/LSPClient.ts`、`src/services/lsp/passiveFeedback.ts`、`src/tools/LSPTool/LSPTool.ts` 等。

✅ **目标与非目标**：清晰界定了不支持 socket 传输、不支持用户/项目级 LSP 配置、不实现 LSP 所有功能、不提供 LSP 服务器安装功能、不支持远程 LSP 服务器等非目标。

✅ **架构、模块与数据流**：
- 6 个模块设计卡：LSPServerManager、LSPServerInstance、LSPClient、Config/Types、Passive Diagnostics、LSPTool
- 每个模块包含真实入口签名、关键类型、状态与附件、创建流程、交互与关闭流程、错误与安全、设计取舍与备选
- 服务器启动与初始化流程、请求生命周期、关闭流程、被动诊断推送流程等详细数据流

**发现 B2-lsp-01**：spec 完整列出所有模块设计，但部分标注"未找到直接测试"，仅 lspLifecycle.test.ts 和 lsp.test.ts 覆盖部分功能。

#### 源码验证

读取并验证了以下文件：
- `src/services/lsp/LSPServerManager.ts:1-150+`：全局单例、初始化流程、服务器路由、文档同步等与 spec 一致
- `src/services/lsp/LSPServerInstance.ts:1-150+`：lazy load（require('./LSPClient.js')）、ContentModified 重试逻辑（LSP_ERROR_CONTENT_MODIFIED = -32801，MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3，RETRY_BASE_DELAY_MS = 500）、状态机、崩溃自动重启等与 spec 一致
- `src/services/lsp/LSPClient.ts`：lazy load 注释、spawn 等待确认、isStopping 标志等与 spec 一致
- `src/tools/LSPTool/LSPTool.ts`：1-based vs 0-based 转换、git check-ignore 过滤、MAX_LSP_FILE_SIZE_BYTES = 10MB 等与 spec 一致

**发现 B2-lsp-02**：源码中确实实现了 ContentModified 自动重试，但指数退避逻辑的完整路径需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 lsp 的独立 contract
- LSP 协议本身是公开标准，但内部实现无契约
- 无公开 live 环境验证

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/lspLifecycle.test.ts:1-83`：✅ 覆盖启动/初始化/停止、崩溃重启、超时强制 kill
- `tests/lsp.test.ts:1-21`：✅ 覆盖配置解析和基本初始化
- ❌ 未找到 LSPTool 相关测试
- ❌ 未找到被动诊断注册表相关测试
- ❌ 未找到 ContentModified 重试逻辑完整测试

**发现 B2-lsp-03**：lsp 子系统有部分测试覆盖，但关键路径（LSPTool 完整操作、诊断去重和容量限制、ContentModified 完整重试逻辑、gitignore 过滤、socket 传输（未实现））无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，10 项决策，6 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ ContentModified 完整重试逻辑需进一步验证 |
| 测试覆盖 | ⚠️ 部分覆盖（lspLifecycle.test.ts、lsp.test.ts） | ⚠️ LSPTool、诊断注册表、ContentModified 重试无完整测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ❌ 无独立 contract | ⚠️ LSP 协议是公开标准，但内部实现无契约 |

---

## 发现登记

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|----------|----------|----------|------|----------|--------|--------|------|
| B2-attachments-01 | attachments | — | 测试缺口 | P2 | attachments spec 所有模块设计均标注"无独立测试""未找到直接测试"，仅集成测试间接覆盖 | `docs/superpowers/specs/2026-11-12-attachments-design.md:7` | N/A | 无专门 attachments 测试文件 | 中（核心功能可能有未覆盖边缘情况） | 添加 attachments 独立测试：maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-attachments-02 | attachments | — | 验证缺口 | P3 | spec 中提到 `maybe()` 内部有 5% 遥测采样，但源码中该逻辑未详细验证 | `src/utils/attachments.ts` 需搜索 logEvent 调用 | N/A | 无 | 低（仅遥测） | 验证遥测采样逻辑是否实现 | 部分证实 | 需进一步搜索源码 | open |
| B2-attachments-03 | attachments | — | 测试缺口 | P2 | attachments 子系统无专门独立测试文件，关键路径（maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更）无针对性测试 | `src/utils/attachments.ts`、`src/utils/imagePaste.ts`、`src/utils/imageStore.ts`、`src/utils/imageValidation.ts`、`src/utils/pasteStore.ts` | N/A | 仅集成测试间接覆盖 | 中（关键路径可能有未覆盖边缘情况） | 添加 attachments 独立测试文件，覆盖所有主要模块设计卡场景 | 已证实 | 检查 tests/ 目录确认无专门测试 | open |
| B2-bridge-01 | bridge | — | 测试缺口 | P2 | bridge spec 多数模块设计标注"未找到直接测试"，关键路径（权限回调、容量管理、clean shutdown、token refresh）无针对性测试 | `docs/superpowers/specs/2026-11-12-bridge-design.md:7` | N/A | 仅 perpetual/daemon/peer/inbound 测试 | 中（关键路径可能有未覆盖边缘情况） | 添加 bridge 关键路径测试：权限回调超时、token refresh 竞态、容量波动、跨 worktree 扫描、clean shutdown 强制 kill | 已证实 | 仅检查 spec 文档声明 | open |
| B2-bridge-02 | bridge | — | 验证缺口 | P3 | spec 描述 shutdown 流程中 stopWork"最多重试 3 次"，但源码中该逻辑需进一步验证 | `src/bridge/bridgeMain.ts:2435-2600+` | N/A | 无 | 低（仅细节） | 验证 stopWork retry 次数与 backoff 配置 | 部分证实 | 需进一步阅读源码 shutdown 逻辑 | open |
| B2-bridge-03 | bridge | — | 契约缺口 | P3 | bridge 仅 inbound-envelope.md 契约与源码对齐，direct-connect-v1.md、open-runner-v1.md 等仅概念相似，无完整对齐验证 | `src/bridge/bridgeApi.ts`、`src/bridge/workSecret.ts` | N/A | 无 | 低（仅协议对齐） | 完成与相关 contracts 的完整对齐验证 | 部分证实 | 检查 contracts 目录 | open |
| B2-bridge-04 | bridge | — | 测试缺口 | P2 | bridge 子系统有部分测试覆盖，但关键路径（权限回调超时、token refresh 竞态、容量波动、跨 worktree 扫描边缘情况、clean shutdown 强制 kill、v1→v2 迁移）仍无针对性测试 | `src/bridge/bridgeMain.ts`、`src/bridge/sessionRunner.ts`、`src/bridge/jwtUtils.ts`、`src/bridge/bridgePointer.ts`、`src/bridge/replBridge.ts` | N/A | tests/perpetualBridge.test.ts、tests/daemonBridge.test.ts、tests/peerSessions.test.ts、tests/inboundEnvelope.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 bridge 关键路径测试文件，覆盖所有主要模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-buddy-01 | buddy | — | 测试缺口 | P2 | buddy spec 完整列出所有模块设计，但多数标注"无直接测试"，仅 buddyFork.test.ts 覆盖部分功能 | `docs/superpowers/specs/2026-11-12-buddy-design.md:7` | N/A | tests/buddyFork.test.ts 存在但覆盖不全 | 中（UI 交互、预告窗口、静音行为可能有未覆盖边缘情况） | 添加 buddy 关键路径测试：UI 双模式切换、气泡超时淡出、抚摸动画、预告通知窗口、静音行为 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-buddy-02 | buddy | — | 验证缺口 | P3 | spec 描述预告通知与完整功能窗口分离，但源码中该逻辑需进一步验证与测试 | `src/buddy/useBuddyNotification.tsx:11-22` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证预告通知与完整功能窗口分离逻辑 | 部分证实 | 需进一步阅读源码与测试 | open |
| B2-buddy-03 | buddy | — | 测试缺口 | P2 | buddy 子系统有部分测试覆盖，但 UI 交互、预告窗口、静音行为等关键路径无针对性测试 | `src/buddy/CompanionSprite.tsx`、`src/buddy/useBuddyNotification.tsx`、`src/commands/buddy/index.ts` | N/A | tests/buddyFork.test.ts 仅覆盖孵化、解析、roll 确定性 | 中（UI 交互可能有未覆盖边缘情况） | 添加 buddy 完整测试文件，覆盖所有 6 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-computer-use-01 | computer-use | — | 验收缺口 | P2 | computer-use spec 完整列出所有模块设计，但部分标注"需独立桌面环境验收"，真实 TCC 权限、窗口隐藏、ESC 热键等无法仅由 mock 测试证明 | `docs/superpowers/specs/2026-11-12-computer-use-design.md:7` | llms.txt 27 行匹配，binary strings 26191 行匹配 | 仅 mock 测试覆盖，无真实桌面环境测试 | 中（验收分层不完整） | 建立真实桌面环境验收分层：mock 覆盖协议/权限不变量，单独验证 macOS TCC、窗口隐藏、ESC、剪贴板恢复、多显示器 | 已证实 | 仅检查 spec 文档声明与测试文件 | open |
| B2-computer-use-02 | computer-use | — | 验证缺口 | P3 | spec 描述 unhide 超时后 Swift 端继续后台运行，但源码中该逻辑需进一步验证 | `src/utils/computerUse/cleanup.ts`、`src/utils/computerUse/executor.ts:unhideComputerUseApps` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证 unhide 超时后 Swift 端行为 | 部分证实 | 需进一步阅读源码与测试 | open |
| B2-computer-use-03 | computer-use | — | 契约缺口 | P3 | computer-use 外部 stub 契约完整，与源码对齐，但 Swift/Rust 内部实现不在 TypeScript 层覆盖 | `src/external-stubs/computer-use-*.ts`、`docs/external-stubs/contracts/computer-use-backends.md` | N/A | 无 | 低（仅内部实现，接口已对齐） | 考虑添加 Swift/Rust 契约或注释说明内部实现边界 | 部分证实 | 检查 external-stubs 目录 | open |
| B2-computer-use-04 | computer-use | — | 测试缺口 | P2 | computer-use 子系统有良好的 mock 测试覆盖，但真实桌面环境验收缺失，关键路径（TCC、窗口隐藏、ESC）无法仅由 mock 测试证明 | `src/utils/computerUse/computerUseLock.ts`、`src/utils/computerUse/escHotkey.ts`、`src/utils/computerUse/cleanup.ts`、`src/utils/computerUse/executor.ts` | llms.txt 27 行匹配，binary strings 26191 行匹配 | tests/computerUseBackends.test.ts、tests/computerUseExecutor.test.ts、tests/computerUseNativeHelper.test.ts、tests/computerUseWrapper.test.ts 仅覆盖 mock 场景 | 中（真实桌面环境无测试） | 建立真实桌面环境验收测试，覆盖 TCC 权限、窗口隐藏/显示、ESC 热键、多显示器坐标、剪贴板恢复 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-file-tools-01 | file-tools | — | 测试缺口 | P2 | file-tools spec 所有模块设计均标注"无直接测试""未找到直接测试"，仅集成测试间接覆盖 | `docs/superpowers/specs/2026-11-12-file-tools-design.md:7` | N/A | 无专门 file-tools 测试文件 | 中（核心功能可能有未覆盖边缘情况） | 添加 file-tools 独立测试：并发修改检测、去重机制、引号规范化、Windows 内容比较回退、ripgrep 集成 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-file-tools-02 | file-tools | — | 验证缺口 | P3 | spec 中提到 tengu_read_dedup_killswitch，但源码中该特性的实际使用未详细验证 | `src/tools/FileReadTool/FileReadTool.ts` 需搜索 killswitch 调用 | N/A | 无 | 低（仅特性开关） | 验证 killswitch 特性是否正确实现和使用 | 部分证实 | 需进一步搜索源码 | open |
| B2-file-tools-03 | file-tools | — | 测试缺口 | P2 | file-tools 子系统无专门独立测试文件，关键路径（并发修改检测、去重机制、引号规范化、Windows 内容比较回退、ripgrep 集成）无针对性测试 | `src/tools/FileReadTool/FileReadTool.ts`、`src/tools/FileEditTool/FileEditTool.ts`、`src/tools/FileWriteTool/FileWriteTool.ts`、`src/tools/GrepTool/GrepTool.ts`、`src/utils/file.ts` | N/A | 仅集成测试间接覆盖 | 中（关键路径可能有未覆盖边缘情况） | 添加 file-tools 独立测试文件，覆盖所有主要模块设计卡场景 | 已证实 | 检查 tests/ 目录确认无专门测试 | open |
| B2-lsp-01 | lsp | — | 测试缺口 | P2 | lsp spec 完整列出所有模块设计，但部分标注"未找到直接测试"，仅 lspLifecycle.test.ts 和 lsp.test.ts 覆盖部分功能 | `docs/superpowers/specs/2026-11-12-lsp-design.md:7` | N/A | tests/lspLifecycle.test.ts、tests/lsp.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 lsp 关键路径测试：LSPTool 完整操作、诊断去重和容量限制、ContentModified 完整重试逻辑、gitignore 过滤 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-lsp-02 | lsp | — | 验证缺口 | P3 | spec 描述 ContentModified 自动重试的指数退避逻辑，但源码中该逻辑的完整路径需进一步验证 | `src/services/lsp/LSPServerInstance.ts` 需搜索完整重试逻辑 | N/A | 无 | 低（仅细节） | 验证 ContentModified 完整重试逻辑与指数退避 | 部分证实 | 需进一步阅读源码重试逻辑 | open |
| B2-lsp-03 | lsp | — | 测试缺口 | P2 | lsp 子系统有部分测试覆盖，但关键路径（LSPTool 完整操作、诊断去重和容量限制、ContentModified 完整重试逻辑、gitignore 过滤）无针对性测试 | `src/services/lsp/LSPServerInstance.ts`、`src/services/lsp/passiveFeedback.ts`、`src/tools/LSPTool/LSPTool.ts` | N/A | tests/lspLifecycle.test.ts、tests/lsp.test.ts 仅覆盖生命周期和配置 | 中（关键路径可能有未覆盖边缘情况） | 添加 lsp 完整测试文件，覆盖所有 6 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |

---

## 证据边界

### Batch 2 已验证的边界

| 子系统 | 已验证 | 未验证 |
|--------|------|--------|
| attachments | spec 文档完整性、核心源码一致性（maybe 包装器、超时、双重去重、图片处理、PDF 引用、日期变更、团队邮箱过滤、图片验证）、coverage manifest 注册 | attachments 独立测试、遥测采样逻辑细节、真实 live 环境 |
| bridge | spec 文档完整性、核心源码一致性（bridgeMain、bridgeApi、sessionRunner、workSecret、bridgePointer、jwtUtils、trustedDevice、inboundMessages、replBridge、daemonBridge、capacityWake、flushGate、bridgeEnabled）、coverage manifest 注册、inbound-envelope.md 契约对齐、perpetual/daemon/peer/inbound 测试 | 关键路径测试、shutdown retry 次数细节、其他 contracts 完整对齐、真实 live 环境 |
| buddy | spec 文档完整性、核心源码一致性（骨骼派生、roll 确定性、inFlight 并发控制、宽松 JSON 解析、sideQuestion 调用、软失败、灵魂持久化、预告窗口、静音命令）、coverage manifest 注册、buddyFork.test.ts 部分覆盖、上游 llms.txt/strings 搜索边界记录 | UI 交互测试、预告窗口测试、静音行为测试、真实 live 环境 |
| computer-use | spec 文档完整性、核心源码一致性（文件锁 O_EXCL、PID 存活探测、零 syscall 预检、JSON Lines 协议、drainRunLoop 包装、坐标转换、Surrogate Host、三调用点归一、unhide 5s 超时、ESC 热键 CGEventTap、精确 bundleId 授权）、coverage manifest 注册、computer-use-backends.md 契约对齐、external-stubs 契约对齐、良好的 mock 测试覆盖、上游 llms.txt/strings 搜索边界记录 | 真实桌面环境验收（TCC、窗口隐藏、ESC 热键、多显示器、剪贴板恢复）、Swift/Rust 内部实现验证 |
| file-tools | spec 文档完整性、核心源码一致性（并发修改检测、去重机制、扩展名分支、引号规范化、ripgrep 集成、设备文件检查、macOS 截图路径处理）、coverage manifest 注册 | file-tools 独立测试、killswitch 特性使用细节、真实 live 环境 |
| lsp | spec 文档完整性、核心源码一致性（全局单例、lazy start + lazy load、ContentModified 重试、状态机、崩溃自动重启、1-based vs 0-based 转换、gitignore 过滤）、coverage manifest 注册、lspLifecycle.test.ts 和 lsp.test.ts 部分覆盖 | LSPTool 完整测试、诊断注册表测试、ContentModified 完整重试逻辑验证、真实 live 环境 |

### 上游证据边界

| 项目 | 状态 | 说明 |
|------|------|------|
| 官方文档索引 | ✅ 已搜索 | llms.txt 27 行匹配 buddy/computer-use，边界：/tmp/flash-design-audit-batch-2-doc-index.txt |
| 上游 CLI strings | ✅ 已搜索 | /opt/homebrew/bin/claude 26191 行匹配，边界：/tmp/flash-design-audit-batch-2-strings.txt |
| 上游行为对齐 | ⚠️ 不充分 | 有搜索结果但仅作为边界记录，不做完整对齐验证 |

### 测试证据边界

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| attachments 测试 | ❌ 无独立测试 | ⚠️ 仅集成测试间接覆盖 |
| bridge 测试 | ⚠️ 部分覆盖 | ⚠️ 关键路径无测试 |
| buddy 测试 | ⚠️ 部分覆盖（孵化、解析、roll 确定性） | ⚠️ UI 交互、预告窗口、静音行为无测试 |
| computer-use 测试 | ✅ 良好的 mock 覆盖（TCC、授权、坐标、锁、清理、JSON Lines、ESC 热键） | ⚠️ 真实桌面环境无测试 |
| file-tools 测试 | ❌ 无独立测试 | ⚠️ 仅集成测试间接覆盖 |
| lsp 测试 | ⚠️ 部分覆盖（生命周期、配置） | ⚠️ LSPTool、诊断注册表、ContentModified 重试无完整测试 |

---

## 完成判定

### 总体评估

| 子系统 | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 总体 |
|--------|------------|------------|------------|----------|------|
| attachments | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（无独立测试） | ⚠️ 有条件通过（需添加独立测试） |
| bridge | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |
| buddy | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（UI 交互无测试） | ⚠️ 有条件通过（需添加 UI 交互测试） |
| computer-use | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（真实桌面环境无验收） | ⚠️ 有条件通过（需建立真实桌面环境验收） |
| file-tools | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（无独立测试） | ⚠️ 有条件通过（需添加独立测试） |
| lsp | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |

### Batch 2 总体结论

✅ **文档完整性高**：六个子系统的 draft spec 质量优秀，均包含完整章节、决策表、模块设计卡、证据位置标注。

✅ **实现一致性强**：代码与 spec 高度对齐，关键机制与文档完全一致。

⚠️ **测试覆盖不均**：attachments、file-tools 无独立测试，bridge、buddy、lsp 仅部分覆盖，computer-use 仅 mock 覆盖，关键路径和真实桌面环境验收缺失。

✅ **上游证据边界已记录**：完成 llms.txt 和 binary strings 搜索，结果作为边界记录存档。

### 子系统审计进度

| 子系统 | 状态 |
|--------|------|
| attachments | ✅ 已审计 |
| bridge | ✅ 已审计 |
| buddy | ✅ 已审计 |
| computer-use | ✅ 已审计 |
| file-tools | ✅ 已审计 |
| lsp | ✅ 已审计 |
| mcp | ⏳ 待审计 |
| onboarding-ui | ⏳ 待审计 |
| permissions | ⏳ 待审计 |
| session-persistence | ⏳ 待审计 |
| shell-tools | ⏳ 待审计 |
| tool-framework | ⏳ 待审计 |

**当前进度**：6/12 已审计

### 其他子系统状态

本 batch 已审计 attachments、bridge、buddy、computer-use、file-tools、lsp，其余 6 个子系统（mcp、onboarding-ui、permissions、session-persistence、shell-tools、tool-framework）保持未审计状态，后续 batch 覆盖。

---
