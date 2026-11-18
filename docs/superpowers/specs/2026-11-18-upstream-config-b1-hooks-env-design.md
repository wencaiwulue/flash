---
id: upstream-config-b1-hooks-env
batch: 1
title: B1：Hooks 与 subagent 环境变量对齐设计
date: 2026-11-18
status: draft
---

# B1：Hooks 与 subagent 环境变量对齐设计

本文实现全量配置对齐路线的 B1：补齐 flash 缺失的 6 个 hook 事件（UserPromptExpansion、PostToolBatch、MessageDisplay、DirectoryAdded、PreModelSwitch、PostModelSwitch），对齐 2 个 active subagent 环境变量，并审计既有 27 个 hook。基线为上游 Claude Code **2.1.311**（npm stable；latest/next=2.1.327 不采用）。工作统一在 PR wencaiwulue/flash#17（保持 Draft）。

## 1. 问题与约束

### 1.1 现状差距

- flash `HOOK_EVENTS` 仅 27 项（`src/entrypoints/sdk/coreTypes.ts:25-53`），上游 2.1.311 `doctor` 列出 33 项（`fixtures/upstream-config/2.1.311/probes/hooks-doctor.txt`），缺 6 项。
- `coreSchemas.ts` 的 `HookInputSchema` union 与 `hookSpecificOutput` union 均未含这 6 个事件。
- 2 个 active subagent env（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`、`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`）无真实消费者与运行时限额。
- 真实 2.1.311 矩阵中 6 个 hook 条目均为 `missing/evidence:[]`。

### 1.2 证据缺口（B0 遗留）

- B0 的 `doctor` 仅列出事件名，`hooks-results.json` 仅测 4 类通用解析容错，**无六事件运行协议**（stdin payload、stdout 决策、exit/timeout/matcher）。
- 本机 `/opt/homebrew/bin/claude` 为 2.1.212，仅含其中 3 个事件，**不能作为最终证据**；须用 B0 保留的 2.1.311 原生二进制。
- external-stubs 无六事件契约；既有 hooks-system 仅提供通用执行/退出码约束。

### 1.3 约束

1. 仅加 schema 不得标 `aligned`；每事件须触发点接线 + 行为测试 + 三层证据。
2. `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` 自 2.1.224 起 removed/no-op，**不得重新实现**上限，矩阵标 `removed-excluded`。
3. 黑盒实测须隔离（临时 HOME/CLAUDE_CONFIG_DIR/project），不读写用户真实配置；后端经 Kimi 代理触发。
4. `register_repo_root` 在 flash 全 src 无实现，DirectoryAdded 的该 source 路径单列缺口。

## 2. 设计理由与备选方案

### 2.1 为什么逐事件黑盒实测

strings 只能给出字段名与静态线索，无法确定运行时 payload 的实际取值（如 `to_model` 是否 canonical、`prompt` 是原始还是扩展后、失败工具如何序列化）。逐事件黑盒实测可直接支撑 `aligned`，避免"仅加 schema"的伪对齐。用户已确认采用此深度。

### 2.2 为什么沿用 2.1.311 而非 2.1.327

2.1.311 是 npm stable，与 B0/Task 2 基线一致；2.1.327 是 latest/next，跨基线会引入额外 drift。B0 的 2.1.311 原生二进制仍在 `/tmp`（版本/SHA256 与 evidence.json 一致），无需重下。

### 2.3 备选方案与否决

- **仅 strings + 文档**：证据不足以标 `aligned`，否决（用户选择逐事件实测）。
- **用 2.1.212 本机二进制实测**：缺 3 个事件，否决。
- **先实现后补证据**：易退回"仅加 schema"，否决。

## 3. 目标与非目标

### 3.1 目标

- 6 个 hook 事件：类型/schema + 触发点接线 + 行为测试 + 三层证据，矩阵标 `aligned`。
- 2 个 active env：真实消费者 + 运行时限额 + 非法值回退，标 `partial`（运行时实测留最终 xxx）。
- 既有 27 hook 审计：确认触发点与通用协议一致。

### 3.2 非目标

- 不实现 `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`（removed/no-op）。
- 不实现 `register_repo_root` 路径（flash 无此 SDK 入口，单列缺口）。
- 不在 B1 补 env 运行时限额实测、PostModelSwitch 的 auto/resume 实测、MessageDisplay 交互多批序列实测（留最终 xxx）。

## 4. 架构、模块与数据流

### 4.0 共通协议（六事件共享）

| 要素 | 决策 | 证据 |
|------|------|------|
| 基础字段 | BaseHookInput（`session_id/transcript_path/cwd`，实测另有 `prompt_id`，`permission_mode` 视模式）+ `hook_event_name` | P:全部 |
| `hookSpecificOutput.hookEventName` | 必须等于事件名 | D1079-1107；S660984 |
| exit 0 | 应用 stdout JSON | D798-901 |
| 非 0/2、启动失败、无效 JSON | 默认**非阻塞**；`onFailure:"block"` 例外 | D974-982；P:exit1 |
| `async:true` | 仅 command；后台、不强制 timeout、决策字段无效 | D4160-4200；S666865 |
| 默认 timeout | command/http/mcp_tool 600s；prompt 30s；agent 60s；MessageDisplay 10s；Pre/PostModelSwitch 30s | D423；S 常量 `Rp=600000,dFo=30000,hVs=5000` |
| 顶层通用 stdout | `continue/stopReason/systemMessage/terminalSequence/decision("approve"\|"block")/reason`，各事件只消费声明字段 | D1079-1107；S660984 |

证据标记：**D:行号**＝`/tmp/claude-hooks-reference-2.1.311.md`；**S:行号**＝2.1.311 二进制 strings；**P:<event>**＝`fixtures/upstream-config/2.1.311/probes/b1-<event>.json` 实测。

### 4.1 UserPromptExpansion

| 要素 | 决策 | 证据 |
|------|------|------|
| 触发 | skill/custom command 或 MCP prompt **扩展后、送达模型前**同步；直接 `/skill` 不经 Skill 工具 PreToolUse | D1601-1607；S692771 |
| stdin | `expansion_type:"slash_command"\|"mcp_prompt"`、`command_name`、`command_args`、`command_source?`、`prompt`（**原始输入**，非扩展正文） | D1611-1625；**P** 实测 `slash_command/probe/"a b"/projectSettings/"/probe a b"` |
| stdout HSO | `{additionalContext?, suppressOriginalPrompt?}`；顶层 `decision:"block",reason`；exit 0 plain stdout 亦作上下文 | D836,1628-1648；S660984 |
| exit/阻塞 | exit 2 阻止扩展，stderr 用户可见；其他错误放行 | D1033,1638；**P:block** 阻止 |
| matcher | 匹配 `command_name`，空则全部 | D1607,3980-3993 |
| timeout | command 默认 600s | D423 |
| flash 接线 | `processSlashCommand.tsx:950-971,1114-1171` 扩展后、入模型前 | B1 调查 |

### 4.2 PostToolBatch

| 要素 | 决策 | 证据 |
|------|------|------|
| 触发 | 整批并行工具全部 resolved 后、下一模型请求前**同步一次**；**无 matcher** | D2447-2449 |
| stdin | **`tool_calls`**（非 `tool_uses`），每项 `{tool_name,tool_input,tool_use_id,tool_response?:string\|content-block[]}` | D2453-2479；**P** 实测两项 Read |
| 失败序列化 | 以 `tool_use_id` 建 `tool_result.content` 映射；**失败工具传模型所见序列化 content**（实测 `"File does not exist…"`），**无 `error/is_interrupt/is_error`**；允许缺 `tool_response` | D2479-2483；S677085；**P:record** |
| stdout HSO | 仅 `{additionalContext?}`；`decision:"block"` 或 `continue:false` 停 agentic loop；**无批量 `updatedToolOutput`** | D2485-2502 |
| exit/阻塞 | exit 2 停 loop（reason/stopReason/stderr）；其他错误继续 | D1043,2502；**P:block** `result=""`；**P:exit1** 继续 |
| timeout | command 默认 600s；同步配置推迟下一模型请求 | D423 |
| flash 接线 | `query.ts:1385-1416` 工具批 resolved 后、下一模型请求前 | B1 调查 |

### 4.3 MessageDisplay

| 要素 | 决策 | 证据 |
|------|------|------|
| 触发 | 交互 REPL 每批完整行渲染前同步等待，长消息多次，tool-only 不触发；headless/SDK 每条 assistant 文本完成后**仅一次** `index=0,final=true,delta=全文` | D1651-1667；S695640；**P** headless 单次 |
| stdin | `turn_id`、`message_id`（同消息各批稳定 UUID）、`index:int`、`final:boolean`、`delta:string` | D1671-1692；**P** 实测 |
| stdout HSO | `{displayContent?}` **仅替换屏幕 delta**；transcript 与模型所见仍原文；`systemMessage/continue` 丢弃，**不能阻塞** | D1695-1703；**P:display** `result=PROBE_DISPLAY` |
| exit/阻塞 | exit 2、失败、超时**均显示原文**；失败写 debug | D1062,1661,1779；**P:block/exit1** 显原文 |
| matcher | 无 | D1651 |
| timeout | 默认 **10s**；二进制带 `forceSyncExecution:!0` | D423,1661-1665；S671593 |
| flash 接线 | 交互 `REPL.tsx:1978-2000`、`utils/messages.ts`；headless `cli/print.ts` | B1 调查 |

### 4.4 DirectoryAdded

| 要素 | 决策 | 证据 |
|------|------|------|
| 触发 | `/add-dir` 或 SDK `register_repo_root` 成功添加后、sandbox/permission 刷新完成后**后台**；启动 `--add-dir`、Permissions UI、重复目录**不触发** | D3124-3136 |
| stdin | `directory`（绝对路径，实测保留用户输入形式）、`source:"slash_command"\|"register_repo_root"` | D3145-3162；**P** 实测 `source=slash_command` |
| stdout | **无 HSO、无决策**；`continue` 丢弃；slash_command 的顶层 `systemMessage` 下一轮交给 Claude | D3165-3168 |
| exit/阻塞 | **不能撤销添加**；exit 2 stderr 仅 debug | D1051；**P:block/exit1** 目录仍添加 |
| matcher | 匹配 `source` | D3136-3143 |
| timeout | 内在后台，默认 600s | D3136-3143 |
| flash 接线 | `add-dir.tsx:61-108`；**`register_repo_root` 无实现，单列缺口** | B1 调查 |

### 4.5 PreModelSwitch

| 要素 | 决策 | 证据 |
|------|------|------|
| 触发 | 请求切换**真正应用前同步**：`/model`、picker、`/config`、fast mode、SDK `set_model`；**自动 fallback 与 resume 不触发** | D3451-3461 |
| stdin | `from_model,to_model`（canonical ID）、`requested_model:string\|null`、`source:"command"\|"picker"\|"sdk"`、`context_tokens:number`、`prompt_cache_warm:boolean`、`cache_ttl:"5m"\|"1h"`、`estimated_cache_write_usd:number`、`pricing:"configured"\|"catalog"\|"default"` | D3535-3566；**P** 实测 `to_model=claude-opus-5-5,requested_model=opus,source=command,pricing=catalog` |
| stdout HSO | `{permissionDecision?:"allow"\|"deny"\|"ask",permissionDecisionReason?}`；亦接受顶层 `decision:"block"`；allow 跳过暖缓存确认；ask 仅交互 `/model` 可询问，其他界面视为拒绝；多 hook **deny>ask>allow**；不支持 defer/updatedInput/additionalContext | D3569-3596 |
| exit/阻塞 | exit 2 取消并显示 stderr；**超时也取消（fail-closed）**；其他错误继续 | D1055,3598-3602；**P:deny/block** `was blocked by a PreModelSwitch hook`；**P:exit1** non-blocking 继续 |
| matcher | 匹配 `to_model` canonical 名，忽略 `[1m]`，alias/日期/提供商归一；无法 canonicalize 时运行全部 | D3463-3467,3600 |
| timeout | 默认 **30s** | D423 |
| flash 接线 | `commands/model/model.tsx`、`sdkControl.ts`、`sdkRemoteControl.ts`、`onChangeAppState.ts` | B1 调查 |

### 4.6 PostModelSwitch

| 要素 | 决策 | 证据 |
|------|------|------|
| 触发 | 会话模型改变后**异步**：请求切换、自动 fallback、opusplan plan-mode 变化、resume；**单 turn fallback chain 不触发** | D3604-3617 |
| stdin | 与 Pre 相同，`source` 扩展 `"command"\|"picker"\|"sdk"\|"auto"\|"resume"`；auto 时 `requested_model=null` | D3641-3645；**P** 实测 `source=command` |
| stdout HSO | `{additionalContext?}`；exit 0 plain stdout 亦作上下文，**下一次新模型请求**投递；下一 prompt 后最多等 **5s**（`hVs=5000`），未完成顺延；连续多次切换只保留最后目标模型输出 | D3647-3655；S660984 |
| exit/阻塞 | **不可取消**；exit 2 stderr 仅用户可见，Claude 不见 | D1056,1064；**P:block/exit1** 仍触发 |
| matcher | canonical `to_model` 规则同 Pre | D3617 |
| timeout | 默认 30s，后台运行 | D423 |
| flash 接线 | `commands/model/model.tsx`、`sessionRestore.ts`、fallback 路径 | B1 调查 |

### 4.7 subagent 环境变量

| 变量 | 状态 | 决策 | 证据 |
|------|------|------|------|
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | active（2.1.217+） | 同时运行 subagent 上限，默认 **20**；结构化 `default` 为 `null`，正文记录默认 20 | inventory.json:11532-11550 |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | active（2.1.217+） | subagent 嵌套派生深度上限，默认 **3**；结构化 `default` 为 `null`，正文记录默认 3 | inventory.json:11654-11672 |
| `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` | **removed/no-op（2.1.224+）** | **不实现**，矩阵 `removed-excluded` | B0 inventory |

实现：在 subagent 派生路径接入并发上限（默认 20）与深度上限（默认 3），读取 env 覆盖；非法值回退默认。真实消费者 + 限额单测；运行时实测留最终 xxx。

## 5. 失败语义与工程取舍

- **exit 0**：应用 stdout JSON；plain stdout 在 UserPromptExpansion/PostModelSwitch 亦作上下文。
- **exit 2**：UserPromptExpansion 阻止扩展；PostToolBatch 停 loop；PreModelSwitch 取消切换；MessageDisplay/DirectoryAdded/PostModelSwitch 仅显示/记录，不改变结果。
- **非 0/2 / 启动失败 / 无效 JSON**：默认非阻塞（`onFailure:"block"` 例外）。实测 PreModelSwitch exit1 显示 `non-blocking status code` 且切换继续。
- **timeout**：PreModelSwitch 超时**取消切换（fail-closed）**；MessageDisplay 超时显示原文；其余事件按通用 timeout。
- **async**：仅 command，后台执行、决策字段无效；DirectoryAdded/PostModelSwitch 内在后台。
- **取舍**：PreModelSwitch 的 ask 在非暖缓存（`prompt_cache_warm=false`）时无需确认直接切换（实测），实现须按暖缓存决定是否询问。

## 6. 现状验收标准

- 6 hooks：类型/schema + 触发点 + 行为测试 + 三层证据齐备，矩阵 `aligned`（spec 登记 `upstream-config-b1-hooks-env`，`currentReview.baseline=2.1.311`）。
- 2 个 active env：限额实现 + 单测，矩阵 `partial`；`MAX_SUBAGENTS_PER_SESSION` 矩阵 `removed-excluded`。
- 门禁：`bun run typecheck`、`bun run test`、`bun run build`、`checkUpstreamConfigCompatibility --batch 1`、`check-design-docs` 全绿；独立评审 Approved。
- 真实矩阵 `--batch 1` drift=0，六事件状态由 `missing` 转 `aligned`。

## 7. 代码与测试证据

### 7.1 三层证据

- 官方文档：`/tmp/claude-hooks-reference-2.1.311.md`（SHA256 `a1cc3f82…`）。
- 二进制 strings：`/tmp/flash-upstream-2.1.311.hQPPEu/native/package/claude`（SHA256 `85d8c087…`，与 B0 evidence.json 一致）。
- 黑盒实测：`fixtures/upstream-config/2.1.311/probes/b1-{UserPromptExpansion,PostToolBatch,MessageDisplay,DirectoryAdded,PreModelSwitch,PostModelSwitch}.json`。

### 7.2 probe 设施

- `fixtures/upstream-config/b1-hooks-probe.ts`：headless（PostToolBatch/MessageDisplay）+ 交互 pty（其余四事件）驱动；通用记录器按 `RECORDER_MODE` 输出决策。
- `fixtures/upstream-config/b1-interactive.py`：pty 驱动交互 REPL；通过预写 `CLAUDE_CONFIG_DIR/.claude.json`（`hasCompletedOnboarding` + `projects[cwd].hasTrustDialogAccepted`，含 realpath）跳过 onboarding/trust；slash command 用 keys 分步发送 + 单独回车避免路径补全拦截。

### 7.3 行为测试

- 每事件：payload 构造、stdout 决策应用、exit 0/2/其他、timeout、matcher、async（如适用）单测 + 集成测试，对齐 §4 实测语义。
- env：并发/深度限额与非法值回退单测。

## 8. 文件覆盖与相关子系统

coverage：[upstream-config-b1-hooks-env.yaml](../../architecture/coverage/upstream-config-b1-hooks-env.yaml)（`groups: []`，运行时代码主归属由 hooks-system、settings 等既有 coverage 维护，避免重复拥有文件）。

涉及文件：
- 类型/schema：`src/entrypoints/sdk/coreTypes.ts`、`src/entrypoints/sdk/coreSchemas.ts`。
- 触发点：`processSlashCommand.tsx`、`query.ts`、`REPL.tsx`、`utils/messages.ts`、`cli/print.ts`、`add-dir.tsx`、`commands/model/model.tsx`、`sdkControl.ts`、`sdkRemoteControl.ts`、`onChangeAppState.ts`、`sessionRestore.ts`。
- env：subagent 派生路径（Agent 工具/`execAgentHook.ts` 等）。
- 矩阵：`fixtures/upstream-config/2.1.311/compatibility.yaml`。

相关子系统：hooks-system（通用执行/退出码）、settings（env 读取）、tool-framework（工具批）。

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | DirectoryAdded 的 `register_repo_root` 路径在 flash 全 src 无实现 | B1 仅覆盖 `slash_command`，矩阵注明缺口；如需 SDK 目录注册再补 | 低 | DirectoryAdded slash_command 行为测试通过 | M | 实测 |
| P2 | env 运行时限额实测（>20 并发 / >3 深度）、PostModelSwitch auto/resume、MessageDisplay 交互多批序列成本高 | 留最终 xxx 统一补实测后升级状态 | 中 | 运行时限额与 source=auto/resume 实测通过 | M | 设计推断 |
| P3 | 基线升级到 2.1.327 时六事件协议可能漂移 | 对六事件重跑 probe 确认协议未漂移 | 中 | 新基线 probe drift=0 | M | 设计推断 |
