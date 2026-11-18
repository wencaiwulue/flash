---
id: upstream-configuration-alignment
batch: 3
title: flash 与上游全量配置对齐路线设计
date: 2026-11-16
status: approved
---

# flash 与上游全量配置对齐路线设计

本文定义 flash 与上游 Claude Code 全量配置对齐的总路线。这里的“上游”指官方 Claude Code 稳定版；保留协议常量、外部标识符和真实产品名称，不违反 flash 命名排除清单。

本文是路线与架构设计，不代表任何未完成配置已经支持。各功能批次必须另有具体 spec，给出字段语义、模块设计、失败行为、测试和三层证据后才能实施。

## 1. 问题与约束

### 1.1 已复现的问题

- flash 0.0.2 在另一台机器拒绝 `PostToolBatch`、`UserPromptExpansion`，不是机器环境差异。
- `src/entrypoints/sdk/coreTypes.ts:25-53` 的 `HOOK_EVENTS` 缺少上述事件；`src/schemas/hooks.ts:211-213` 按该枚举校验，未知 hook 会使整个 `settings.json` 被跳过。
- 2026-11-16 获取的官方 hooks 文档有 33 个事件，flash 有 27 个，缺少 `UserPromptExpansion`、`PostToolBatch`、`MessageDisplay`、`DirectoryAdded`、`PreModelSwitch`、`PostModelSwitch`。
- 本机上游 2.1.212 二进制可确认前三个事件，后三个来自更新文档，尚未在该二进制中找到。
- 官方 settings 参考与 flash `SettingsSchema` 的初次机器对比显示：99 个仍有效的顶层键和 22 个嵌套键未声明。Bun 验证输出为 `compatibility diff verification: PASS`，表示对比脚本完成了预期断言，不表示 flash 已通过兼容验收。
- 缺失的顶层键按文档 scope 分布为：53 个 Any file、25 个 Managed、18 个 User or managed、3 个 User/local/managed。已排除废弃的 `keybindingFlavor` 和移除的 `taskOutputMaxChars`。
- 嵌套差异包括 3 个 permissions 限制项、`attribution.sessionUrl`、3 个 worktree 项和 15 个 sandbox 项。
- 顶层 schema 使用 `.passthrough()`（`src/utils/settings/types.ts:1112-1113`），因此许多未知键不会报错，但也不会自动获得上游运行时语义。
- `theme`、`editorMode`、`verbose`、`autoCompactEnabled`、`fileCheckpointingEnabled`、`showTurnDuration`、`terminalProgressBarEnabled`、`teammateMode`、`preferredNotifChannel` 等仍只从 `~/.claude.json` 读取，证据为 `src/tools/ConfigTool/supportedSettings.ts:29-83`。
- 路线立项时本机 `env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` 在 flash 源码中没有消费者，只会被注入环境，不会限制 subagent 数量；B0 的 2.1.311 文档证据随后确认该变量自 2.1.224 起已移除且为 no-op，因此后续目标改为验证移除语义并处理 active 并发/深度变量。

### 1.2 约束

1. 基线采用每个批次开始时的最新稳定版，并固定确切版本；不能长期使用不断移动的“latest”。
2. 每个行为决策按顺序收集官方文档、上游二进制、本仓库 external-stubs/既有 spec 三层证据。二进制观测优先于可能滞后的文档；私有协议没有证据时不得声称兼容。
3. 完成标准是行为语义对齐：配置路径、类型、默认值、合并优先级和运行时效果都必须有测试。只通过 schema 不算完成。
4. Desktop、Cloud、claude.ai 等外部能力先分类，再判断底层实现是否存在；不能把 Desktop UI 误当成终端 CLI 职责。
5. 安全策略不能因为容错解析而降级。Managed、permissions、sandbox 的失败行为必须遵守上游证据，证据不足时不得回退到更宽松配置。
6. 新功能未实现前不得仅通过声明配置键来伪装支持。
7. 路线文档和试点都不是模块完成证据；每个功能模块必须有具体设计和行为验收。
8. 测试证据不得记录本机或其他机器配置中的凭据、OAuth token 等敏感内容。
9. 按用户 2026-11-18 的交付决定，B0–B5 与最终完整性审查全部留在同一个 PR #17；批次仍分别设计、提交和评审，但不独立合并。

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 采用兼容矩阵驱动的分批路线 | 机器可读矩阵记录每个配置/hook/env 的上游语义、flash 状态和测试证据 | 能区分解析、接线和行为完成；批次独立评审，按用户决定统一在 PR #17 交付 | 不分提交区间的一次性同步：无法有效评审；schema 先行：容易形成长期静默空操作；拆多个 PR：不符合本次交付约束 | 需要先建设矩阵和检查器，且单一 PR 必须等全部批次完成 | 当前 `99 + 22 + 6` 差异跨越多个子系统；本文件第 1.2 节第 9 项、第 4 节 |
| 每批固定最新稳定版 | 批次头记录版本、采集日期、文档来源、二进制版本和仓库契约修订 | 可重复验证，避免文档、二进制、契约指向不同版本 | 永远跟踪 latest：结果不可复现；固定在 2.1.212：无法覆盖更新事件 | 批次开始需要重新收集证据 | 2.1.212 只确认 6 个缺失事件中的 3 个 |
| 保留前向兼容，但完整声明已知配置 | 已知项进入显式 schema 和消费者；未知项由差异检查诊断 | 同时支持新配置容错与当前配置真实语义 | 全靠 `.passthrough()`：配置静默无效；严格拒绝所有未知项：一个未来字段破坏整个文件 | 需要字段级诊断和差异检测 | `src/utils/settings/types.ts:1112-1113`；当前未知 hook 整文件失败 |
| 错误按项隔离，安全策略例外 | 未知项只跳过自身；普通已知字段尽量保留有效兄弟项；安全策略按上游 fail-closed | 避免局部错误扩大，同时不削弱策略 | 整文件失败：当前兼容问题；所有字段一律 fail-open：可能绕过 managed 限制 | 需要按来源和字段分类错误 | `src/schemas/hooks.ts:211-213`；现有 settings spec 第 4.3 节 |
| 统一配置来源解析 | managed、flag、local、shared、user 与远程 managed 进入同一优先级模型，并保留来源信息 | 防止运行时模块各自读取造成冲突 | 各消费者自行读取 settings/global config：当前部分字段语义分裂 | 需要调整读取路径及冲突测试 | `src/tools/ConfigTool/supportedSettings.ts:29-83`；现有 settings spec 第 4.1 节 |
| 外部能力按实现基础分层 | Desktop 忽略、已有实现接线、完整功能缺失三类分别处理 | 防止过度实现或虚假兼容 | 全部排除：漏掉已有 CLI 功能；全部实现：把 Desktop UI 错放进 CLI | 每类需要不同验收证据 | 本文件第 4.5 节代码盘点 |
| 独立功能缺失项建立子项目 | Artifact 发布、同步、mods 扩展等独立 spec 和实测 | 这些不是简单配置接线，必须独立设计、提交和评审；统一 PR 在全部子项目完成前保持 Draft | 不分提交区间的一次性实现：范围不可评审；只加警告：不满足全量目标；拆独立 PR：不符合本次交付约束 | 总路线和统一 PR 完成依赖多个子项目 | 当前未找到 Artifact 发布、插件/技能同步等实现；本文件第 1.2 节第 9 项 |
| 上游探测与常规 CI 分离 | 固定版本黑盒探测结果脱敏记录；CI 使用本地 fixtures | CI 不应依赖私有二进制、网络或真实账号 | CI 直接访问上游服务：不稳定且可能泄露凭据 | 需要维护可重复 fixtures 和证据快照 | flash-coding 三层证据工作流；外部环境可用性限制 |

## 3. 目标与非目标

### 3.1 目标

- 覆盖官方有效顶层配置、嵌套配置、环境变量和 hook，而非只修当前两个事件。
- 为每项记录配置路径、类型、默认值、scope、来源、合并规则、实现、测试和上游证据。
- 消除“未知 hook 导致同文件其他配置失效”和“配置被 passthrough 接受但没有效果”两类问题。
- 按上游语义处理 settings 与 `~/.claude.json` 的边界及冲突。
- 对 Desktop 专属配置实现上游规定的 CLI 忽略语义。
- 将已有 Remote Control、跨会话消息、claude.ai MCP、远程 managed settings 实现接到正确配置。
- 对完全缺失的外部功能安排独立子项目，并明确未完成状态。
- 建立可重复的漂移检测、行为测试和批次发布门槛。

### 3.2 非目标

- 不在本路线 spec 中直接给出 121 个配置项和 33 个 hook 的最终字段级实现；这些属于 B0 矩阵及各批次 spec。
- 不实现 Desktop 浏览器外部页面、移动模拟器、远程预览或 SSH Desktop UI。
- 不绕过 claude.ai 订阅、OAuth scope、Remote Control 服务端 gate 或企业策略。
- 不把 `ReviewArtifactTool` 的代码审查或 `src/ssh/artifact.ts` 的部署构件传输冒充为 claude.ai Artifact 发布。
- 不在证据不足时发明私有同步、bridge、native messaging 或扩展配对协议。
- 不自动改写、双写或迁移用户配置，除非上游证据和对应批次 spec 明确要求。
- 不把路线文档批准、schema 通过、环境变量注入或单元测试单独视为全量对齐完成。

## 4. 架构、模块与数据流

### 4.1 总体架构

```text
官方稳定版文档 ─┐
上游二进制观测 ─┼→ 批次证据包 → 兼容矩阵 → 差异/状态检查
仓库契约与 spec ─┘                    │
                                      ├→ schema 与来源解析
                                      ├→ 各运行时消费者
                                      └→ 行为测试与验收状态

用户/local/shared/flag/managed/remote 配置
                  ↓
        来源解析与字段级诊断
                  ↓
       上游优先级合并 + 来源元数据
                  ↓
     hooks / model / UI / security / integrations
                  ↓
          行为测试 → aligned 状态
```

### 4.2 基线与证据包

每个批次开始时固定基线，至少记录：

| 字段 | 含义 |
|---|---|
| `upstream_version` | 该批次的 exact 上游稳定版版本，不允许写 `latest` |
| `captured_at` | 证据采集日期 |
| `documents` | 官方文档页面及对应内容标识/本地快照位置 |
| `binary` | 上游二进制版本、获取方式和脱敏观测记录 |
| `contracts` | 本仓库 external-stubs 契约、相关 spec 和修订 |
| `scope` | 本批次覆盖的矩阵条目 |

当前 2.1.212 和 2026-11-16 文档只是路线立项证据，不自动成为所有批次的最终基线。`PreModelSwitch`、`PostModelSwitch`、`DirectoryAdded` 必须找到包含它们的稳定版并补足观测证据后，才能进入 `aligned`。

三层证据冲突时，先确认是否来自不同版本；同版本下按上游二进制实际行为修正文档假设。仓库契约明确声明偏离时再单独记录偏离，不能悄悄改变上游目标。

### 4.3 兼容矩阵

新增唯一机器可读矩阵，规划路径为 `docs/architecture/coverage/upstream-configuration-compatibility.yaml`。它不是设计文档 coverage manifest 的替代品，也不通过复制现有源码文件来取得 coverage 所有权。

概念结构如下，具体 schema 由 B0 spec 定义：

```yaml
schema_version: 1
entries:
  - id: settings.permissions.additionalDirectories
    kind: setting
    upstream:
      verified_version: <exact-version>
      scope: <official-scope>
      type: <schema-type>
      default: <upstream-default>
      sources: [<allowed-sources>]
      merge: <merge-rule>
      evidence: [<doc-binary-contract-references>]
    flash:
      capability: present | partial | missing | desktop-only
      status: aligned | partial | missing | ignored-by-design
      implementation: [<repository-paths>]
      tests: [<behavior-test-references>]
      spec: <owning-spec>
      notes: <optional-nonsecret-note>
```

矩阵规则：

1. 顶层键、嵌套键、环境变量、hook 都使用稳定唯一 ID；数组元素语义无独立配置路径时归父项。
2. `capability` 表示底层功能是否存在，`status` 表示配置语义是否完成，避免把“有功能未接线”和“功能整体缺失”混为一谈。
3. `aligned` 必须同时具备显式 schema/协议定义、正确来源和默认值、正确合并行为、真实消费者及行为测试。
4. `partial` 用于部分接线或外部实测阻塞；`missing` 用于未声明或无实现；`ignored-by-design` 只用于上游明确要求 CLI 忽略的项。
5. 任何 `aligned` 条目的 `verified_version`、实现、测试、spec 和证据都不得为空。
6. 文档、二进制或仓库实现变化后重新生成差异报告；不能靠手工维护一份永远显示完成的清单。
7. 校验器检查条目完整性、重复 ID、路径引用、状态约束和 schema/矩阵差异。官方清单采集与本地状态检查分离，常规 CI 不访问网络。

### 4.4 配置加载、校验与来源语义

#### 4.4.1 已知与未知配置

- 矩阵中所有有效配置都必须有显式类型和运行时消费者；顶层 `.passthrough()` 可保留用于前向兼容，但不再是支持证据。
- 未知键和未知 hook 事件只忽略未知项，诊断包含来源文件、字段路径和适用的上游版本，不使同文件有效兄弟项失效。
- 已知字段类型错误不得采用错误值。普通字段尽量保留有效兄弟项；具体部分应用算法必须与上游黑盒结果一致。
- JSON 语法错误不能部分应用该文件；原始文件不得被自动修复覆盖。

#### 4.4.2 安全策略

- Managed、permissions、sandbox 等安全相关来源和字段按上游 fail-closed 行为处理。
- 无效的高优先级安全策略不能直接掉落为较低优先级允许规则。
- 部分有效策略能否加载、哪些错误使整个安全对象失效，必须由批次 spec 对每类字段列出决策表和二进制证据。
- 诊断不得打印凭据、token 或完整敏感配置值。

#### 4.4.3 来源与 global config

- 按上游证据统一 managed、命令行、local、shared、user 的优先级；远程 managed settings 进入同一解析和诊断模型，不能另建冲突规则。
- 合并结果保留来源元数据，用于解释最终值来自何处；安全敏感值只记录来源，不记录内容。
- `theme`、`editorMode`、`autoCompactEnabled` 等字段从上游规定的 settings 来源读取。
- `~/.claude.json` 仅在上游仍用于该字段时保留兼容读取；冲突按上游优先级，不自行引入双写或隐式迁移。
- `env.*` 注入与功能语义分别验收。例如 active 的 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 与 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 必须由 subagent 管理逻辑读取并真实限制并发或嵌套深度；已移除的 `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` 按 2.1.311 证据验证 no-op，不重新发明上限。

### 4.5 实施批次

| 批次 | 范围 | 关键交付 | 完成阻挡条件 |
|---|---|---|---|
| B0：兼容基础设施 | 基线、完整矩阵、schema/来源诊断、差异检查 | 全量条目、错误隔离、统一解析、检查器和 fixtures | 任何有效配置/hook/env 未入矩阵；未知 hook 仍使兄弟配置失效 |
| B1：Hooks 与当前环境变量 | 全部 33 个 hook 的协议复核、6 个缺失 hook、B1 所属进程与 subagent 环境变量 | 事件注册、触发时机、payload/输出协议、matcher、错误语义；active subagent 并发/深度限制及 removed 变量 no-op 证据 | 只加枚举或只注入环境；缺少任一运行时协议测试；按过时路线重新实现已移除变量 |
| B2：本地核心与界面 | 模型、thinking、压缩、输出、状态栏、终端、global-config 读取路径 | 来源、默认值、运行时读取和交互行为 | 仍只从错误来源读取；仅 UI 或仅 schema 对齐 |
| B3：安全与文件系统 | permissions、attribution、worktree、sandbox | 合并、fail-closed、路径边界、绕过防护 | 安全字段无行为测试或错误时降级为宽松策略 |
| B4：集成与托管 | MCP、插件、认证、remote managed、Remote Control、跨会话消息 | 已有实现接线、配置消费者、降级行为 | 配置键无消费者；绕过订阅或 gate；私有协议无证据 |
| B5：独立功能子项目 | Artifact 发布、插件/技能同步、mods 扩展、反馈草稿、用量重置后自动继续等 | 每项独立 spec、实现、协议 fake 和可用的实测 | 以占位实现、无关同名工具或仅 schema 冒充功能 |

B1 至 B5 均重新固定当时最新稳定版。B0 的矩阵先记录当前状态，不能预填完成状态。每批只处理一个可独立评审的子系统；若同时修改多个运行时所有者则继续拆分。所有批次及最终跨批次漂移审查统一提交到 PR #17，批次之间不独立合并；PR 在最终严格门禁和必要外部实测完成前保持 Draft。

当前两个 hook 的故障由 B1 根治，不先增加会被 B0/B1 重构覆盖的临时白名单补丁。

### 4.6 外部能力分类

#### 4.6.1 Desktop 专属，终端 CLI 忽略

以下键按官方文档由 Desktop 读取，terminal CLI 忽略：

- `browserExternalPageTools`
- `disableBrowserExternalNavigation`
- `disableMobileSimulatorTools`
- `disableDesktopLocalSessions`
- `disableRemotePreviewScripts`
- `sshHostAllowlist`
- `sshHostCommands`

这些项在对齐 schema 和忽略语义后可标为 `ignored-by-design`，测试必须证明 CLI 不产生 Desktop 行为。`sshConfigs` 已在 flash schema 中，应另按 CLI 实际语义验收，不能随上述键一起排除。

#### 4.6.2 已有实现基础，补配置接线

| 能力 | 当前实现证据 | 主要缺口示例 |
|---|---|---|
| Remote Control | `src/bridge/bridgeEnabled.ts`，受 `BRIDGE_MODE`、订阅和服务端 gate 控制；`remoteControlAtStartup` 已有 global-config 路径 | `disableRemoteControl` 等配置接线及来源语义 |
| claude.ai MCP | `src/services/mcp/claudeai.ts` 的 `fetchClaudeAIMcpConfigsIfEligible`，OAuth `user:mcp_servers` scope 和 `ENABLE_CLAUDEAI_MCP_SERVERS` | `disableClaudeAiConnectors`、`allowAllClaudeAiMcps` 等消费者 |
| 远程 managed settings | `src/services/remoteManagedSettings/index.ts` 已有获取、缓存、校验和轮询 | `forceRemoteSettingsRefresh` 等接线和统一合并 |
| 跨会话消息 | `src/bridge/crossSessionMessages.ts`、`src/bridge/peerSessions.ts` | `crossSessionInbound`、`isolatePeerMachines` 配置消费者 |

`forceLoginGatewayUrl`、`gatewayInternalNetworks`、`autoContinueAtUsageLimit`、`dialogExpiry`、`feedbackDrafts`、`switchModelsOnFlag` 等键在初次盘点中未找到源码引用，各批次必须继续区分“底层功能存在未接线”和“能力整体缺失”，不能仅凭键名归类。

#### 4.6.3 未找到对应功能实现

- `disableArtifact` / `enableArtifact` 对应的 claude.ai Artifact 发布。
- `syncClaudeAiPlugins` / `syncClaudeAiSkills` 对应同步。
- mods 的 `prependPlugins` / `appendPlugins`。
- 反馈草稿、用量重置后自动继续等无消费者能力。

这些项进入独立子项目。`ReviewArtifactTool` 是代码审查工具，`src/ssh/artifact.ts` 是 SSH 构建产物传输，均不是 Artifact 发布实现。复制本地目录也不能在协议未证实前冒充 claude.ai 同步。

### 4.7 测试与漂移检测

1. 将临时对比逻辑固化为仓库检查，比较官方配置/hook/env 清单、矩阵和 flash schema，输出缺失、额外及状态不一致项。
2. 每个配置用表驱动测试覆盖合法值、非法值、默认值、来源、合并优先级和真实运行时效果；只测解析不算完成。
3. hooks 另测触发时机、stdin payload、stdout/exit code 协议、matcher、超时和错误传播。
4. 上游二进制黑盒探测是固定版本的可选验证步骤，输出脱敏后进入证据包；常规 CI 使用仓库内 fixtures，不依赖上游二进制、网络或账号。
5. 涉及真实 claude.ai、Desktop、Cloud 或企业服务时，单元测试和协议 fake 只证明本地逻辑；还需对应环境实测。环境不可用时保持 `partial` 或 `missing` 并记录阻塞项。
6. 基线升级时重新运行差异检测，更新矩阵和相关 spec，不能只修改一个版本号。

### 4.8 批次发布门槛

每批必须同时交付实现、行为测试、矩阵状态、具体 spec 和 coverage 更新，并通过：

```bash
bun run test
bun run build
bun run typecheck
bun scripts/check-design-docs.ts
# B0 落地后：兼容矩阵与差异检查命令
```

完整测试以进程退出码和是否存在 `Failed test files` 为准，不能只看最后一个文件的 pass 数。README 或已有双语文档改动必须双语成对提交。提交信息遵循仓库署名约定。

## 5. 失败语义与工程取舍

| 触发条件 | 目标处理方式 | 影响范围 | 禁止行为 |
|---|---|---|---|
| 未知顶层/嵌套配置 | 忽略未知项，给出来源和路径诊断，继续加载有效项 | 仅未知项 | 整个 settings 文件失效；把未知项宣称为已支持 |
| 未知 hook 事件 | 跳过该事件配置并警告，保留同文件其他 hook 和设置 | 仅未知事件 | 因未来事件导致权限、模型等配置全部失效 |
| 普通已知字段类型错误 | 不采用错误值；按上游证据保留有效兄弟项 | 该字段及必要父对象 | 使用强制转换伪造合法值；静默无诊断 |
| JSON 语法错误 | 不应用该文件，保留原文件并报告可操作错误 | 该来源 | 部分解析或自动覆盖用户文件 |
| Managed/permissions/sandbox 配置错误 | 按上游 fail-closed；不能回退到较弱允许策略 | 相关安全域 | 为可用性绕过企业策略或沙箱限制 |
| 上游文档与二进制不一致 | 先检查版本，再以同版本实测行为修正设计 | 对应条目 | 选择性采用更方便的证据 |
| 二进制缺少文档中的新事件 | 保持未验证，寻找包含该能力的稳定版 | 对应条目 | 仅加枚举后标为 aligned |
| 外部服务不可用或账号不合格 | 按上游降级行为，记录外部验证阻塞 | 对应外部能力 | 绕过 gate、伪造成功、把 fake 当真实实测 |
| 上游基线升级 | 重新采集差异和行为证据，更新受影响条目 | 新批次及受影响旧条目 | 只改版本号或默认旧测试仍充分 |

主要工程取舍：

- 前期矩阵和检查器成本换取后续每个配置的可审计完成证据。
- 字段级容错提高可用性，但安全域必须保留更严格的失败语义，因此不能用一个全局“fail-open”规则覆盖所有来源。
- 分批固定版本会产生多轮适配，但避免一次性跨模型、权限、UI、MCP 和外部服务的大批量不可审查改动。
- 外部实测会受账号和环境限制；状态保持诚实优于用本地 fake 提前宣布完成。

## 6. 现状验收标准

### 6.1 当前已核实的基线事实

| 检查 | 当前结果 | 证据边界 |
|---|---|---|
| 当前机器 settings 严格校验 | 通过 | 只证明当前文件符合 flash 现有 schema；未记录其中凭据 |
| 官方 settings 与 flash 初次差异 | 99 个顶层键、22 个嵌套键未声明 | 以 2026-11-16 获取文档为输入；最终条目以 B0 固定版本矩阵为准 |
| 官方 hooks 与 flash 差异 | 33 对 27，缺 6 个事件 | 本机 2.1.212 只确认其中 3 个 |
| subagent 上限环境变量 | 路线立项时无源码消费者；2.1.311 已确认总场次上限变量 removed/no-op | Active 并发/深度变量的默认值、解析和边界仍需 B1 三层证据；不得按旧假设实现已移除变量 |
| 另一台机器的故障 | 两个未知 hook 导致配置被拒绝 | 无该机器完整配置，不能替代针对该文件的审核 |
| 外部能力盘点 | 已有接线基础与完整缺失两类均存在 | 初次源码搜索结论，批次开始时需复核 |

### 6.2 总路线验收

只有同时满足以下条件，才能宣称“全量配置对齐”：

1. 矩阵覆盖固定稳定版的全部有效配置、嵌套配置、环境变量和 hook。
2. 除有上游证据的 `ignored-by-design`、removed/no-op 的 `excluded` 和最终基线尚未包含的 `excluded`（reason=`not-in-baseline`）项外，所有 active 条目均为 `aligned`；deprecated 但仍有效的条目不得借生命周期排除。
3. 每个 `aligned` 条目都有正确路径、类型、默认值、来源、合并和运行时行为测试。
4. 当前两个未知 hook 的复现场景通过，且未知事件不再破坏同文件其他配置。
5. Active 环境变量有真实消费者和边界测试；`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` 等 removed 变量有 no-op/无残留行为证据。
6. 外部功能完成所需真实环境验证；不可用项仍保持未完成，不计入全量完成。
7. 全部发布门槛通过，具体模块 spec、coverage 和矩阵引用一致。

### 6.3 批次验收

- B0：矩阵完整且检查可重复；未知项隔离、安全错误策略和来源合并有回归测试。
- B1：全部 33 个 hook 完成协议复核，6 个新增 hook 均按固定版本证据实现完整协议；active subagent 并发/深度限制真实生效，removed 上限变量保持有证据的 no-op。
- B2：本地核心/UI 配置从正确来源读取，默认值和交互行为与上游一致。
- B3：安全字段无法通过无效高优先级配置、路径边界或数组合并绕过。
- B4：已有外部集成配置接线完成，禁用、资格和服务失败路径符合上游。
- B5：每个独立功能具备自身 spec、协议证据、实现和测试；无占位完成状态。

## 7. 代码与测试证据

### 7.1 当前代码证据

| 设计陈述 | 源码证据 | 当前缺口 |
|---|---|---|
| hook 事件枚举不完整 | `src/entrypoints/sdk/coreTypes.ts:25-53` | 缺 6 个官方文档事件 |
| 未知 hook 影响 settings 校验 | `src/schemas/hooks.ts:211-213` | 未知事件导致整个文件被跳过 |
| 已知配置声明与未知字段保留 | `src/utils/settings/types.ts:1112-1113` | passthrough 不提供运行时语义 |
| 部分设置仍从 global config 读取 | `src/tools/ConfigTool/supportedSettings.ts:29-83` | settings 来源和冲突语义未对齐 |
| Remote Control 已有实现基础 | `src/bridge/bridgeEnabled.ts` | 新禁用配置及来源接线待核实 |
| claude.ai MCP 已有客户端 | `src/services/mcp/claudeai.ts` | 新禁用/允许配置无消费者 |
| 远程 managed settings 已有服务 | `src/services/remoteManagedSettings/index.ts` | 强制刷新等配置接线待核实 |
| 跨会话消息已有实现 | `src/bridge/crossSessionMessages.ts`、`src/bridge/peerSessions.ts` | inbound/isolation 配置无消费者 |
| Artifact 同名代码不属于发布能力 | `src/ssh/artifact.ts`；ReviewArtifact 工具 | 未找到 claude.ai Artifact 发布实现 |

### 7.2 外部文档证据

- `/tmp/claude-settings-reference.md`：2026-11-16 获取的官方 settings 参考临时快照，仅用于立项对比；B0 应形成脱敏、版本化且可维护的证据包。
- `/tmp/claude-hooks-reference.md`：同日获取的官方 hooks 参考临时快照。
- 本机上游二进制：`/opt/homebrew/Caskroom/claude-code/2.1.212/claude`，用于事件字符串观测；不等于最新稳定版完整行为验证。
- 本仓库契约：`docs/external-stubs/contracts/*.md`，各批次必须按涉及子系统逐一引用，不能用本总路线替代。

### 7.3 测试策略证据

| 测试层 | 必须证明 | 不能证明 |
|---|---|---|
| schema/矩阵检查 | 清单完整、类型声明、状态和引用一致 | 运行时行为正确 |
| 来源合并单元测试 | 默认值、优先级、数组/对象合并、诊断 | 各消费者真正使用最终值 |
| 运行时行为测试 | 配置改变实际行为和协议 | 与未观测的上游新版本完全一致 |
| 上游二进制探测 | 固定版本的黑盒行为和文档歧义 | 其他版本或私有服务端行为 |
| 协议 fake 集成测试 | 本地请求、响应、错误和降级逻辑 | 真实账号资格、线上 gate 和服务协议当前状态 |
| 真实环境验证 | claude.ai/Desktop/Cloud/企业服务的端到端行为 | 非测试环境的所有未来变化 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/upstream-configuration-alignment.yaml)

本总路线当前不主拥有任何既有源码、测试或脚本文件，避免与 settings、hooks-system、bridge、mcp 等 spec 重复声明。B0 新增兼容检查脚本后，应将新增文件登记到本路线 coverage；各运行时文件仍由对应功能 spec 主拥有。

相关 spec：

- `2026-11-12-settings-design.md`：设置来源、合并、缓存、迁移与远程托管。
- `2026-11-12-hooks-system-design.md`：hook 配置、匹配、执行和协议。
- `2026-11-12-permissions-design.md`：权限裁决与安全策略。
- `2026-11-12-mcp-design.md`：MCP 客户端与服务器配置。
- `2026-11-12-plugins-design.md`：插件配置与生命周期。
- `2026-11-12-bridge-design.md`、`2026-11-12-remote-control-design.md`：bridge 与 Remote Control。
- `2026-11-12-external-stubs-design.md` 及 `docs/external-stubs/contracts/`：外部构建与私有协议边界。

B1-B5 的功能 spec 必须更新上述主文档或新增更具体的子系统设计，并登记 coverage；不能只链接本路线。

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 当前 99 个顶层键、22 个嵌套键和 6 个 hook 差异分散在多个子系统 | 先完成 B0 矩阵和可重复差异检查，再启动功能批次 | 中：解析错误策略变化可能影响现有配置 | 全量条目唯一且可追踪；未知 hook 回归测试通过 | M | 已证实：已复现并完成初次机器对比 |
| P1 | 另一台机器的 settings 因两个未知 hook 被整体跳过 | B1 同时补事件协议和错误隔离，不做仅加枚举的临时补丁 | 高：hook 可影响权限和主流程 | 6 个事件触发、payload、输出和错误行为测试；原配置脱敏复现 | M | 已证实：故障已复现，3 个事件有二进制证据 |
| P1 | Managed/permissions/sandbox 字段错误可能因容错而降低安全级别 | B0/B3 为安全域建立独立失败语义和黑盒证据 | 高：可能引入权限绕过 | 无效高优先级策略、路径边界和合并绕过测试 | L | 待运行验证：安全失败策略需上游实测 |
| P2 | Cloud/Desktop/claude.ai 真实环境并非当前环境都能验证 | 为外部子项目准备独立测试环境和脱敏证据模板 | 中：fake 与线上行为可能分叉 | 本地 fake 通过之外，还有对应环境实测；不可用时状态不升级 | M | 当前环境限制已确认 |
| P2 | 上游稳定版持续变化，矩阵会漂移 | 每次基线升级重新生成差异并审核受影响行为 | 中：新增字段可能改变默认值或合并语义 | 新旧基线差异报告、受影响测试和 spec 同步更新 | M | 设计推断，已有文档领先本机二进制的实例 |
