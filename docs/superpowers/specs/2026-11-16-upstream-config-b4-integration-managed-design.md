---
id: upstream-config-b4-integration-managed
batch: 4
title: B4：集成与托管对齐设计
date: 2026-11-16
status: draft
---

# B4：集成与托管对齐设计

本文实现全量配置对齐路线的 B4：集成与托管面（MCP / auth / remote managed settings / Remote Control / cross-session / plugin / skill）的来源、默认值、运行时读取与托管强制语义对齐。基线为上游 Claude Code **2.1.311**（npm stable）。工作统一在 PR wencaiwulue/flash#17（保持 Draft），批次间不独立合并。

## 1. 问题与约束

矩阵 `fixtures/upstream-config/2.1.311/compatibility.yaml` 中 `ownerBatch: 4` 共 **77 条 = 18 setting + 59 env**，初始 72 missing + 5 partial，无 aligned。上游证据在 `inventory.json`（每条含 `types`/`default`/`scopes`/`sourceRules`/`precedence`/`lifecycle`/`excerpt`）。

与 B2/B3（本地/安全读取路径）不同，B4 条目多为**集成与托管**配置：大量条目依赖尚未实现的子系统（MCP server 连接、gateway 认证、Remote Control 会话、插件市场、跨会话入站）。仅 5 条 partial 已有 zod schema + 运行时消费者，可对齐；其余 72 条 missing 是功能缺口。

约束：每条须对齐六维度并记录证据；托管强制（managed-enforced / managed-only）条目须额外记录 fail-closed 语义；按 2026-11-23 用户指令"先完成 B1 到 B5，太难的先记下来跳过"，未实现子系统的 missing 条目记录功能缺口，不实现。

## 2. 设计理由与备选方案

沿用六维度工作法：逐条核对 path/type/default/source/precedence/runtime，证据写入本 spec 决策表 + 矩阵 `dimensions.<dim>.evidence`。

对 B4 的 77 条，评估两种推进口径：
- **A. 全量实现 72 条 missing**：需先实现 MCP/auth-gateway/Remote Control/plugin/skill 等多个子系统，工作量远超"对齐已有读取路径"，且违反"太难先跳过"指令。
- **B. 对齐可对齐的 partial + 记录 missing 功能缺口**（采用）：把已有 zod schema + 运行时消费者的 4 条 partial 标为 aligned；forceLoginMethod 缺 `gateway` 保持 partial；72 条 missing 按子系统分类记录功能缺口，难项跳过。

## 3. 目标与非目标

**目标**：
- 4 条 partial（forceLoginOrgUUID / pluginTrustMessage / pluginConfigs / remote.defaultEnvironmentId）对齐六维度并标 aligned。
- forceLoginMethod 记录 `gateway` gap，保持 partial。
- 72 条 missing 按子系统分类记录功能缺口，写入 §9 难项跳过。

**非目标**：
- 不实现 MCP / auth-gateway / Remote Control / plugin / skill 子系统。
- 不追求 B4 全量 aligned（77 条中 72 条依赖未实现子系统）。

## 4. 架构、模块与数据流

本轮对齐的 4 条均为"settings 文件 → settingsCache → 运行时消费者"读取路径：

- **forceLoginOrgUUID** → `src/utils/auth.ts` `validateForceLoginOrg`（managed-enforced，profile 失败 fail closed），`src/main.tsx:3440` 调用。
- **pluginTrustMessage** → `src/utils/plugins/marketplaceHelpers.ts:184`（managed-only）。
- **pluginConfigs** → `src/utils/plugins/mcpbHandler.ts` 读写 `pluginConfigs[pluginId].{mcpServers,options}`。
- **remote.defaultEnvironmentId** → `src/utils/teleport.tsx:1329` 读取并匹配 `environment_id`。

### 决策表（4 条 aligned）

| key | path/type | default | source/precedence | runtime | 证据 |
| --- | --- | --- | --- | --- | --- |
| forceLoginOrgUUID | `types.ts:692` `z.string().optional()` | unset | Any file，**仅 managed 强制**；仅读 policySettings | `validateForceLoginOrg` 读 policySettings，profile 失败 fail closed（valid:false） | `auth.ts`、`main.tsx:3440` |
| pluginTrustMessage | `types.ts:1189` `z.string()` | unset | **Managed**；仅读 policySettings | `marketplaceHelpers.ts:184` `getSettingsForSource('policySettings')?.pluginTrustMessage` | `marketplaceHelpers.ts` |
| pluginConfigs | `types.ts:881` `z.record(pluginId -> {mcpServers?, options?})` | unset | User or managed | `mcpbHandler.ts:149,292` 读写 `pluginConfigs[pluginId].mcpServers[serverName]/options` | `mcpbHandler.ts` |
| remote.defaultEnvironmentId | `types.ts:924` `z.string()` | unset | Any file；`ccpool_` 只从 user/managed/--settings | `teleport.tsx:1329` 读并匹配 `environment_id`（1354-1367） | `teleport.tsx` |

上游证据均为 `inventory.json` 对应条目（excerpt + sourceRules）。

## 5. 失败语义与工程取舍

- **managed-enforced（forceLoginOrgUUID）**：仅 managed settings 强制 org UUID；profile 获取失败 **fail closed**（valid:false，拒绝登录），不得对齐为"失败放行"。
- **managed-only（pluginTrustMessage）**：仅 managed settings 生效，非 managed 源设置无效（防提权）。
- **forceLoginMethod gap**：上游 `forceLoginMethod` 为 string one of claude.ai/Console/**gateway**，`"gateway"` 与 `forceLoginGatewayUrl` 同源生效；flash zod 为 `z.enum(['claudeai','console'])`（`types.ts:685`），登录流程 `cli/handlers/auth.ts:131-134` 仅二选一。补 `gateway` 需 gateway 认证子系统，保持 partial。
- **72 条 missing**：记录功能缺口而非对齐，避免"仅 schema 对齐"被误判为完成（主设计 §4.5 完成阻挡条件）。

## 6. 现状验收标准

- 4 条 partial 标 aligned，六维 evidence 完整，implementation/tests/spec 引用齐全。
- forceLoginMethod 保持 partial，notes 记录 `gateway` gap，tests 覆盖 gap 坐实。
- `--batch 4` 0 诊断；`check-design-docs.ts` 无 error；`typecheck` 通过。
- setting aligned：62 → 66（+4）。

## 7. 代码与测试证据

- `src/utils/settings/types.ts`（4 条 zod schema）
- `src/utils/auth.ts`（validateForceLoginOrg，managed-enforced fail closed）
- `src/utils/plugins/marketplaceHelpers.ts`（pluginTrustMessage，managed-only）
- `src/utils/plugins/mcpbHandler.ts`（pluginConfigs 读写）
- `src/utils/teleport.tsx`（defaultEnvironmentId 读取）
- `tests/b4IntegrationSettings.test.ts`：5 用例全过
  - forceLoginOrgUUID / pluginTrustMessage 接受 string、拒绝 number
  - pluginConfigs 接受 `pluginId -> {mcpServers, options}`
  - remote.defaultEnvironmentId 接受 string
  - forceLoginMethod 接受 claudeai/console、**拒绝 gateway**（gap 坐实）

## 8. 文件覆盖与相关子系统

coverage：[upstream-config-b4-integration-managed.yaml](../../architecture/coverage/upstream-config-b4-integration-managed.yaml)。运行时代码主归属由 settings、auth、plugins、teleport 等既有 coverage 维护，本 spec 不重复拥有文件。相关子系统：settings（合并/来源）、auth（登录/org 强制）、plugins（MCP 配置/信任提示）、teleport（默认环境）。

## 9. 改进建议

按"太难先记下来跳过"，以下难项本轮跳过，仅记录功能缺口（72 条 missing）。后续若实现对应子系统，应各立独立 spec 并回填本矩阵 missing 条目。

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | MCP 子系统未实现（allowAllClaudeAiMcps、disableClaudeAiConnectors、allowClaudeInChromeWithManagedMcp 等 4 条 setting + 约 20 条 env：`MCP_TIMEOUT`、`MCP_DISCOVERY_CACHE*`、`MCP_OAUTH_CALLBACK_PORT`、`ENABLE_CLAUDEAI_MCP_SERVERS`） | 立 MCP 子系统 spec，实现 server 连接/discovery cache/OAuth callback/协议协商后回填 | 高 | MCP 连接与缓存行为测试 | L | 设计推断 |
| P2 | auth/gateway 未实现（forceLoginGatewayUrl、gatewayInternalNetworks + 约 16 条 env：`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_*`、`CLAUDE_CODE_SKIP_*_AUTH`、gateway model discovery） | 立 auth-gateway spec，实现 gateway 认证/多 provider 跳过认证/OAuth refresh 后回填；forceLoginMethod `gateway` 同属此 | 高 | gateway 登录与 OAuth 行为测试 | L | 设计推断 |
| P2 | Remote Control / cross-session 未实现（crossSessionInbound、isolatePeerMachines、remoteControlAtStartup + 约 6 条 env：`CLAUDE_CODE_REMOTE`、`CLAUDE_CODE_BRIDGE_SESSION_ID`） | 立 Remote Control spec，实现会话/跨会话入站/对端隔离后回填 | 高 | Remote Control 会话行为测试 | L | 设计推断 |
| P3 | plugin / skill 未实现（pluginSuggestionMarketplaces、skillOverrides、skillListingBudgetFraction、skillListingMaxDescChars + 约 15 条 env：`CLAUDE_CODE_PLUGIN_*`、`CLAUDE_CODE_SYNC_SKILLS*`、`FORCE_AUTOUPDATE_PLUGINS`） | 立 plugin/skill spec，实现市场建议/skill 覆盖/同步安装后回填 | 中 | 插件与 skill 行为测试 | L | 设计推断 |
| P3 | remote managed settings 强制刷新未实现（forceRemoteSettingsRefresh） | 实现远程 settings 强制刷新机制后回填 | 中 | 远程刷新行为测试 | M | 设计推断 |
| P3 | forceLoginMethod 缺 `gateway`（上游 honors `gateway` 与 forceLoginGatewayUrl 同源；flash zod enum 仅 [claudeai, console]；b4 测试坐实 gap） | 随 auth-gateway 子系统补 `gateway` 枚举与登录流程 | 中 | forceLoginMethod gateway safeParse + 登录流程测试 | M | 测试坐实 |

## 10. 实现状态（2026-11-16）

- 4 条 partial → aligned（forceLoginOrgUUID / pluginTrustMessage / pluginConfigs / remote.defaultEnvironmentId）。
- forceLoginMethod 保持 partial（缺 `gateway`，gap 记录）。
- 72 条 missing 分类记录功能缺口（§9），难项跳过。
- `tests/b4IntegrationSettings.test.ts` 5 用例全过；`--batch 4` 0 诊断；design-docs 无 error；typecheck 通过。
- setting aligned：62 → 66（+4）。
