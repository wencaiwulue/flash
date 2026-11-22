---
id: upstream-config-b3-security-filesystem
batch: 3
title: B3：安全与文件系统对齐设计
date: 2026-11-20
status: draft
---

# B3：安全与文件系统对齐设计

本文实现全量配置对齐路线的 B3：权限（permissions.\*）、沙箱（sandbox.\*）、提交归属（attribution.\*）、托管 hooks 限制（allowManagedHooksOnly）及相关环境变量的来源、默认值、运行时读取与安全语义对齐。基线为上游 Claude Code **2.1.311**（npm stable）。工作统一在 PR wencaiwulue/flash#17（保持 Draft），批次间不独立合并。

## 1. 问题与约束

矩阵 `fixtures/upstream-config/2.1.311/compatibility.yaml` 中 `ownerBatch: 3` 共 70 条（68 setting + 2 env；40 partial / 28 missing / 2 blocked）。上游证据在 `inventory.json`（每条含 `types`/`default`/`scopes`/`sourceRules`/`precedence`/`lifecycle`/`excerpt`）。

与 B2（本地核心/UI 读取路径）不同，B3 条目多为**安全敏感**配置：权限规则决定工具调用是否放行，沙箱配置决定文件系统/网络隔离边界。对齐时除六维度（path/type/default/source/precedence/runtime）外，还须核对其 **fail-closed 语义**（读取失败/未设置时是放行还是拒绝），不得把"拒绝"误对齐为"放行"。

约束：每条须对齐六维度并记录证据；安全相关条目须额外记录失败语义；不得"仅 UI 或仅 schema 对齐"（主设计 §4.5 完成阻挡条件）。

## 2. 设计理由与备选方案

沿用 B2 的**六维度工作法**：逐条核对六维度，证据写入本 spec 决策表 + 矩阵 `dimensions.<dim>.evidence`，补缺后更新维度状态。按可独立评审的子系统切入，避免一次性铺开 70 条。

对安全敏感条目，额外评估两种对齐口径：
- **A. 仅对齐读取路径**（settings 来源/默认值）：与 B2 同模式，但对权限/沙箱而言，读取路径正确不等于安全语义正确。
- **B. 读取路径 + 失败语义双重对齐**（采用）：除来源/默认值/运行时外，显式记录每条在缺失/解析失败时的放行或拒绝行为，确保与上游 fail-closed 方向一致。

## 3. 目标与非目标

目标：切入子系统的六维度证据齐全，来源/默认值/运行时读取与上游一致，安全条目失败语义一致，行为测试通过，矩阵维度状态与证据更新。

非目标（本轮）：不重构 permissions/sandbox 子系统架构；不实现上游有而 flash 无的沙箱后端（如 bwrap/Seatbelt 的新隔离机制）；blocked 条目（permissions.blockWritesOutsideWorkingDirectories、permissions.denyInsteadOfPrompting）先核对 blocked 原因再决定是否切入。

## 4. 架构、模块与数据流

子系统分组（每子系统单独决策、单独提交）：

| 子系统 | 条目数 | 说明 |
|---|---|---|
| attribution | 4 | 提交/PR/sessionUrl 归属文案，最小子系统，首个切入 |
| permissions | ~14 | 权限规则 allow/ask/deny/defaultMode/additionalDirectories 等 |
| sandbox | ~50 | 沙箱 enabled/filesystem/network/credentials 等，最大最复杂 |
| allowManagedHooksOnly | 1 | 托管 hooks 限制（与 B1 hooks 安全相关） |
| env | 2 | 安全/文件系统相关环境变量 |

切入顺序：attribution → permissions → allowManagedHooksOnly → sandbox（按子系统规模与安全敏感度递增）。

## 5. 失败语义与工程取舍

权限/沙箱配置的 fail-closed 方向是本轮核心核对点：例如 `permissions.deny` 解析失败应拒绝而非放行，`sandbox.enabled` 未设置时的默认隔离级别须与上游一致。取舍：优先复用 flash 既有的 settings 合并结果（getInitialSettings）而非新建 per-source 链；安全条目在 matrix notes 显式记录失败语义，便于审查。

## 6. 现状验收标准

- 切入子系统每条六维度证据齐全，安全条目附失败语义记录。
- 行为测试通过（schema 解析 + 运行时读取 + 失败语义）。
- 矩阵维度状态更新，`--batch 3` 0 诊断，design-docs 0 errors。
- 全 B3 完成需所有 70 条对齐或明确 excluded/blocked。

## 7. 代码与测试证据

- attribution（首个切入，建立 B3 工作法样板）：`src/utils/settings/types.ts` attribution 改 `z.union([object{commit,pr,sessionUrl}, z.literal(false)])`（补 sessionUrl 字段 + false 选项）；`src/utils/attribution.ts` getAttributionTexts/getEnhancedPRAttribution 开头加 `settings.attribution===false → 返回空`（隐藏所有归属），remote 分支加 `settings.attribution?.sessionUrl ?? true` 控制 session 链接省略。commit/pr 本即读 settings.attribution.commit/pr（默认 + 空字符串隐藏），验证+记录。`tests/b3AttributionSettings.test.ts` 8 用例（schema object/false/sessionUrl + getAttributionTexts 自定义/空字符串/false/includeCoAuthoredBy/默认）。
- 测试基建：attribution.ts import 工具 prompt 常量触发 REPLTool/constants ↔ FileReadTool/prompt 循环依赖（flash 固有）。测试用 `mock.module(FileReadTool/prompt)` + 动态 import 打破循环，归属逻辑可单测。
- permissions（第二个切入，已实现条目验证+记录）：defaultMode/disableBypassPermissionsMode/additionalDirectories 六维度 aligned。运行时本即读 `getSettings_DEPRECATED().permissions`（permissionSetup.ts `initialPermissionModeFromCLI`），本轮验证 + 补 fail-closed 行为测试。fail-closed：①defaultMode 在 remote(CLAUDE_CODE_REMOTE) 仅 acceptEdits/plan/default，bypassPermissions defaultMode 被忽略并告警（防 remote 授予完全访问）；②disableBypassPermissionsMode 阻止进入 bypassPermissions（Statsig gate 优先于 settings），跳过并通知。additionalDirectories 为授权扩展（非 fail-closed 限制），permissionSetup/sandbox-adapter/PermissionUpdate 读取并合入允许目录。`tests/b3PermissionsSettings.test.ts` 8 用例（schema 5 + fail-closed 行为 3：defaultMode 生效/disable 阻止 bypass+notification/remote 忽略 bypass）。
- 测试基建（permissions）：bun:test 的 `vi` 无 stubEnv/unstubAllEnvs，环境变量用 `process.env` 直接设置 + afterEach `delete`；settings 注入用 `setSessionSettingsCache`（`src/utils/settings/settingsCache.ts`，非 sessionSettingsCache）；`initialPermissionModeFromCLI({permissionModeCli,dangerouslySkipPermissions})` 可直接注入 settings/remote 测 fail-closed，Statsig gate 测试环境默认 false。

## 8. 文件覆盖与相关子系统

coverage：[upstream-config-b3-security-filesystem.yaml](../../architecture/coverage/upstream-config-b3-security-filesystem.yaml)。运行时代码主归属由 settings、config、permissions、sandbox 等既有 coverage 维护，本 spec 不重复拥有文件。相关子系统：settings（合并/来源）、permissions（权限求值）、sandbox（隔离）、hooks（B1 已对齐的 managed-only 安全限制）。

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 权限/沙箱条目 fail-closed 方向未逐条核对（matrix ownerBatch:3 共 70 条，partial 40 / missing 28 / blocked 2） | 逐条记录缺失/解析失败时的放行或拒绝行为，与上游对齐 | 高 | 安全条目失败语义行为测试 | L | 待运行验证 |
| P2 | attribution 子系统最小（4 条），适合首个切入建立 B3 工作法样板 | 先切 attribution 验证六维度 + 失败语义工作法 | 低 | attribution 六维度证据齐全 + 矩阵更新 | S | 设计推断 |
| P2 | blocked 条目（blockWritesOutsideWorkingDirectories、denyInsteadOfPrompting）原因未核对 | 先读 inventory blocked 原因与 Requires 语句，决定是否可切入 | 中 | blocked 原因证据记录 | S | 设计推断 |

## 10. 实现状态（2026-11-20）

- B3 启动：范围确认为 70 条（attribution 4 / permissions ~14 / sandbox ~50 / allowManagedHooksOnly 1 / env 2），切入顺序 attribution → permissions → allowManagedHooksOnly → sandbox。
- attribution：attribution、attribution.commit、attribution.pr、attribution.sessionUrl 六维度 aligned（commit/pr 已对齐验证+记录；补 attribution:false 隐藏所有归属 + sessionUrl 字段与 remote 控制，tests/b3AttributionSettings 8 用例）。fail-closed：attribution:false 隐藏所有归属、sessionUrl:false 省略 session 链接，均非安全敏感（仅归属文案/链接显隐）。
- permissions（进行中）：defaultMode、disableBypassPermissionsMode、additionalDirectories 六维度 aligned（运行时本即读 getSettings_DEPRECATED，验证 + fail-closed 行为测试，tests/b3PermissionsSettings 8 用例）。fail-closed：defaultMode remote 忽略 bypassPermissions、disableBypass 阻止 bypass（Statsig 优先）。
- 矩阵 setting aligned=33（B2 26 + B3 attribution 4 + permissions 3），`--batch 3` 0 诊断。
- 待深入：permissions.allow/ask/deny（deny 优先、ask 强制 prompt 的求值优先级 fail-closed）、disableAutoMode（受 TRANSCRIPT_CLASSIFIER feature 门控，需确认 schemaPaths 是否含）、blockReadsOutsideWorkingDirectories（功能缺口，无 zod/运行时）；父对象 permissions 待子项全 aligned；blocked 2 条（blockWrites v2.1.314、denyInsteadOfPrompting v2.1.319 均 afterBaseline）保持 blocked。
- 下一子系统：permissions 剩余 → allowManagedHooksOnly → sandbox。
