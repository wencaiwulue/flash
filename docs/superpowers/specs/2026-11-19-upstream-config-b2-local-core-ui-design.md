---
id: upstream-config-b2-local-core-ui
batch: 2
title: B2：本地核心与界面对齐设计
date: 2026-11-19
status: draft
---

# B2：本地核心与界面对齐设计

本文实现全量配置对齐路线的 B2：模型、thinking、压缩、输出、状态栏、终端、global-config 读取路径的来源、默认值、运行时读取和交互行为对齐。基线为上游 Claude Code **2.1.311**（npm stable）。工作统一在 PR wencaiwulue/flash#17（保持 Draft），批次间不独立合并。

## 1. 问题与约束

矩阵 `fixtures/upstream-config/2.1.311/compatibility.yaml` 中 `ownerBatch: 2` 共 42 条（22 missing / 13 partial / 1 excluded）。除 `teammateDefaultModel`（lifecycle=removed → excluded）外全部 active。上游证据在 `inventory.json`（每条含 `types`/`default`/`defaultDocumented`/`scopes`/`sourceRules`/`precedence`/`lifecycle`/`source`/`excerpt`，源自 settings-reference.md sha256=7817edfb）。

核心缺口不是"未实现"，而是**来源/默认值/运行时读取未对齐或未记录证据**。典型问题：`verbose`、`showTurnDuration` 上游 scope 为 `Any file`（settings 文件为主，`~/.claude.json` 旧值 fallback），但 flash 只从 `~/.claude.json`（GlobalConfig）读取，settings 文件的值不被消费者使用——用户在 settings.json 配置后不生效。

约束：每条 setting 须对齐 path/type/default/source/precedence/runtime 六维度；不得"只从错误来源读取"或"仅 UI 或仅 schema 对齐"（主设计 §4.5 完成阻挡条件）。

## 2. 设计理由与备选方案

采用**六维度工作法**：逐条核对六维度，证据写入本 spec 决策表 + 矩阵 `dimensions.<dim>.evidence`，补缺后更新维度状态。按可独立评审的子系统切入，避免一次性铺开 42 条。

对 showTurnDuration 的有效值读取，评估了两个方案：
- **A. 消费者内联** `getInitialSettings().x ?? getGlobalConfig().x ?? default`：零新 import 方向，但逻辑分散、不易单测。
- **B. config.ts 提供 `getShowTurnDuration()` helper**（采用）：config.ts 已 import `settings/managedPath.js`（config→settings 方向已存在，无循环），helper 集中优先级逻辑、可用注入点单测。verbose 等同模式条目可复用。

## 3. 目标与非目标

目标：切入子系统的六维度证据齐全，来源/默认值/运行时读取与上游一致，行为测试通过，矩阵维度状态与证据更新。

非目标（本轮）：不重构 config/settings 架构；verbose 的 `--verbose`/`viewMode`/`/focus` precedence 及分散消费者留待 global-config 子系统第二步；其余子系统（模型/状态栏/终端等）后续单独切入。

## 4. 架构、模块与数据流

showTurnDuration 数据流：

```
settings 文件（user/project/local/managed/flag）
  → loadSettingsFromDisk() 合并（低→高优先级）
  → getInitialSettings().showTurnDuration   [主来源]
~/.claude.json → getGlobalConfig().showTurnDuration   [旧值 fallback]
  → getShowTurnDuration() = settings ?? legacy ?? true
  → SystemTextMessage 消费者（"Cooked for" 时长渲染）
```

关键架构事实：`settings/types.ts` 最外层 schema 为 `.passthrough()`（types.ts:1113），未知 key 被保留，故 `getInitialSettings().showTurnDuration` 本即可读到 settings 文件值；真缺口曾是消费者只读 GlobalConfig。`getInitialSettings()`（settings.ts:834）返回按低→高优先级合并所有启用源的有效 settings，正是上游"settings 文件为主"的载体。

子系统分组（每子系统单独决策、单独提交）：

| 子系统 | 条目 |
|---|---|
| global-config 读取路径 | verbose、showTurnDuration（本轮切入） |
| 输出/显示开关 | outputStyle、showThinkingSummaries、showClearContextOnPlanAccept |
| 模型 | model、modelOverrides、modelPicker.*、modelPricing.*、modelSettings |
| thinking/压缩 | autoCompactEnabled、autoCompactWindow、fileCheckpointingEnabled |
| 状态栏 | statusLine.* |
| 终端/界面 | terminalTitleFromRename、terminalProgressBarEnabled、autoScrollEnabled、preferredNotifChannel、editorMode、theme、autoUpdatesChannel |
| autoMode | autoMode.* |
| autoMemory | autoMemoryDirectory、autoMemoryEnabled |
| IDE | autoConnectIde、autoInstallIdeExtension |
| teammate | teammateMode、teammateDefaultModel(excluded) |

### 决策表（global-config 读取路径）

| key | 上游 types/default/scopes | 上游 precedence | flash 现状缺口 | 决策 |
|---|---|---|---|---|
| showTurnDuration | Boolean / `true` / Any file | 无额外 | 仅 `getGlobalConfig()`，不读 settings 文件 | D1：`getShowTurnDuration()=settings??legacy??true`；D2：types.ts 加显式 zod |
| verbose | Boolean / `false` / Any file | `--verbose` 单会话覆盖；`viewMode`/sticky `/focus` 每会话覆盖 | 仅 GlobalConfig + CLI flag | D3：留待第二步，需核对 CLI/viewMode precedence |

- D1：showTurnDuration 有效值 = `getInitialSettings().showTurnDuration ?? getGlobalConfig().showTurnDuration ?? true`。
- D2：types.ts 增加 `showTurnDuration` 显式 zod（`z.boolean().optional()`，describe default true），对齐 path/type/default 并提供 `SettingsJson` 类型。
- D3：verbose 另含 CLI/viewMode precedence，留待后续。
- D4：default 维度无需改动（flash 已与上游一致）；本轮只补 source/runtime 读取路径 + schema 显式化。

## 5. 失败语义与工程取舍

showTurnDuration 无 fail-closed 语义：读取失败/未设置时回退默认 true（显示时长），不阻断任何操作。取舍：优先复用 `getInitialSettings()` 的合并结果而非新建 per-source 优先级链，避免重复实现上游已有的合并语义；`getShowTurnDuration()` 集中在 config.ts，与 global-config 读取路径同层。

## 6. 现状验收标准

- showTurnDuration：settings 文件值覆盖 `.claude.json`；`.claude.json` 旧值在无 settings 值时生效；均无时默认 true。
- `tests/b2GlobalConfigPath.test.ts` 4 用例通过。
- 矩阵 `setting:showTurnDuration` 六维度 aligned，`--batch 2` 0 诊断。
- 全 B2 完成需所有 42 条对齐或明确 excluded。

## 7. 代码与测试证据

- `src/utils/settings/types.ts`：`showTurnDuration`、`verbose` 显式 zod（path/type/default）。
- `src/utils/config.ts`：`getShowTurnDuration()`、`getVerbose(cliVerbose)` + `getInitialSettings` import（source/precedence）。
- `src/components/messages/SystemTextMessage.tsx`：消费者改用 `getShowTurnDuration()`（runtime）。
- `src/main.tsx:1901`：`verbose = getVerbose(options.verbose)`（runtime，CLI>settings>legacy）。viewMode/sticky `/focus` 覆盖不适用——flash viewMode 仅 UI 视图（DiffDialog/LogSelector）、无 `/focus` 命令。
- `tests/b2GlobalConfigPath.test.ts`：10 用例（showTurnDuration 4 + verbose 6，含 CLI 覆盖），经 `setSessionSettingsCache` + `saveGlobalConfig` 注入，全 pass。
- 上游证据：`fixtures/upstream-config/2.1.311/inventory.json` 的 `setting:showTurnDuration`、`setting:verbose`。
- 输出/显示开关（已实现对齐，验证+记录证据）：`src/constants/outputStyles.ts`（getOutputStyleConfig 读 getSettings_DEPRECATED()=getInitialSettings()）、`src/utils/messages/systemInit.ts:55`（?? DEFAULT_OUTPUT_STYLE_NAME='default'）、`src/utils/betas.ts:274`（showThinkingSummaries !== true → REDACT_THINKING_BETA_HEADER）、`src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:220` + `src/state/AppStateStore.ts:469`（settings=getInitialSettings()）。
- `tests/b2DisplaySettings.test.ts`：3 用例（outputStyle/showThinkingSummaries/showClearContextOnPlanAccept 的 source+default），全 pass。
- 状态栏：`src/utils/settings/types.ts` statusLine 加 refreshInterval(min 1)/hideVimModeIndicator；`src/components/StatusLine.tsx` 加 refreshInterval setInterval 定期 doUpdate；`src/components/PromptInput/PromptInputFooterLeftSide.tsx` showVim 加 `&& !hideVimIndicator`；`src/utils/hooks.ts` executeStatusLineCommand managed-only 已有。`tests/b2StatusLine.test.ts` 3 用例（完整解析/可选字段缺省/refreshInterval min 1）。

## 8. 文件覆盖与相关子系统

coverage：[upstream-config-b2-local-core-ui.yaml](../../architecture/coverage/upstream-config-b2-local-core-ui.yaml)。运行时代码主归属由 settings、config 等既有 coverage 维护，本 spec 不重复拥有文件。相关子系统：settings（合并/来源）、config（global-config）、hooks（B1 已对齐的 pricing 字段未来可由 modelPricing 子系统反哺）。

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | statusLine schema 缺 refreshInterval/hideVimModeIndicator（types.ts:591 仅 type/command/padding），上游含此二字段及 managed-only 安全限制 | 补两字段 schema + 运行时行为（刷新间隔/vim 指示器开关），核对 managed-only 限制 | 中 | statusLine 各字段行为测试通过 | M | 实测 |
| P2 | 输出/显示开关 outputStyle/showThinkingSummaries/showClearContextOnPlanAccept default 已文档化、flash 类型一致 | 验证 default/source/runtime 并记录证据，无需改实现 | 低 | 六维度证据齐全 + 矩阵更新 | S | 实测 |
| P2 | B1 Pre/PostModelSwitch 的 `estimated_cache_write_usd`/`pricing` 字段默认（需定价表） | modelPricing 子系统建定价表后反哺 B1 cache 字段 | 中 | pricing 字段真实值行为测试 | L | 设计推断 |

## 10. 实现状态（2026-11-19）

- global-config 读取路径：showTurnDuration、verbose 六维度 aligned（`getShowTurnDuration()`/`getVerbose()` + tests/b2GlobalConfigPath 10 用例）。verbose 的 viewMode/`/focus` 覆盖不适用（flash 无此特性）。
- 输出/显示开关：outputStyle、showThinkingSummaries、showClearContextOnPlanAccept 六维度 aligned（已实现对齐，验证+记录证据，tests/b2DisplaySettings 3 用例）。
- 状态栏：statusLine、statusLine.type/command/padding/refreshInterval/hideVimModeIndicator 六维度 aligned。type/command/padding 及 managed-only 安全限制（executeStatusLineCommand shouldAllowManagedHooksOnly/shouldDisableAllHooksIncludingManaged/trust）本已实现；本轮补 refreshInterval（types.ts min(1) + StatusLine setInterval 定期 doUpdate）与 hideVimModeIndicator（types.ts + PromptInputFooterLeftSide showVim && !hideVimIndicator）。tests/b2StatusLine 3 用例。
- autoMemory/终端：autoMemoryDirectory、autoMemoryEnabled、terminalTitleFromRename、autoUpdatesChannel 六维度 aligned（已实现对齐，含 autoMemoryEnabled 的 env/`--bare` precedence 与 autoMemoryDirectory 多源读取，验证+记录，tests/b2TerminalMemory 4 用例）。
- 矩阵 setting aligned=15，`--batch 2` 0 诊断，design-docs 0 errors。
- 其余 27 条：未切入，按 §4 子系统分组待后续。
