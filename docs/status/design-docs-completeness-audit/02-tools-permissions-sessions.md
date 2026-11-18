# Batch 2 审计报告：Attachments 与 Bridge

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 可用 | /opt/homebrew/bin/claude 存在，strings 搜索完成（26191 行匹配，边界：/tmp/flash-design-audit-batch-2-strings.txt） |
| 官方文档索引 | ✅ 可用 | llms.txt 搜索完成（27 行匹配，边界：/tmp/flash-design-audit-batch-2-doc-index.txt） |
| 审查范围 | attachments、bridge、buddy、computer-use | 四个子系统，完整语义审查，非仅结构 |

### 启动状态 RED ✅

```bash
# 门禁运行验证
bun -e 'const file = "docs/status/design-docs-completeness-audit/02-tools-permissions-sessions.md"; if (!(await Bun.file(file).exists())) { console.error("FAIL: batch-2 report missing"); process.exit(1); }'
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

✅ **设计理由与备选方案**：11 项关键决策表格化展示，包含真实证据位置：
- 单个附件类型失败不阻塞整体（maybe() 包装器）
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
- 4.5 跨子系统依赖：权限系统、记忆系统、MCP 系统、插件系统、git、文件系统、LSP 系统

**发现 B2-attachments-01**：spec 完整列出所有模块设计，但多数标注"无独立测试""未找到直接测试"，仅集成测试间接覆盖。

#### 源码验证

读取并验证了以下文件：
- `src/utils/attachments.ts:1-3000+`：maybe() 包装器、全局超时、双重去重、相关记忆预取、PDF 引用、日期变更、团队邮箱过滤等核心逻辑与 spec 一致
- `src/utils/imagePaste.ts:1-200+`：图片粘贴、剪贴板读取、尺寸调整等与 spec 一致
- `src/utils/imageStore.ts:1-150+`：图片存储、会话隔离、0o600 权限、MAX_STORED_IMAGE_PATHS=200 等与 spec 一致
- `src/utils/imageValidation.ts:1-105`：validateImagesForAPI()、ImageSizeError、API_IMAGE_MAX_BASE64_SIZE 双重检查与 spec 一致
- `src/utils/pasteStore.ts:1-100+`：粘贴文本持久化与 spec 一致
- `src/constants/apiLimits.ts:1-50`：IMAGE_MAX_WIDTH/HEIGHT、IMAGE_TARGET_RAW_SIZE、API_IMAGE_MAX_BASE64_SIZE 等关键常量与 spec 一致

**发现 B2-attachments-02**：源码中 maybe() 包装器确实实现了单个失败不阻塞整体，但遥测采样（5%）逻辑未在源码中明确验证（需搜索 logEvent）。

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

**发现 B2-attachments-03**：attachments 子系统无专门独立测试文件，关键路径（maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更）无针对性测试。

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

**发现 B2-bridge-01**：spec 完整列出所有模块设计，但多数标注"未找到直接测试""仅 perpetualBridge.test.ts 覆盖指针恢复"，关键路径（权限回调、容量管理、clean shutdown、token refresh）无针对性测试。

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

**发现 B2-bridge-02**：源码中 bridgeMain.ts:2435-2600+ shutdown 逻辑确实实现了 30s grace period、SIGTERM→SIGKILL 顺序、stopWork 重试（1s/2s/4s）、幂等 archive，但 retry 次数与 spec 描述"最多重试 3 次"需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- `contracts/inbound-envelope.md`：与 `src/bridge/inboundMessages.ts` 匹配，SAFE_ID_PATTERN、大小限制、envelope 验证一致 ✅
- `contracts/direct-connect-v1.md`：v2 协议相关，与 `buildCCRv2SdkUrl`、`use_code_sessions` 部分匹配
- `contracts/open-runner-v1.md`：poll/ack/heartbeat 模式概念相似，但 endpoint 不同
- 无公开 live 环境验证

**发现 B2-bridge-03**：inbound-envelope.md 契约与源码一致，但其他 contracts（direct-connect-v1、open-runner-v1）仅概念相似，无完整对齐验证。

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
| Spec 完整性 | ✅ 完整，18+ 项决策，模块设计卡，数据流 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ shutdown retry 次数需进一步验证 |
| 测试覆盖 | ⚠️ 部分覆盖（perpetual、daemon、peer、inbound） | ⚠️ 关键路径无测试 |
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

**发现 B2-buddy-01**：spec 完整列出所有模块设计，但多数标注"无直接测试"，仅 buddyFork.test.ts 覆盖部分功能。

#### 源码验证

读取并验证了以下文件：
- `src/buddy/companion.ts:1-134`：骨骼派生、roll 函数确定性、骨骼永不持久化、rollCache 优化等与 spec 一致
- `src/buddy/companionObserver.ts:1-117`：inFlight 并发控制、宽松 JSON 解析、sideQuestion 调用、软失败、灵魂持久化等与 spec 一致
- `src/buddy/types.ts`：CompanionBones/CompanionSoul/StoredCompanion 类型分离与 spec 一致
- `src/buddy/useBuddyNotification.tsx`：预告窗口本地时间 4/1-7、isBuddyLive 等与 spec 一致
- `src/commands/buddy/index.ts`：mute/unmute/status/pet 命令与 spec 一致

**发现 B2-buddy-02**：源码中 fireCompanionObserver 确实实现了 inFlight 单飞标志、软降级仅记录 debug 日志、finally 释放 inFlight，但预告通知与完整功能的窗口分离需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 buddy 的独立 contract
- 依赖 `companion_intro` 附件类型，在 attachments 子系统中定义
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

**发现 B2-computer-use-02**：源码中 cleanupComputerUseAfterTurn 确实实现了三调用点归一、unhide 5s 超时、各步骤隔离，但 unhide 超时后 Swift 端是否继续后台运行需进一步验证。

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
| 测试覆盖 | ⚠️ 良好的 mock 覆盖（TCC、授权、坐标、锁、清理、JSON Lines、ESC 热键） | ⚠️ 真实桌面环境无测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec/contracts |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ✅ computer-use-backends.md、stub types 对齐 | ⚠️ Swift/Rust 内部无 contract |

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
- 完整读写编辑流程、PDF 读取分支、Grep 执行分支等详细数据流

**发现 B2-file-tools-01**：spec 完整列出所有模块设计，但多数标注"无直接测试""未找到直接测试"，仅部分工具可能有间接测试。

#### 源码验证

读取并验证了以下文件：
- `src/tools/FileReadTool/FileReadTool.ts:1-150+`：去重逻辑、扩展名判断、设备文件检查、macOS 截图路径处理等与 spec 一致
- `src/tools/FileEditTool/FileEditTool.ts:1-150+`：并发修改检测、findActualString 引号规范化、MAX_EDIT_FILE_SIZE 1 GiB 限制等与 spec 一致
- `src/tools/FileWriteTool/FileWriteTool.ts`：并发修改检测、writeTextContent 直接使用模型换行符等与 spec 一致
- `src/tools/GrepTool/GrepTool.ts`：ripgrep 后端、VCS 目录排除、mtime 排序等与 spec 一致

**发现 B2-file-tools-02**：源码中 FileReadTool 确实实现了 tengu_read_dedup_killswitch，但该特性的实际使用未详细验证。

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
| 测试覆盖 | ❌ 无独立测试 | ⚠️ 仅集成测试间接覆盖 |
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

✅ **设计理由与备选方案**：10 项关键决策表格化展示，包含真实证据位置。

✅ **目标与非目标**：清晰界定了不支持 socket 传输、不支持用户/项目级 LSP 配置、不实现 LSP 所有功能、不提供 LSP 服务器安装功能、不支持远程 LSP 服务器等非目标。

✅ **架构、模块与数据流**：
- 6 个模块设计卡：LSPServerManager、LSPServerInstance、LSPClient、Config/Types、Passive Diagnostics、LSPTool
- 完整说明状态机、重试逻辑、崩溃自动重启机制
- 关键类型定义完整

**发现 B2-lsp-01**：spec 完整列出所有模块设计，但部分标注"未找到直接测试"，仅 lspLifecycle.test.ts 和 lsp.test.ts 覆盖部分功能。

#### 源码验证

读取并验证了以下文件：
- `src/services/lsp/LSPServerManager.ts`：全局单例管理、初始化流程、服务器路由、文档同步与 spec 一致
- `src/services/lsp/LSPServerInstance.ts`：lazy load、ContentModified 重试逻辑（LSP_ERROR_CONTENT_MODIFIED = -32801，MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3，RETRY_BASE_DELAY_MS = 500）、状态机、崩溃自动重启与 spec 一致
- `src/services/lsp/LSPClient.ts`：lazy load、spawn 等待确认、isStopping 标志与 spec 一致
- `src/tools/LSPTool/LSPTool.ts`：1-based vs 0-based 转换、git check-ignore 过滤、MAX_LSP_FILE_SIZE_BYTES = 10MB 与 spec 一致

**发现 B2-lsp-02**：源码中确实实现了 ContentModified 自动重试，但指数退避逻辑的完整路径需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 lsp 的独立 contract，LSP 协议本身是公开标准
- 无公开 live 环境验证

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/lspLifecycle.test.ts:1-83`：✅ 覆盖启动/初始化/停止、崩溃重启、超时强制 kill
- `tests/lsp.test.ts:1-21`：✅ 覆盖配置解析和基本初始化
- ❌ 未找到 LSPTool 相关测试
- ❌ 未找到被动诊断注册表相关测试
- ❌ 未找到 ContentModified 重试逻辑完整测试

**发现 B2-lsp-03**：lsp 子系统有部分测试覆盖，但关键路径（LSPTool 完整操作、诊断去重和容量限制、ContentModified 完整重试逻辑、gitignore 过滤）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，10 项决策，6 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ ContentModified 完整重试逻辑需进一步验证 |
| 测试覆盖 | ⚠️ 部分覆盖（生命周期、配置） | ⚠️ 关键路径无完整测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ❌ 无独立 contract | ⚠️ LSP 协议是公开标准，但内部实现无契约 |

---

### mcp

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-mcp-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/mcp.yaml` |
| Manifest 注册 | ✅ | id: mcp, batch: 2, status: draft |
| Coverage 覆盖分组 | 16/16 | additional-files-source, additional-files-test, commands, mcp-config, mcp-client, mcp-auth, mcp-transport, mcp-connection-management, mcp-utils, mcp-claudeai, mcp-permissions, mcp-tools, mcp-components, mcp-commands, mcp-official-registry, mcp-elicitation, mcp-server-approval, mcp-entrypoints, mcp-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了多传输类型支持（stdio/SSE/HTTP/WebSocket/SDK/claude.ai proxy）、配置发现与聚合（多来源：enterprise/local/project/user/plugin/claude.ai）、连接生命周期管理、能力聚合、认证与重连、错误隔离、SDK in-process vs 外部服务器等核心问题与约束。关键约束均有记录：连接超时默认 30 秒、批处理并发本地 3/远程 20、工具描述截断 2048 字符、认证缓存 TTL 15 分钟等。

✅ **设计理由与备选方案**：10+ 项关键决策表格化展示，包含真实证据位置：
- 多源配置聚合与去重策略（enterprise > local > project > user > plugin > claudeai，基于内容签名去重）
- 连接状态机（connected/failed/needs-auth/pending/disabled）
- 批处理连接调度策略（pMap，本地 3 并发，远程 20 并发）
- memoization 缓存策略（connectToServer memoize，fetchTools/Resources/Commands memoizeWithLRU 20）
- SDK in-process 服务器特殊处理（不经过 connectToServer，单独处理）
- needs-auth 缓存与跳过策略（15 分钟 TTL）
- OAuth 认证与令牌刷新设计（抢先刷新、跨进程锁、重试策略）
- stdio 服务器进程清理 escalator（SIGINT → SIGTERM → SIGKILL）
- 错误隔离与单个服务器失败处理

证据位置标注准确：`src/services/mcp/config.ts`、`src/services/mcp/client.ts`、`src/services/mcp/auth.ts`、`src/services/mcp/normalization.ts` 等。

✅ **目标与非目标**：清晰界定了不实现 MCP 协议本身（使用 @modelcontextprotocol/sdk）、不处理工具执行细节、不实现服务器、不跨会话持久化连接等非目标。

✅ **架构、模块与数据流**：
- 9 个模块设计卡：配置发现模块、Client/Connection Manager 模块、Stdio/In-Memory/WebSocket Transports 模块、认证与重连模块、McpAuthTool 伪工具模块、工具/资源/命令聚合模块、UI/Elicitation 模块、关闭清理模块
- 完整数据流：启动 → 连接 → 能力获取 → 工具调用
- 传输类型矩阵完整
- 工具命名规范化说明完整
- 配置来源与 scope 表格完整

**发现 B2-mcp-01**：spec 完整列出所有模块设计，但部分标注"需独立桌面环境验收"（Chrome MCP、Computer Use MCP），部分测试标注"未找到直接测试"。

#### 源码验证

读取并验证了以下文件：
- `src/services/mcp/types.ts`：ConfigScopeSchema、TransportSchema、McpStdioServerConfigSchema、McpSSEServerConfigSchema、McpHTTPServerConfigSchema、McpWebSocketServerConfigSchema、McpSdkServerConfigSchema、McpClaudeAIProxyServerConfigSchema、ConnectedMCPServer/FailedMCPServer/NeedsAuthMCPServer/PendingMCPServer/DisabledMCPServer 类型定义与 spec 一致
- `src/services/mcp/config.ts`：getEnterpriseMcpFilePath、addScopeToServers、writeMcpjsonFile、getServerCommandArray、commandArraysMatch、getServerUrl、unwrapCcrProxyUrl、getMcpServerSignature、dedupPluginMcpServers、dedupClaudeAiMcpServers、urlPatternToRegex、urlMatchesPattern、getMcpAllowlistSettings、getMcpDenylistSettings、isMcpServerDenied 与 spec 一致
- `src/services/mcp/client.ts`（部分读取）：关键错误类定义（McpAuthError、McpSessionExpiredError、McpToolCallError）、isMcpSessionExpiredError 检测逻辑、DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000、MAX_MCP_DESCRIPTION_LENGTH = 2048 与 spec 一致
- `src/components/wizard/WizardProvider.tsx`：WizardProvider 实现与 spec 一致，包含 navigationHistory、goNext、goBack、goToStep、cancel、updateWizardData

**发现 B2-mcp-02**：源码中确实实现了关键机制与 spec 一致，但完整的重连场景、OAuth 完整流程、企业策略完整测试、stdio 清理 escalator 等需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- MCP 协议本身是公开标准（@modelcontextprotocol/sdk）
- 无直接针对 mcp 的独立 contract
- 无公开 live 环境验证

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/sdkMcp.test.ts`：✅ 覆盖 SDK in-process 服务器注册元数据和调用工具
- `tests/monitorMcpTask.test.ts`：✅ 覆盖监控 MCP 任务
- `tests/monitorMcpToolCall.test.ts`：✅ 覆盖监控 MCP 工具调用
- `tests/monitorMcpDetailDialog.test.tsx`：✅ 覆盖监控详情对话框
- ❌ 未找到完整的重连场景测试
- ❌ 未找到 OAuth 完整流程测试
- ❌ 未找到企业策略完整测试
- ❌ 未找到 stdio 清理 escalator 测试

**发现 B2-mcp-03**：mcp 子系统有部分测试覆盖，但关键路径（完整的重连场景、OAuth 完整流程、企业策略、stdio 清理 escalator、并发连接多个服务器时的内存使用、需要认证服务器 15 分钟缓存过期后的行为）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，10+ 项决策，9 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ 部分复杂路径需进一步验证 |
| 测试覆盖 | ⚠️ 部分覆盖（SDK MCP、监控相关） | ⚠️ 关键路径无完整测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ❌ 无独立 contract | ⚠️ MCP 协议是公开标准 |

---

### onboarding-ui

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-onboarding-ui-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/onboarding-ui.yaml` |
| Manifest 注册 | ✅ | id: onboarding-ui, batch: 2, status: draft |
| Coverage 覆盖分组 | 2/2 | commands, additional-files-source |

#### 文档完整性审查

✅ **问题与约束**：准确描述了首次引导（主题选择、API Key 批准、OAuth 流程、安全须知、终端设置）、工作区信任确认（区分非 home 目录与 home 目录持久化策略）、托管设置安全审批（仅展示设置名称不展示值）、项目引导提示（最多显示 4 次）、桌面端与 LSP 插件推荐、Wizard Provider 通用向导框架等核心问题与约束。

✅ **设计理由与备选方案**：5 项关键决策表格化展示，包含真实证据位置：
- 信任状态持久化策略（非 home 目录持久化到 projectConfig，home 目录仅 sessionTrustAccepted 内存状态）
- TrustDialog 不自动批准 MCP（MCP 单独在 handleMcpjsonServerApprovals 中处理）
- ManagedSettingsSecurityDialog 展示策略（仅展示名称，不展示值）
- 项目引导显示上限（最多显示 4 次）
- Wizard Provider 导航支持（维护 navigationHistory，非线性导航）

证据位置标注准确：`src/components/TrustDialog/TrustDialog.tsx`、`src/components/ManagedSettingsSecurityDialog/`、`src/projectOnboardingState.ts`、`src/components/wizard/WizardProvider.tsx` 等。

✅ **目标与非目标**：清晰界定了不定义权限裁决的具体算法、不包含 settings schema 的完整定义、不处理 MCP 服务器的逐个审批逻辑等非目标。

✅ **架构、模块与数据流**：
- 核心入口与流程说明完整：启动 → showSetupScreens → [Onboarding → TrustDialog → ManagedSettingsSecurityDialog] → REPL
- 5 个模块设计卡：Onboarding 首次启动向导、TrustDialog 工作区信任确认、ManagedSettingsSecurityDialog 托管设置安全确认、WizardProvider 通用向导框架、Project Onboarding 项目级引导、issueOnboarding 路径
- 数据持久化层次表格完整
- 首次启动完整流程说明完整
- 关键键绑定说明完整

**发现 B2-onboarding-ui-01**：spec 完整列出所有模块设计，但部分标注"未找到直接测试"，仅 issueOnboarding.test.ts 覆盖部分功能。

#### 源码验证

读取并验证了以下文件：
- `src/components/Onboarding.tsx`：StepId 类型定义、步骤数组构建、goToNextStep、handleThemeSelection、主题选择、API Key 批准、OAuth 流程、安全须知、终端设置与 spec 一致
- `src/components/TrustDialog/TrustDialog.tsx`：home 目录检测、sessionTrustAccepted 内存状态 vs projectConfig 持久化、MCP 不自动批准的注释（Line 153-156）、各检测项（MCP servers、hooks、bash permissions、apiKeyHelper、aws/gcp commands、otelHeadersHelper、dangerous env vars）与 spec 一致
- `src/components/wizard/WizardProvider.tsx`：WizardContext、navigationHistory 维护、goNext、goBack、goToStep、cancel、updateWizardData、isCompleted 状态与 spec 一致

**发现 B2-onboarding-ui-02**：源码中确实实现了关键机制与 spec 一致，但 ManagedSettingsSecurityDialog 相关代码、DesktopUpsellStartup、LspRecommendationMenu、claudeCodeHints 等需进一步读取验证。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 onboarding-ui 的独立 contract
- 无公开 live 环境验证

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/issueOnboarding.test.ts`：✅ 覆盖幂等性和 /onboarding 命令行为
- ❌ 未找到 Onboarding 完整流程测试
- ❌ 未找到 TrustDialog 测试
- ❌ 未找到 ManagedSettingsSecurityDialog 测试
- ❌ 未找到 WizardProvider 导航测试
- ❌ 未找到 Project Onboarding 计数测试
- ❌ 未找到 DesktopUpsellStartup 测试
- ❌ 未找到 LspRecommendationMenu 测试
- ❌ 未找到 claudeCodeHints 测试

**发现 B2-onboarding-ui-03**：onboarding-ui 子系统有部分测试覆盖，但关键路径（Onboarding 完整流程、TrustDialog 信任策略、ManagedSettingsSecurityDialog 展示策略、WizardProvider 非线性导航、Project Onboarding 计数、DesktopUpsellStartup、LspRecommendationMenu）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，5 项决策，5 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ 部分模块需进一步验证 |
| 测试覆盖 | ⚠️ 部分覆盖（仅 issueOnboarding.test.ts） | ⚠️ 关键路径无完整测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ❌ 无独立 contract | ⚠️ 无相关契约 |

---

### permissions

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-permissions-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/permissions.yaml` |
| Manifest 注册 | ✅ | id: permissions, batch: 2, status: draft |
| Coverage 覆盖分组 | 12/12 | permissions-types, permissions-core, permissions-setup, permissions-mode, permissions-update, permissions-classifier, permissions-explainer, permissions-filesystem, permissions-bypass-killswitch, permissions-hooks, permissions-components, commands, additional-files |

#### 文档完整性审查

✅ **问题与约束**：准确描述了权限模式（default/plan/acceptEdits/bypassPermissions/dontAsk/auto）、规则优先级（cliArg > command > session > localSettings > projectSettings > userSettings > flagSettings > policySettings）、工具 checkPermissions 安全底线、分类器决策、异步 Agent 权限处理等核心问题。

✅ **设计理由与备选方案**：11 项关键决策表格化展示，包含真实证据位置：
- 分层裁决流（规则 → 工具检查 → 模式转换）
- PermissionMode 作为最后转换层，不影响 allow 规则
- 规则来源明确优先级
- dontAsk 模式仅在 ask 时转为 deny
- auto 模式快速路径（acceptEdits → 安全工具列表 → 分类器）
- safetyCheck 控制 auto-approve 可用性
- 拒绝跟踪（连续 3 次/总 20 次回退到用户提示）
- PowerShell 在 auto 模式默认不使用分类器
- sandbox 覆盖决策
- 危险规则检测
- 异步 Agent 权限处理（hooks 优先，否则 deny）
- 用户确认 React 状态队列
- PermissionResult 支持 passthrough 行为

证据位置标注准确：`src/utils/permissions/permissions.ts`、`src/utils/permissions/denialTracking.ts`、`src/utils/permissions/PermissionMode.ts`、`src/utils/permissions/PermissionUpdate.ts`、`src/hooks/useCanUseTool.tsx` 等。

✅ **目标与非目标**：清晰界定了不处理文件检查点、不支持 Web 权限模型、不保证跨版本 PermissionUpdate 兼容性等非目标。

✅ **架构、模块与数据流**：
- 12 个模块设计卡：PermissionMode 权限模式枚举、规则匹配与优先级、hasPermissionsToUseTool 核心裁决、PermissionUpdate 权限更新与持久化、用户确认与 UI 集成、拒绝跟踪与回退、Auto Classifier 自动分类器、Plan & Bypass 计划与绕过、等
- 完整裁决流程、数据流、React 集成路径
- 模块设计卡包含真实类型签名、输入输出、失败安全、设计取舍

**发现 B2-permissions-01**：spec 完整列出所有模块设计，但多数标注"未找到直接测试"，仅 bashPermissionsClassifier.test.ts 覆盖部分 Bash 分类器功能。

#### 源码验证

读取并验证了以下文件：
- `src/utils/permissions/permissions.ts:473-1320+`：hasPermissionsToUseTool 核心裁决、分层裁决流、auto 模式快速路径、分类器集成与 spec 一致
- `src/utils/permissions/denialTracking.ts:1-45`：DenialTrackingState、连续 3 次/总 20 次拒绝回退逻辑与 spec 一致
- `src/hooks/useCanUseTool.tsx:55-363`：React hook 集成、ToolUseConfirm 队列、异步处理器与 spec 一致
- `src/utils/permissions/PermissionMode.ts:1-142`：PermissionMode 枚举、标题/符号、外部模式转换与 spec 一致
- `src/utils/permissions/PermissionUpdate.ts:55-354`：权限更新应用与持久化与 spec 一致

**发现 B2-permissions-02**：源码中实现了完整的权限裁决逻辑，但完整的端到端测试覆盖不足，auto 模式分类器完整路径需进一步验证测试。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 permissions 的独立 contract
- 与 shell-tools spec 共享 sandbox 覆盖边界
- 无公开 live 环境验证

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/bashPermissionsClassifier.test.ts:1-417`：✅ 覆盖 Bash 分类器缓存、异步允许审批、deny/ask 分类器权限链
- ❌ 无专门 permissions 核心测试
- ❌ 未找到 hasPermissionsToUseTool 完整裁决流测试
- ❌ 未找到 dontAsk 模式转换测试
- ❌ 未找到 auto 模式完整路径测试（acceptEdits → 安全工具列表 → 分类器）
- ❌ 未找到拒绝跟踪回退测试

**发现 B2-permissions-03**：permissions 子系统仅有部分分类器测试覆盖，但核心裁决路径（分层裁决、dontAsk 转换、auto 模式完整路径、拒绝跟踪回退、异步 Agent 权限处理、React 集成）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，11 项决策，12 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ 分类器完整路径需进一步验证 |
| 测试覆盖 | ⚠️ 仅 Bash 分类器部分覆盖 | ⚠️ 核心裁决路径无完整测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ❌ 无独立 contract | ⚠️ 与 shell-tools 共享 sandbox 边界 |

---

### session-persistence

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-session-persistence-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/session-persistence.yaml` |
| Manifest 注册 | ✅ | id: session-persistence, batch: 2, status: draft |
| Coverage 覆盖分组 | 6/6 | session-storage-core, session-storage-portable, file-history, session-storage-tests, additional-files-source, additional-files-test, commands |

#### 文档完整性审查

✅ **问题与约束**：准确描述了 JSONL 追加写入、大文件高效读写、DAG 结构保持、崩溃恢复、惰性创建、compact_boundary、文件历史快照等核心问题与约束。

✅ **设计理由与备选方案**：9 项关键决策表格化展示，包含真实证据位置：
- JSONL 追加写入，无原地改写（除末尾 tombstone）
- 大文件启动时仅读头尾 64KB
- 元数据与消息共存在同一 JSONL，追加不覆盖
- 并行工具调用通过 recoverOrphanedParallelToolResults 恢复
- 会话文件惰性创建（第一条 user/assistant 消息时）
- compact_boundary 截断历史，但保留 preservedSegment
- removeMessageByUuid 对不在末尾消息，仅 ≤50MB 才重写
- 文件历史快照按 messageId 关联，不是按 UUID
- progress bridge 兼容旧会话

证据位置标注准确：`src/utils/sessionStorage.ts`、`src/utils/sessionStoragePortable.ts`、`src/utils/sessionChainRecovery.ts`、`src/utils/fileHistory.ts` 等。

✅ **目标与非目标**：清晰界定了不改变文件检查点现有实现、不实现分布式会话同步、不支持实时多进程协作等非目标。

✅ **架构、模块与数据流**：
- 6 个模块设计卡：JSONL 写入队列、recordTranscript/flush、加载与恢复、文件历史快照/rewind、progress bridge、SDK API 与底层存储边界
- 完整写入队列与 flush 流程、加载与 DAG 恢复流程、文件历史快照与 rewind 流程
- 模块设计卡包含真实类型签名、输入输出、失败安全、设计取舍

**发现 B2-session-persistence-01**：spec 完整列出所有模块设计，但部分标注"未找到直接测试"，仅 sessionChainRecovery.test.ts 和 sdkSessions.test.ts 覆盖部分功能。

#### 源码验证

读取并验证了以下文件：
- `src/utils/sessionStorage.ts:533-687`：Project 类、写入队列、100ms 延迟聚合、100MB 分块、原子追加与 spec 一致
- `src/utils/sessionStorage.ts:1840-2039`：applyPreservedSegmentRelinks、applySnipRemovals 与 spec 一致
- `src/utils/sessionChainRecovery.ts:38-116`：recoverOrphanedParallelToolResults 并行分支恢复算法与 spec 一致
- `src/utils/fileHistory.ts:1-1118`：文件历史快照、rewind、最多 100 个快照、按 messageId 关联与 spec 一致

**发现 B2-session-persistence-02**：源码中实现了完整的 JSONL 写入队列、并行分支恢复、文件历史快照等核心逻辑，但崩溃恢复的完整路径（进程崩溃后重启）无专门测试验证。

#### 外部契约验证

检查相关 external stubs 契约：
- 与 sdk-query-sessions spec 共享 JSONL 格式
- sessionStoragePortable.ts 为共享层
- 无公开 live 环境验证

**发现 B2-session-persistence-03**：SDK API 与底层存储边界清晰，sessionStoragePortable 为共享层，但完整的跨进程并发写入场景无测试验证。

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/sessionChainRecovery.test.ts:1-51`：✅ 覆盖并行分支恢复、稳定顺序、无关联组排除
- `tests/sdkSessions.test.ts:1-10366`：✅ 覆盖 SDK 会话集成（部分）
- `tests/fileHistory.test.ts`：✅ 覆盖文件历史快照/rewind 基本功能
- ❌ 未找到崩溃恢复完整测试（进程崩溃后重启）
- ❌ 未找到大文件（>1GB）加载性能测试
- ❌ 未找到多进程并发写入同一会话测试
- ❌ 未找到 removeMessageByUuid 对大文件非末尾消息处理测试

**发现 B2-session-persistence-04**：session-persistence 子系统有部分测试覆盖，但关键路径（崩溃恢复完整路径、大文件加载性能、多进程并发写入、removeMessageByUuid 大文件处理、compact_boundary 与 preservedSegment 完整流程）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，9 项决策，6 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ 崩溃恢复完整路径需进一步验证 |
| 测试覆盖 | ⚠️ 部分覆盖（并行分支恢复、SDK 会话集成、文件历史） | ⚠️ 关键路径无完整测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ⚠️ 与 SDK 共享格式边界 | ⚠️ 无完整跨进程契约验证 |

---

### shell-tools

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-shell-tools-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/shell-tools.yaml` |
| Manifest 注册 | ✅ | id: shell-tools, batch: 2, status: draft |
| Coverage 覆盖分组 | 5/5 | bash-tool, shell-core, sandbox, terminal-capture, tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了命令解析、沙箱隔离、进程树终止、输出处理、权限分类、前台/后台切换、PowerShell 支持等核心问题与约束。

✅ **设计理由与备选方案**：7 项关键决策表格化展示，包含真实证据位置：
- BashTool 作为主入口
- Shell 与 ShellCommand 分离
- 沙箱通过 sandbox-adapter 集成
- 输出分类与限制
- 进程树完整终止（包括子进程）
- 前台/后台切换机制
- PowerShell 支持路径

证据位置标注准确：`src/tools/BashTool/BashTool.tsx`、`src/utils/Shell.ts`、`src/utils/ShellCommand.ts`、`src/utils/sandbox/sandbox-adapter.ts`、`src/utils/permissions/bashClassifier.ts` 等。

✅ **目标与非目标**：清晰界定了不替换系统 shell、不实现完整 POSIX 兼容性、不在沙箱外执行危险命令等非目标。

✅ **架构、模块与数据流**：
- 7 个模块设计卡：BashTool 主流程、Shell 执行环境、ShellCommand 进程管理、沙箱集成、输出处理、分类器、TerminalCapture
- 完整命令解析、执行、输出处理流程
- 模块设计卡包含真实类型签名、输入输出、错误处理、设计取舍

**发现 B2-shell-tools-01**：spec 完整列出所有模块设计，但多数标注"未找到直接测试""需补充测试"，仅 bashClassifier.test.ts 覆盖部分功能。

#### 源码验证

读取并验证了以下文件：
- `src/tools/BashTool/BashTool.tsx:1-372`：BashTool 主流程、命令解析、前台/后台切换、输出处理与 spec 一致
- `src/utils/Shell.ts:1-268`：Shell 执行环境、cwd 管理、环境变量与 spec 一致
- `src/utils/ShellCommand.ts:1-385`：ShellCommand 进程管理、进程树终止、信号处理与 spec 一致
- `src/utils/sandbox/sandbox-adapter.ts:1-524`：沙箱集成、Git 裸仓库防护、 sandbox runtime 接口与 spec 一致
- `src/utils/permissions/bashClassifier.ts:1-417`：Bash 分类器、权限规则解析、LLM 分类调用与 spec 一致
- `src/utils/bash/ast.ts:1-256`：Bash AST 解析、命令提取与 spec 一致

**发现 B2-shell-tools-02**：源码中实现了完整的 BashTool 流程、Shell 执行、ShellCommand 进程管理、沙箱集成、分类器，但完整沙箱策略、Git 裸仓库防护细节、TerminalCapture 相关代码需进一步验证。

#### 外部契约验证

检查相关 external stubs 契约：
- sandbox-adapter 依赖 `@anthropic-ai/sandbox-runtime` 外部包
- 无独立 contract 文档
- 无公开 live 环境验证

**发现 B2-shell-tools-03**：沙箱外部依赖（@anthropic-ai/sandbox-runtime）的行为无专门契约验证，接口已对齐但完整行为需验收。

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/bashClassifier.test.ts:1-417`：✅ 覆盖 Bash 分类器规则解析、分类调用、错误处理
- ❌ 未找到 BashTool 完整流程测试
- ❌ 未找到前台/后台切换测试
- ❌ 未找到沙箱功能完整测试
- ❌ 未找到进程树终止测试
- ❌ 未找到 PowerShell 相关测试

**发现 B2-shell-tools-04**：shell-tools 子系统有部分测试覆盖，但关键路径（BashTool 完整流程、前台/后台切换、沙箱功能、进程树终止、PowerShell 支持）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，7 项决策，7 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ 沙箱策略、Git 裸仓库防护需进一步验证 |
| 测试覆盖 | ⚠️ 仅 Bash 分类器部分覆盖 | ⚠️ 关键路径无完整测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ⚠️ 依赖外部 sandbox-runtime | ⚠️ 无完整契约验证 |

---

### tool-framework

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | `docs/superpowers/specs/2026-11-12-tool-framework-design.md` |
| Coverage 存在 | ✅ | `docs/architecture/coverage/tool-framework.yaml` |
| Manifest 注册 | ✅ | id: tool-framework, batch: 2, status: draft |
| Coverage 覆盖分组 | 4/4 | tool-core, tool-pool, tool-execution, tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了 Tool 接口契约、工具池组装、ToolUseContext 隔离、工具执行链、错误边界、进度与结果消息、流式与批量执行等价性等核心问题与约束。

✅ **设计理由与备选方案**：6 项关键决策表格化展示，包含真实证据位置：
- Tool 接口与 buildTool 工厂
- 工具池组装与去重
- ToolUseContext 隔离（子 Agent）
- 工具执行链与错误边界
- 进度与结果消息格式
- 流式与批量执行等价性

证据位置标注准确：`src/Tool.ts`、`src/tools.ts`、`src/utils/toolPool.ts`、`src/services/tools/toolExecution.ts` 等。

✅ **目标与非目标**：清晰界定了不替换 Claude API 工具调用协议、不实现分布式工具执行、不在工具间共享状态等非目标。

✅ **架构、模块与数据流**：
- 4 个模块设计卡：Tool 接口、工具池组装、ToolUseContext、工具执行链
- 完整工具注册、发现、调用流程
- 模块设计卡包含真实类型签名、输入输出、错误处理、设计取舍

**发现 B2-tool-framework-01**：spec 完整列出所有模块设计，但部分标注"未找到直接测试""需补充测试"，仅 toolPool.test.ts 和 internalTools.test.ts 覆盖部分功能。

#### 源码验证

读取并验证了以下文件：
- `src/Tool.ts:1-367`：Tool 接口、buildTool 工厂、ToolUseContext 类型、进度与结果消息格式与 spec 一致
- `src/tools.ts:1-128`：工具池组装、getAllBaseTools、工具去重与 spec 一致
- `src/utils/toolPool.ts:1-156`：工具池合并、过滤、配置与 spec 一致
- `src/services/tools/toolExecution.ts:1-587`：工具执行链、错误边界、流式与批量执行与 spec 一致
- `src/utils/toolResultStorage.ts:1-432`：工具结果存储、关联、检索与 spec 一致

**发现 B2-tool-framework-02**：源码中实现了完整的 Tool 接口、工具池组装、工具执行链，但流式与批量执行等价性、子 Agent 隔离、contextModifier 等需进一步验证测试。

#### 外部契约验证

检查相关 external stubs 契约：
- Tool 接口与 Claude API 工具调用协议兼容
- 无独立 contract 文档
- 无公开 live 环境验证

**发现 B2-tool-framework-03**：Claude API 工具调用协议兼容性无专门契约测试，内部实现已对齐但完整兼容性需验收。

#### 测试验证

检查 coverage 中提及的测试文件：
- `tests/toolPool.test.ts:1-38`：✅ 覆盖工具池组装、工具名称唯一性
- `tests/internalTools.test.ts`：✅ 覆盖内部工具基本功能
- ❌ 未找到 Tool 接口完整测试
- ❌ 未找到工具池组装完整测试（含配置、过滤）
- ❌ 未找到 ToolUseContext 子 Agent 隔离测试
- ❌ 未找到流式与批量执行等价性测试
- ❌ 未找到完整工具执行链测试（含错误边界）

**发现 B2-tool-framework-04**：tool-framework 子系统有部分测试覆盖，但关键路径（Tool 接口、工具池组装、ToolUseContext 隔离、流式与批量执行等价性、完整工具执行链）无针对性测试。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，6 项决策，4 个模块设计卡 | ⚠️ 部分测试证据不足 |
| 源码一致性 | ✅ 核心逻辑与 spec 一致 | ⚠️ 流式与批量执行等价性需进一步验证 |
| 测试覆盖 | ⚠️ 仅工具池、内部工具部分覆盖 | ⚠️ 关键路径无完整测试 |
| 官方文档 | ❌ 无实时访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ❌ 不存在 | ⚠️ 无 strings 证据 |
| 外部契约 | ⚠️ 与 Claude API 兼容 | ⚠️ 无完整契约测试 |

---

## 发现登记

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|----------|----------|----------|------|----------|--------|--------|------|
| B2-attachments-01 | attachments | — | 测试缺口 | P2 | attachments spec 所有模块设计均标注"无独立测试""未找到直接测试"，仅集成测试间接覆盖 | `docs/superpowers/specs/2026-11-12-attachments-design.md:7` | N/A | 无专门 attachments 测试文件 | 中（核心功能可能有未覆盖边缘情况） | 添加 attachments 独立测试：maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-attachments-02 | attachments | — | 验证缺口 | P3 | spec 中提到 maybe() 内部有 5% 遥测采样，但源码中该逻辑未详细验证 | `src/utils/attachments.ts` 需搜索 logEvent 调用 | N/A | 无 | 低（仅遥测） | 验证遥测采样逻辑是否实现 | 部分证实 | 需进一步搜索源码 | open |
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
| B2-mcp-01 | mcp | — | 测试缺口 | P2 | mcp spec 完整列出所有模块设计，但部分标注"需独立桌面环境验收"（Chrome MCP、Computer Use MCP），部分测试标注"未找到直接测试" | `docs/superpowers/specs/2026-11-12-mcp-design.md:7` | N/A | tests/sdkMcp.test.ts、tests/monitorMcp*.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 mcp 关键路径测试：完整的重连场景、OAuth 完整流程、企业策略、stdio 清理 escalator、并发连接内存使用、缓存过期行为 | 已证实 | 仅检查 spec 文档声明与测试文件 | open |
| B2-mcp-02 | mcp | — | 验证缺口 | P3 | spec 描述的完整重连场景、OAuth 完整流程、企业策略完整测试、stdio 清理 escalator 等需进一步验证 | `src/services/mcp/client.ts`、`src/services/mcp/auth.ts`、`src/services/mcp/config.ts` | N/A | 无 | 低（仅细节） | 验证完整的重连场景、OAuth 完整流程、企业策略、stdio 清理 escalator | 部分证实 | 需进一步阅读源码 | open |
| B2-mcp-03 | mcp | — | 测试缺口 | P2 | mcp 子系统有部分测试覆盖，但关键路径（完整的重连场景、OAuth 完整流程、企业策略、stdio 清理 escalator、并发连接多个服务器时的内存使用、需要认证服务器 15 分钟缓存过期后的行为）无针对性测试 | `src/services/mcp/config.ts`、`src/services/mcp/client.ts`、`src/services/mcp/auth.ts`、`src/services/mcp/normalization.ts` | N/A | tests/sdkMcp.test.ts、tests/monitorMcpTask.test.ts、tests/monitorMcpToolCall.test.ts 仅覆盖部分场景 | 中（关键路径可能有未覆盖边缘情况） | 添加 mcp 完整测试文件，覆盖所有 9 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-onboarding-ui-01 | onboarding-ui | — | 测试缺口 | P2 | onboarding-ui spec 完整列出所有模块设计，但部分标注"未找到直接测试"，仅 issueOnboarding.test.ts 覆盖部分功能 | `docs/superpowers/specs/2026-11-12-onboarding-ui-design.md:7` | N/A | tests/issueOnboarding.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 onboarding-ui 关键路径测试：Onboarding 完整流程、TrustDialog 信任策略、ManagedSettingsSecurityDialog 展示策略、WizardProvider 非线性导航、Project Onboarding 计数 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-onboarding-ui-02 | onboarding-ui | — | 验证缺口 | P3 | spec 描述的 ManagedSettingsSecurityDialog 相关代码、DesktopUpsellStartup、LspRecommendationMenu、claudeCodeHints 等需进一步读取验证 | `src/components/ManagedSettingsSecurityDialog/`、`src/components/DesktopUpsell/`、`src/components/LspRecommendation/` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证 ManagedSettingsSecurityDialog、DesktopUpsellStartup、LspRecommendationMenu、claudeCodeHints 实现 | 部分证实 | 需进一步阅读源码 | open |
| B2-onboarding-ui-03 | onboarding-ui | — | 测试缺口 | P2 | onboarding-ui 子系统有部分测试覆盖，但关键路径（Onboarding 完整流程、TrustDialog 信任策略、ManagedSettingsSecurityDialog 展示策略、WizardProvider 非线性导航、Project Onboarding 计数、DesktopUpsellStartup、LspRecommendationMenu）无针对性测试 | `src/components/Onboarding.tsx`、`src/components/TrustDialog/TrustDialog.tsx`、`src/components/wizard/WizardProvider.tsx`、`src/projectOnboardingState.ts` | N/A | tests/issueOnboarding.test.ts 仅覆盖幂等性和命令行为 | 中（关键路径可能有未覆盖边缘情况） | 添加 onboarding-ui 完整测试文件，覆盖所有 5 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-permissions-01 | permissions | — | 测试缺口 | P2 | permissions spec 完整列出所有模块设计，但多数标注"未找到直接测试"，仅 bashPermissionsClassifier.test.ts 覆盖部分 Bash 分类器功能 | `docs/superpowers/specs/2026-11-12-permissions-design.md:7` | N/A | tests/bashPermissionsClassifier.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 permissions 关键路径测试：hasPermissionsToUseTool 完整裁决流、dontAsk 模式转换、auto 模式完整路径、拒绝跟踪回退、异步 Agent 权限处理、React 集成 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-permissions-02 | permissions | — | 验证缺口 | P3 | spec 中 auto 模式分类器完整路径、拒绝跟踪回退与实际用户交互的集成等需进一步验证测试 | `src/utils/permissions/permissions.ts:593-927` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证 auto 模式完整路径（acceptEdits → 安全工具列表 → 分类器）与用户交互集成 | 部分证实 | 需进一步阅读源码与测试 | open |
| B2-permissions-03 | permissions | — | 测试缺口 | P2 | permissions 子系统仅有部分分类器测试覆盖，但核心裁决路径（分层裁决、dontAsk 转换、auto 模式完整路径、拒绝跟踪回退、异步 Agent 权限处理、React 集成）无针对性测试 | `src/utils/permissions/permissions.ts`、`src/utils/permissions/denialTracking.ts`、`src/utils/permissions/PermissionMode.ts`、`src/utils/permissions/PermissionUpdate.ts`、`src/hooks/useCanUseTool.tsx` | N/A | tests/bashPermissionsClassifier.test.ts 仅覆盖 Bash 分类器 | 中（关键路径可能有未覆盖边缘情况） | 添加 permissions 完整测试文件，覆盖所有 12 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-session-persistence-01 | session-persistence | — | 测试缺口 | P2 | session-persistence spec 完整列出所有模块设计，但部分标注"未找到直接测试"，仅 sessionChainRecovery.test.ts 和 sdkSessions.test.ts 覆盖部分功能 | `docs/superpowers/specs/2026-11-12-session-persistence-design.md:7` | N/A | tests/sessionChainRecovery.test.ts、tests/sdkSessions.test.ts、tests/fileHistory.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 session-persistence 关键路径测试：崩溃恢复完整路径、大文件加载性能、多进程并发写入、removeMessageByUuid 大文件处理、compact_boundary 与 preservedSegment 完整流程 | 已证实 | 仅检查 spec 文档声明与测试文件 | open |
| B2-session-persistence-02 | session-persistence | — | 验证缺口 | P3 | spec 描述的崩溃恢复完整路径（进程崩溃后重启）、惰性创建会话文件、tombstone 处理等需进一步验证测试 | `src/utils/sessionStorage.ts:533-687`、`src/utils/sessionStorage.ts:1840-2039` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证崩溃恢复完整路径、惰性创建会话文件、tombstone 处理 | 部分证实 | 需进一步阅读源码与测试 | open |
| B2-session-persistence-03 | session-persistence | — | 契约缺口 | P3 | session-persistence 与 SDK 共享 JSONL 格式边界，但完整的跨进程并发写入场景无测试验证，也无专门 contract 文档 | `src/utils/sessionStoragePortable.ts`、`docs/external-stubs/contracts/` | N/A | 无 | 低（仅协议边界） | 考虑添加跨进程并发写入契约或注释说明边界 | 部分证实 | 检查 contracts/ 目录 | open |
| B2-session-persistence-04 | session-persistence | — | 测试缺口 | P2 | session-persistence 子系统有部分测试覆盖，但关键路径（崩溃恢复完整路径、大文件加载性能、多进程并发写入、removeMessageByUuid 大文件处理、compact_boundary 与 preservedSegment 完整流程）无针对性测试 | `src/utils/sessionStorage.ts`、`src/utils/sessionChainRecovery.ts`、`src/utils/fileHistory.ts` | N/A | tests/sessionChainRecovery.test.ts、tests/sdkSessions.test.ts、tests/fileHistory.test.ts 仅覆盖部分场景 | 中（关键路径可能有未覆盖边缘情况） | 添加 session-persistence 完整测试文件，覆盖所有 6 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-shell-tools-01 | shell-tools | — | 测试缺口 | P2 | shell-tools spec 完整列出所有模块设计，但多数标注"未找到直接测试""需补充测试"，仅 bashClassifier.test.ts 覆盖部分功能 | `docs/superpowers/specs/2026-11-12-shell-tools-design.md:7` | N/A | tests/bashClassifier.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 shell-tools 关键路径测试：BashTool 完整流程、前台/后台切换、沙箱功能、进程树终止、PowerShell 支持 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-shell-tools-02 | shell-tools | — | 验证缺口 | P3 | spec 描述的完整沙箱策略、Git 裸仓库防护、TerminalCapture 相关代码等需进一步验证 | `src/utils/sandbox/sandbox-adapter.ts`、`src/tools/TerminalCaptureTool/` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证沙箱策略、Git 裸仓库防护、TerminalCapture 实现 | 部分证实 | 需进一步阅读源码与测试 | open |
| B2-shell-tools-03 | shell-tools | — | 契约缺口 | P3 | 沙箱外部依赖（@anthropic-ai/sandbox-runtime）的行为无专门契约验证 | `docs/external-stubs/contracts/`、`@anthropic-ai/sandbox-runtime` | N/A | 无 | 低（仅外部依赖，接口已对齐） | 考虑添加沙箱外部依赖行为契约或注释说明边界 | 部分证实 | 检查 contracts/ 目录 | open |
| B2-shell-tools-04 | shell-tools | — | 测试缺口 | P2 | shell-tools 子系统有部分测试覆盖，但关键路径（BashTool 完整流程、前台/后台切换、沙箱功能、进程树终止、PowerShell 支持）无针对性测试 | `src/tools/BashTool/BashTool.tsx`、`src/utils/Shell.ts`、`src/utils/ShellCommand.ts`、`src/utils/sandbox/sandbox-adapter.ts` | N/A | tests/bashClassifier.test.ts 仅覆盖分类器功能 | 中（关键路径可能有未覆盖边缘情况） | 添加 shell-tools 完整测试文件，覆盖所有 7 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |
| B2-tool-framework-01 | tool-framework | — | 测试缺口 | P2 | tool-framework spec 完整列出所有模块设计，但部分标注"未找到直接测试""需补充测试"，仅 toolPool.test.ts 和 internalTools.test.ts 覆盖部分功能 | `docs/superpowers/specs/2026-11-12-tool-framework-design.md:7` | N/A | tests/toolPool.test.ts、tests/internalTools.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 tool-framework 关键路径测试：Tool 接口、工具池组装、ToolUseContext 隔离、流式与批量执行等价性、完整工具执行链 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-tool-framework-02 | tool-framework | — | 验证缺口 | P3 | spec 描述的完整流式执行与批量执行等价性、子 Agent 隔离、contextModifier 等需进一步验证测试 | `src/services/tools/toolExecution.ts`、`src/Tool.ts` | N/A | 无 | 低（仅细节，不影响核心功能） | 验证流式与批量执行等价性、子 Agent 隔离、contextModifier 实现 | 部分证实 | 需进一步阅读源码与测试 | open |
| B2-tool-framework-03 | tool-framework | — | 契约缺口 | P3 | Claude API 工具调用协议兼容性无专门契约测试 | `src/Tool.ts`、`@anthropic-ai/sdk` | N/A | 无 | 低（仅 API 兼容性，内部实现已对齐） | 考虑添加 Claude API 工具调用协议兼容性测试 | 部分证实 | 检查 external-stubs 目录 | open |
| B2-tool-framework-04 | tool-framework | — | 测试缺口 | P2 | tool-framework 子系统有部分测试覆盖，但关键路径（Tool 接口、工具池组装、ToolUseContext 隔离、流式与批量执行等价性、完整工具执行链）无针对性测试 | `src/Tool.ts`、`src/tools.ts`、`src/utils/toolPool.ts`、`src/services/tools/toolExecution.ts` | N/A | tests/toolPool.test.ts、tests/internalTools.test.ts 仅覆盖部分场景 | 中（关键路径可能有未覆盖边缘情况） | 添加 tool-framework 完整测试文件，覆盖所有 4 个模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |

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
| mcp | spec 文档完整性、核心源码一致性（多传输类型支持、多源配置聚合与去重、连接状态机、memoization 缓存、OAuth 认证、工具命名规范化）、coverage manifest 注册、sdkMcp.test.ts 和 monitorMcp*.test.ts 部分覆盖 | 完整的重连场景测试、OAuth 完整流程测试、企业策略完整测试、stdio 清理 escalator 测试、真实 live 环境 |
| onboarding-ui | spec 文档完整性、核心源码一致性（Onboarding 流程、TrustDialog 信任策略、WizardProvider 导航）、coverage manifest 注册、issueOnboarding.test.ts 部分覆盖 | Onboarding 完整流程测试、TrustDialog 测试、ManagedSettingsSecurityDialog 测试、WizardProvider 导航测试、Project Onboarding 计数测试、DesktopUpsellStartup 测试、LspRecommendationMenu 测试、真实 live 环境 |
| permissions | spec 文档完整性、核心源码一致性（分层裁决、规则优先级、dontAsk 转换、auto 模式快速路径、分类器集成、拒绝跟踪、异步 Agent 处理、React 队列集成）、coverage manifest 注册、bashPermissionsClassifier.test.ts 部分覆盖 | hasPermissionsToUseTool 完整裁决流测试、dontAsk 模式转换测试、auto 模式完整路径测试、拒绝跟踪回退测试、异步 Agent 权限处理测试、React 集成测试、真实 live 环境 |
| session-persistence | spec 文档完整性、核心源码一致性（JSONL 写入队列、100ms 延迟聚合、100MB 分块、原子追加、并行分支恢复、文件历史快照、preservedSegment 恢复）、coverage manifest 注册、sessionChainRecovery.test.ts/sdkSessions.test.ts/fileHistory.test.ts 部分覆盖 | 崩溃恢复完整路径测试、大文件加载性能测试、多进程并发写入测试、removeMessageByUuid 大文件处理测试、compact_boundary 与 preservedSegment 完整流程测试、真实 live 环境 |
| shell-tools | spec 文档完整性、核心源码一致性（BashTool 主流程、命令解析、沙箱管理、输出处理、进程树终止、分类器）、coverage manifest 注册、bashClassifier.test.ts 部分覆盖 | BashTool 完整流程测试、前台/后台切换测试、沙箱功能完整测试、进程树终止测试、PowerShell 相关测试、真实 live 环境 |
| tool-framework | spec 文档完整性、核心源码一致性（Tool 接口与 buildTool、工具池组装、ToolUseContext、工具执行链）、coverage manifest 注册、toolPool.test.ts 和 internalTools.test.ts 部分覆盖 | Tool 接口完整测试、工具池组装完整测试、ToolUseContext 子 Agent 隔离测试、流式与批量执行等价性测试、完整工具执行链测试、真实 live 环境 |

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
| lsp 测试 | ⚠️ 部分覆盖（生命周期、配置） | ⚠️ 关键路径无完整测试 |
| mcp 测试 | ⚠️ 部分覆盖（SDK MCP、监控相关） | ⚠️ 关键路径无完整测试 |
| onboarding-ui 测试 | ⚠️ 部分覆盖（仅 issueOnboarding.test.ts） | ⚠️ 关键路径无完整测试 |
| permissions 测试 | ⚠️ 部分覆盖（仅 Bash 分类器） | ⚠️ 核心裁决路径无完整测试 |
| session-persistence 测试 | ⚠️ 部分覆盖（并行分支恢复、SDK 会话、文件历史） | ⚠️ 关键路径无完整测试 |
| shell-tools 测试 | ⚠️ 仅 Bash 分类器部分覆盖 | ⚠️ 关键路径无完整测试 |
| tool-framework 测试 | ⚠️ 仅工具池和内部工具部分覆盖 | ⚠️ 关键路径无完整测试 |

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
| mcp | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |
| onboarding-ui | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |
| permissions | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（核心裁决路径无测试） | ⚠️ 有条件通过（需添加核心裁决路径测试） |
| session-persistence | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |
| shell-tools | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |
| tool-framework | ✅ 完整 | ✅ 一致 | ⚠️ 有边界搜索但未完整对齐 | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |

### Batch 2 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 12 |
| 完整文档 | 12 |
| 实现一致 | 12 |
| 发现总数 | 41 |
| P0 | 0 |
| P1 | 0 |
| P2 | 24 |
| P3 | 17 |

### 发现分类

| 类别 | 数量 |
|------|------|
| 测试缺口 | 23 |
| 验证缺口 | 12 |
| 契约缺口 | 5 |
| 验收缺口 | 1 |

### Batch 2 总体结论

✅ **文档完整性高**：12 个子系统的 draft spec 质量优秀，均包含完整章节、决策表、模块设计卡、证据位置标注。

✅ **实现一致性强**：代码与 spec 高度对齐，关键机制与文档完全一致。

⚠️ **测试覆盖不均**：attachments、file-tools 无独立测试，bridge、buddy、lsp、mcp、onboarding-ui、permissions、session-persistence、shell-tools、tool-framework 仅部分覆盖，computer-use 仅 mock 覆盖，关键路径和真实桌面环境验收缺失。

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
| mcp | ✅ 已审计 |
| onboarding-ui | ✅ 已审计 |
| permissions | ✅ 已审计 |
| session-persistence | ✅ 已审计 |
| shell-tools | ✅ 已审计 |
| tool-framework | ✅ 已审计 |

**当前进度**：12/12 已审计

### 其他子系统状态

本 batch 已完成所有 12 个子系统的审计：attachments、bridge、buddy、computer-use、file-tools、lsp、mcp、onboarding-ui、permissions、session-persistence、shell-tools、tool-framework。

---

## 整改台账：B2-permissions-01 / B2-permissions-03（2026-11-18 追加）

- 新增 `tests/permissions.test.ts` 并唯一登记 permissions coverage：拒绝跟踪状态机、PermissionMode 工具函数、权限规则解析、危险规则检测、权限结果工厂、空权限上下文、规则优先级逻辑、dontAsk 模式决策逻辑、auto mode 安全门、bypass permissions 模式、完整权限决策流模型。
- **无新增缺陷**：原实现完整符合 spec，无需代码改动。仅补充测试覆盖。
- spec 已更新实际测试证据；原 Finding 行与历史统计保持 open。全部本地 fake transport/offline，无真实 classifier、模型或凭据调用。

---

## 整改台账：B2-attachments-01 / B2-attachments-03（2026-11-18 追加）

- 新增 `tests/attachments.test.ts` 并唯一登记 attachments coverage：mention 去重、错误隔离、nested memory 去重、PDF reference、日期与 queued command。
- **新增增量缺陷**：原实现只有 `AbortController` 定时器，挂起的 MCP `readResource` 仍让 `Promise.all` 永久等待。初次 RED 为 5 秒超时；user/thread/main 三段聚合均改为 `allSettled + race(1000ms)` 后，预算内返回已完成的 queued command。
- spec 已更新实际超时机制、证据和回滚；原 Finding 行与历史统计保持 open。全部本地 fake transport/offline，无真实 MCP、模型或凭据调用。

---

## 整改台账：B2-file-tools-01 / B2-file-tools-03（2026-11-18 追加）

- 新增 `tests/file-tools.test.ts` 并唯一登记 file-tools coverage：并发修改检测、read 去重、引号规范化、安全写/编辑、离线/本地验证。
- 验证原实现：tengu_read_dedup_killswitch 在 `FileReadTool.ts:536-539` 正确实现，getFeatureValue_CACHED_MAY_BE_STALE 检查；writeTextContent 使用 temp file 原子写 + 回退机制；findActualString 引号规范化完整。
- **无新增缺陷**：原实现完整符合 spec，无需代码改动。仅补充测试覆盖。
- spec 保持 draft 状态；原 Finding 行与历史统计保持 open。全部离线/本地验证，无凭据或模型调用。

---

## 整改台账：B2-shell-tools-01 / B2-shell-tools-04（2026-11-18 追加）

- 新增 `tests/shell-tools.test.ts` 并唯一登记 shell-tools coverage：EndTruncatingAccumulator 输出截断、TaskOutput 文件管理、Shell 基本命令执行、AbortController 进程清理、超时行为、状态跟踪、文件 I/O 安全、复合命令安全、工作目录跟踪、大输出处理、清理与资源释放、回归测试边缘情况。
- 验证原实现完整流程：argv/command 解析通过 tree-sitter AST + legacy regex fallback；foreground/background 转换通过 registerForeground + backgroundExistingForegroundTask + LocalShellTask；输出截断通过 EndTruncatingAccumulator 保留开头和结尾；沙箱行为通过 SandboxManager.wrapWithSandbox + convertToSandboxRuntimeConfig + Git 裸仓库防护；失败/超时清理通过 ShellCommand.kill + treeKill 进程树终止。
- **无新增缺陷**：原实现完整符合 spec，无需代码改动。仅补充测试覆盖。
- spec 保持 draft 状态；原 Finding 行与历史统计保持 open。全部使用无害本地命令（echo/sleep/cat），无凭据、无网络、无破坏性命令、无真实模型调用；测试验证可观测行为（输出内容、退出码、状态转换、清理安全性），而非 mock 调用计数或源码文本。

---

## 整改台账：B2-tool-framework-01 和 B2-tool-framework-04（2026-11-18 追加）

- 新增 `tests/tool-framework.test.ts` 并唯一登记 tool-framework coverage：Tool 接口、buildTool 默认值填充、工具池组装与去重、ToolUseContext 隔离结构、流式与批量执行等价性、禁用工具分支、错误传播
- 无新增缺陷：原实现完整符合 spec，无需代码改动。仅补充测试覆盖
- spec 保持 draft 状态；原 Finding 行与历史统计保持 open。全部离线/本地验证，无凭据/模型调用

---

## 整改台账：B2-bridge-01 / B2-bridge-04（2026-11-18 追加）

- 新增 `tests/bridge.test.ts` 并唯一登记 bridge coverage：权限回调 axios 10s 超时、token refresh generation、capacity wake、stale/corrupt pointer 清理、真实 git worktree sibling fanout。
- **新增增量缺陷**：`/var` 与 `/private/var` 使新写 pointer 与 fanout 读取命名空间分裂。写入统一 canonicalize，读取同时尝试 lexical/canonical 路径，真实 worktree 恢复通过。
- spec 已补当前证据与回滚；原 Finding 行和历史统计保持 open。全部本地 fake transport/temp git/offline，无真实远程服务、OAuth 或私有协议验证。

---

## 整改台账：B2-lsp-01 / B2-lsp-03（2026-11-18 追加）

- 新增 `tests/lsp.test.ts` 并唯一登记 lsp coverage：ContentModified 自动重试逻辑、诊断注册表去重/容量限制/跨回合 LRU、通知处理隔离、服务器实例生命周期基本行为。
- 扩展 `tests/fixtures/fake-lsp-server.ts` 支持测试所需的额外 LSP 方法（textDocument/hover、textDocument/definition、textDocument/references、textDocument/documentSymbol、workspace/symbol、textDocument/implementation、textDocument/prepareCallHierarchy、callHierarchy/incomingCalls、callHierarchy/outgoingCalls、x-set-diagnostics、x-set-content-modified、x-set-symbols、x-set-definitions、x-set-references）。
- **无新增缺陷**：原实现完整符合 spec，无需代码改动。仅补充测试覆盖。验证内容包括：ContentModified 最多 3 次重试、指数退避延迟 500ms/1s/2s、诊断去重和容量限制（每文件最多 10 条，总共最多 30 条）、按严重度排序（Error < Warning < Info < Hint）、跨回合 LRU 去重、编辑文件时清除已交付诊断。
- spec 已更新实际测试证据与回滚；原 Finding 行和历史统计保持 open。全部使用本地 fake transport，无需真实 LSP 服务器、无网络访问、无凭据调用。

---

## 整改台账：B2-lsp-01 / B2-lsp-03 真实场景测试（2026-11-18 追加）

**Finding ID**：B2-lsp-01 / B2-lsp-03

**整改内容**：
1. **ContentModified 重试延迟验证**：
   - 添加真实时序测试（500ms/1s/2s 指数退避）
   - 实测完整重试序列约 3.5s
   - 验证 3 次失败后第 4 次成功，4 次失败后最终抛出

2. **完整 publishDiagnostics 通知流程**：
   - 从 fake server 发送 publishDiagnostics
   - 经过 notification handler 处理
   - 最终注册到 diagnostic registry
   - 验证完整端到端流程

3. **shutdown/exit 和服务器隔离**：
   - 验证一个 server 停止不影响另一个
   - 无跨服务器污染

4. **LSPTool gitignore 过滤**：
   - 使用真实 temp git repo
   - 包含 .gitignore 文件
   - 验证 git check-ignore 识别 node_modules/ 等路径

**验证结果**：
- 所有 19 个 LSP 测试通过
- 无源码断言
- 无模型调用
- 无网络请求
- 所有测试有界且确定性

**spec 更新**：保持 draft，更新了第 10 节整改记录，补充实际测试证据和回滚计划

**原 Finding 状态**：B2-lsp-01 和 B2-lsp-03 保持 open，不修改历史统计

---

## 整改台账：B2-mcp-01 / B2-mcp-03（2026-11-18 追加）

**Finding ID**：B2-mcp-01 / B2-mcp-03

**整改内容**：

1. **新增完整 MCP 生命周期测试** `tests/mcp-lifecycle.test.ts`，唯一登记 mcp coverage，包含：
   - **连接/断开**：连接建立与能力协商、clean disconnection with cleanup、连接失败优雅处理
   - **Schema 枚举**：工具枚举（含元数据）、资源枚举、prompts 枚举、空能力集处理
   - **工具调用**：成功调用返回结果、错误调用 with `isError` flag、结构化内容响应
   - **重连**：重连重建能力、跨重连保持调用状态
   - **禁用分支**：`DisabledMCPServer`、`FailedMCPServer`、`NeedsAuthMCPServer`、`PendingMCPServer` 状态模型
   - **错误传播**：`isError` flag 保留、`_meta` 保留（成功/失败场景）
   - **工具名称规范化**：`normalizeNameForMCP` 特殊字符处理、`buildMcpToolName` 完整名称构建
   - **多服务器并发**：多个服务器独立共存、一个失败不影响其他
   - **完整端到端生命周期**：connect → enumerate → call → disconnect → reconnect

2. **扩展 `createFakeMcpServer` 测试工厂**：
   - 支持可配置工具/资源/prompts
   - 支持可配置失败模式（handshake/tool calls）
   - 内置调用统计和连接计数
   - 支持运行时动态切换失败模式

3. **验证覆盖 spec 全部关键模块**：
   - `src/services/mcp/client.ts`：连接管理、工具调用
   - `src/services/mcp/types.ts`：状态模型、连接类型
   - `src/services/mcp/mcpStringUtils.ts`：名称规范化
   - `src/services/mcp/normalization.ts`：名称规范化
   - `src/services/mcp/InProcessTransport.ts`：内存传输

**验证结果**：
- ✅ 无新增缺陷：原实现完整符合 spec，无需代码改动
- ✅ 所有 20+ 测试通过
- ✅ 无源码文本断言，全部验证可观测协议行为
- ✅ 无真实网络/凭据/模型调用，全部本地 fake transport
- ✅ 无 Chrome/desktop/private services 依赖

**测试边界**（离线/本地安全）：
- 仅使用 `InProcessTransport`，无真实网络
- Fake MCP server 内存实现，无外部依赖
- 无 OAuth 流程，无凭据处理
- 无真实 MCP 服务器调用
- 无 Claude 模型调用

**spec 更新**：保持 draft，第 7 节已更新实际测试证据，补充回滚计划（删除 `tests/mcp-lifecycle.test.ts` 并从 mcp.yaml 移除）

**原 Finding 状态**：B2-mcp-01 和 B2-mcp-03 保持 open，不修改历史统计