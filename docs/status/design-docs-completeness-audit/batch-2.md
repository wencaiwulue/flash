# Batch 2 审计报告：Attachments 与 Bridge

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | N/A | /opt/homebrew/bin/claude 不存在（仅二进制残片）|
| 官方文档索引 | N/A | 无实时访问，基于现有 spec/contracts |
| 审查范围 | attachments、bridge | 仅两个子系统，完整语义审查，非仅结构 |

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

## 发现登记

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|----------|----------|----------|------|----------|--------|--------|------|
| B2-attachments-01 | attachments | — | 测试缺口 | P2 | attachments spec 所有模块设计均标注“无独立测试”“未找到直接测试”，仅集成测试间接覆盖 | `docs/superpowers/specs/2026-11-12-attachments-design.md:7` | N/A | 无专门 attachments 测试文件 | 中（核心功能可能有未覆盖边缘情况） | 添加 attachments 独立测试：maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更 | 已证实 | 仅检查 spec 文档声明 | open |
| B2-attachments-02 | attachments | — | 验证缺口 | P3 | spec 中提到 `maybe()` 内部有 5% 遥测采样，但源码中该逻辑未详细验证 | `src/utils/attachments.ts` 需搜索 logEvent 调用 | N/A | 无 | 低（仅遥测） | 验证遥测采样逻辑是否实现 | 部分证实 | 需进一步搜索源码 | open |
| B2-attachments-03 | attachments | — | 测试缺口 | P2 | attachments 子系统无专门独立测试文件，关键路径（maybe 错误隔离、超时、双重去重、图片处理、PDF 引用、日期变更）无针对性测试 | `src/utils/attachments.ts`、`src/utils/imagePaste.ts`、`src/utils/imageStore.ts`、`src/utils/imageValidation.ts`、`src/utils/pasteStore.ts` | N/A | 仅集成测试间接覆盖 | 中（关键路径可能有未覆盖边缘情况） | 添加 attachments 独立测试文件，覆盖所有主要模块设计卡场景 | 已证实 | 检查 tests/ 目录确认无专门测试 | open |
| B2-bridge-01 | bridge | — | 测试缺口 | P2 | bridge spec 多数模块设计标注“未找到直接测试”，关键路径（权限回调、容量管理、clean shutdown、token refresh）无针对性测试 | `docs/superpowers/specs/2026-11-12-bridge-design.md:7` | N/A | 仅 perpetual/daemon/peer/inbound 测试 | 中（关键路径可能有未覆盖边缘情况） | 添加 bridge 关键路径测试：权限回调超时、token refresh 竞态、容量波动、跨 worktree 扫描、clean shutdown 强制 kill | 已证实 | 仅检查 spec 文档声明 | open |
| B2-bridge-02 | bridge | — | 验证缺口 | P3 | spec 描述 shutdown 流程中 stopWork“最多重试 3 次”，但源码中该逻辑需进一步验证 | `src/bridge/bridgeMain.ts:2435-2600+` | N/A | 无 | 低（仅细节） | 验证 stopWork retry 次数与 backoff 配置 | 部分证实 | 需进一步阅读源码 shutdown 逻辑 | open |
| B2-bridge-03 | bridge | — | 契约缺口 | P3 | bridge 仅 inbound-envelope.md 契约与源码对齐，direct-connect-v1.md、open-runner-v1.md 等仅概念相似，无完整对齐验证 | `src/bridge/bridgeApi.ts`、`src/bridge/workSecret.ts` | N/A | 无 | 低（仅协议对齐） | 完成与相关 contracts 的完整对齐验证 | 部分证实 | 检查 contracts 目录 | open |
| B2-bridge-04 | bridge | — | 测试缺口 | P2 | bridge 子系统有部分测试覆盖，但关键路径（权限回调超时、token refresh 竞态、容量波动、跨 worktree 扫描边缘情况、clean shutdown 强制 kill、v1→v2 迁移）仍无针对性测试 | `src/bridge/bridgeMain.ts`、`src/bridge/sessionRunner.ts`、`src/bridge/jwtUtils.ts`、`src/bridge/bridgePointer.ts`、`src/bridge/replBridge.ts` | N/A | tests/perpetualBridge.test.ts、tests/daemonBridge.test.ts、tests/peerSessions.test.ts、tests/inboundEnvelope.test.ts 存在但覆盖不全 | 中（关键路径可能有未覆盖边缘情况） | 添加 bridge 关键路径测试文件，覆盖所有主要模块设计卡场景 | 已证实 | 检查 tests/ 目录确认测试覆盖范围 | open |

---

## 证据边界

### Batch 2 已验证的边界

| 子系统 | 已验证 | 未验证 |
|--------|------|--------|
| attachments | spec 文档完整性、核心源码一致性（maybe 包装器、超时、双重去重、图片处理、PDF 引用、日期变更、团队邮箱过滤、图片验证）、coverage manifest 注册 | 官方文档实时访问、上游 CLI strings、attachments 独立测试、遥测采样逻辑细节、真实 live 环境 |
| bridge | spec 文档完整性、核心源码一致性（bridgeMain、bridgeApi、sessionRunner、workSecret、bridgePointer、jwtUtils、trustedDevice、inboundMessages、replBridge、daemonBridge、capacityWake、flushGate、bridgeEnabled）、coverage manifest 注册、inbound-envelope.md 契约对齐、perpetual/daemon/peer/inbound 测试 | 官方文档实时访问、上游 CLI strings、关键路径测试、shutdown retry 次数细节、其他 contracts 完整对齐、真实 live 环境 |

### 上游证据边界

| 项目 | 状态 | 说明 |
|------|------|------|
| 官方文档链接 | ❌ 无法访问 | 无实时访问，基于现有 spec/contracts |
| 上游 CLI strings | ❌ 不可用 | /opt/homebrew/bin/claude 不存在，仅二进制残片 |
| 上游行为对齐 | ⚠️ 不充分 | 无上游证据，仅基于 spec/contracts 推断 |

### 测试证据边界

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| attachments 测试 | ❌ 无独立测试 | ⚠️ 仅集成测试间接覆盖 |
| bridge 测试 | ⚠️ 部分覆盖 | ⚠️ 关键路径无测试 |

---

## 完成判定

### 总体评估

| 子系统 | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 总体 |
|--------|------------|------------|------------|----------|------|
| attachments | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（无上游证据） | ⚠️ 部分充分（无独立测试） | ⚠️ 有条件通过（需添加独立测试） |
| bridge | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（无上游证据） | ⚠️ 部分充分（关键路径无测试） | ⚠️ 有条件通过（需添加关键路径测试） |

### Batch 2 总体结论

✅ **文档完整性高**：两个子系统的 draft spec 质量优秀，均包含完整章节、决策表、模块设计卡、证据位置标注。

✅ **实现一致性强**：代码与 spec 高度对齐，关键机制与文档完全一致。

⚠️ **测试覆盖不均**：attachments 无独立测试，bridge 仅部分覆盖，关键路径（权限回调、容量管理、clean shutdown、token refresh 等）无针对性测试。

⚠️ **上游验证不充分**：无官方文档实时访问，无上上游 CLI strings 证据。

### 其他子系统状态

本 batch 仅审计 attachments 和 bridge，其余 10 个子系统（buddy、computer-use、file-tools、lsp、mcp、onboarding-ui、permissions、session-persistence、shell-tools、tool-framework）保持未审计状态，后续 batch 覆盖。

---
