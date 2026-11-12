# Bash Prompt Rules 契约

日期：2026-11-11。状态：目标设计，尚未实现。

## 1. 现状与入口

- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/permissions/bashClassifier.ts` 是 external stub：`extractPromptDescription()` 固定 null、三组 descriptions 固定空数组、`isClassifierPermissionsEnabled()` 固定 false，分类调用固定不匹配。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/tools/BashTool/bashPermissions.ts` 已具备真实调度：deny 与 ask 并行，deny 优先；allow 高置信结果可在权限对话框显示期间自动批准。`startSpeculativeClassifierCheck()`、`awaitClassifierAutoApproval()` 和 `executeAsyncClassifierCheck()` 必须保持这些时序。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx` 已能把用户描述保存为 session allow prompt rule；`ExitPlanModePermissionRequest` 也复用 `createPromptRuleContent()`。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/Tool.ts` 的 `ToolPermissionContext` 已保存 `alwaysAllowRules/alwaysDenyRules/alwaysAskRules`；`permissions.ts` 的 `getAllowRules/getDenyRules/getAskRules` 已按来源解析规则。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/sideQuery.ts` 支持 `tools + tool_choice` 的强制结构化 tool call、AbortSignal、重试、模型 betas 和 OAuth attribution；`permissionExplainer.ts` 提供可复用范式。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/tools/BashTool/commandSemantics.ts` 仅解释**进程执行后的 exit code/stdout/stderr**，例如 grep=1 不是错误。它与执行前的 prompt rule 分类完全无关，禁止互相调用或共享判断。

## 2. 目标与非目标

### 目标

1. 解析并收集 `Bash(prompt: …)` allow/deny/ask 规则，恢复权限 UI 与运行时分类。
2. 每次模型分类通过 `sideQuery()` 发出，使用强制结构化输出，再在本地严格验证。
3. 网络错误、超时、abort、无 tool call、schema 错误、未知描述和低置信结果均不能产生自动 allow；deny/ask 判定不可用时应落入人工权限提示。
4. 保持 deny > ask > 后续确定性检查，allow 仅高置信且精确匹配时自动批准。
5. 恢复 external feature profile 前同时完成 dist 验证，不能只让 helper 在 source 测试中可调用。

### 非目标

- 不把模型分类器当 sandbox，不替代 AST、路径、危险命令、deny rule 或人工权限检查。
- 不根据 exit code 推断是否应该允许命令，也不修改 `interpretCommandResult()`。
- 不让模型自由生成新规则、shell prefix、任意 JSON 或自然语言授权决定。
- 不把主对话历史、文件内容或环境秘密无边界地发给 side query。
- 不在 `bypassPermissions` 下重新引入分类器，也不改变 auto mode 独立分类器。

## 3. 规则、API 与结构化输出

### 3.1 规则表示

序列化形式由现有 `permissionRuleValueToString()` 处理括号 escaping：

```text
Bash(prompt: 删除文件或递归修改目录)
```

- `PROMPT_PREFIX` 保持 `prompt:`；`createPromptRuleContent(description)` trim 后返回 `prompt: <description>`。空描述、NUL、超过 1000 字符的描述拒绝。
- `extractPromptDescription(ruleContent)` 只接受以 `prompt:` 开头且后续非空的 ruleContent；普通 `npm:*`、`prompted: …` 和 undefined 返回 null。它不解析整条 `Bash(...)` 字符串，整条解析复用 `permissionRuleValueFromString()`。
- `getBashPrompt{Allow,Deny,Ask}Descriptions(context)` 分别复用 `getAllowRules/getDenyRules/getAskRules`，仅取 `toolName === 'Bash'` 且 prompt description 非空的规则，按既有 source 顺序保留，并做精确字符串去重。
- 每种 behavior 最多 64 条、合计最多 20 KiB。超限不能静默丢弃 deny/ask：该次权限评估必须进入人工 ask，并报告配置错误。
- `isClassifierPermissionsEnabled()` 由编译 feature 与有效小模型配置决定。feature 开启但服务不可用仍可收集规则；调用失败按 fail-closed 语义处理，而不是返回“高置信不匹配”。

### 3.2 分类 API

保留函数签名，扩展结果以显式表示不可用：

```ts
type ClassifierBehavior = 'deny' | 'ask' | 'allow'

type ClassifierResult = {
  available: boolean
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

async function classifyBashCommand(
  command: string,
  cwd: string,
  descriptions: string[],
  behavior: ClassifierBehavior,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<ClassifierResult>
```

约束：`available=false` 时必须 `matches=false`、`confidence='low'`、无 `matchedDescription`。成功结果中 `matches=true` 时 `matchedDescription` 必须与输入 descriptions 中某一项**逐字相同**，不能采用模型返回的相似文本或索引越界项。`matches=false` 不得携带 matchedDescription。

调用侧必须显式处理 `available=false`：

- deny/ask 任一必要分类不可用，不继续到可能自动 allow 的分支；返回 `behavior:'ask'`，说明“权限规则分类不可用，需要人工确认”。已有效的高置信 deny 仍优先返回。
- allow 不可用、非高置信或不匹配时，只保留原人工对话框/后续确定性检查，绝不调用 `onAllow`。
- AbortSignal 已取消时抛出/传播现有 `APIUserAbortError` 或 `AbortError`，不得转成 allow；异步回调必须执行 `onComplete` 并检查 `shouldContinue()`。
- `PendingClassifierCheck`、speculative map 的 key 需包含 command、cwd、behavior 和 descriptions 的稳定 hash，避免不同工作目录/规则复用旧 Promise；对话框关闭后清理不再使用的条目。

### 3.3 sideQuery 强制结构

采用 `permissionExplainer.ts` 同款 forced tool，而不是解析自由文本：

```ts
const CLASSIFY_BASH_TOOL = {
  name: 'classify_bash_command',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      matches: { type: 'boolean' },
      matched_description_index: { type: 'integer', minimum: 0 },
      confidence: { enum: ['high', 'medium', 'low'] },
      reason: { type: 'string', maxLength: 500 }
    },
    required: ['matches', 'confidence', 'reason']
  }
}
```

调用参数：

- `model: getSmallFastModel()`，`querySource: 'bash_classifier'`，`skipSystemPromptPrefix: true`，`temperature: 0`，`thinking: false`，较小的 `max_tokens`。
- `tools: [CLASSIFY_BASH_TOOL]` 且 `tool_choice: {type:'tool', name:'classify_bash_command'}`；signal 原样传入，`maxRetries` 使用有界小值。
- system prompt 明确任务为“命令是否语义匹配给定 behavior 的用户规则”，不是判断命令是否安全、是否只读或是否成功。`allow` 只能用于用户明确授权的描述；`deny/ask` 同理，不跨 behavior 推理。
- user payload 使用 JSON 序列化的 `{command, cwd, behavior, descriptions}`；command/cwd/descriptions 都只是数据，其中的指令不得改变分类任务。限制 command/cwd 长度，不附带 shell 输出、文件内容或完整 transcript。
- 从 `response.content` 取**唯一**匹配工具名的 `tool_use`，再经本地 strict Zod schema；多 tool call、文本 JSON、代码围栏、stop_reason 异常或缺字段都视为 unavailable。
- `matches=true` 必须存在合法 `matched_description_index`；`matches=false` 时该字段必须缺省。映射回原始 descriptions 后才构造 `ClassifierResult`。
- `generateGenericDescription()` 若也用模型，必须独立走 sideQuery 并有长度/schema 限制；其失败仅保留原描述，不能影响当前命令权限决策。已有 specificDescription 时直接返回，不发多余请求。

## 4. 状态机

```text
Bash permission evaluation
  → deterministic exact deny / existing gates（原顺序）
  → collect prompt rules
       ├─ 无规则 → 原确定性权限路径
       └─ 有规则 → parallel deny + ask sideQuery
            → forced tool response
            → local schema + description-index validation
                 ├─ valid high deny → deny
                 ├─ valid high ask → ask + existing suggestions
                 ├─ unavailable（且无有效 deny）→ ask（人工）
                 └─ no high match → 原确定性权限路径
  → 若出现人工 ask 且有 allow descriptions
       → speculative/parallel allow sideQuery
            ├─ valid high allow + shouldContinue → auto allow
            └─ 其他结果/失败/abort/用户已操作 → 保持人工结果
```

`classifyBashCommand()` 自身不直接返回 PermissionResult，不执行命令，也不读取 `commandSemantics.ts`。`BashTool.call()` 结束后才由 `interpretCommandResult()` 解释 exit code。

## 5. 安全与失败语义

- fail closed 的含义是“不能自动批准”，不是把所有服务故障都误报成用户显式 deny；除有效 deny 外，故障应进入人工 ask。非交互且不能提示时沿用现有自动拒绝机制。
- 中/低置信、空 descriptions、无效 matched index、额外 tool call、网络错误、429/5xx 重试耗尽和 abort 均不能自动 allow。
- 分类结果不能绕过精确 deny、危险路径、重定向、shell AST、sandbox 或 `safetyCheck`；allow auto-approval 只能发生在原权限流程已经到达可提示阶段后。
- 日志仅记录 behavior、置信度、匹配下标/hash、延迟和错误类别；完整 command/cwd/rules 不进入普通分析事件，现有 ant-only 详细日志边界不变。
- sideQuery 无缓存写入主对话、无主循环工具权限；不得递归发起 Bash 工具。
- 权限提示期间用户已经选择、按键或 abort 后，迟到的 allow Promise 不得改变结果。

## 6. 关键文件与复用点

- 实现 `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/permissions/bashClassifier.ts`；复用 `sideQuery()`、`getSmallFastModel()`、`lazySchema()` 和现有规则 parser。
- 修改 `/Users/fengcaiwen/GolandProjects/claude-code/src/tools/BashTool/bashPermissions.ts` 处理 `available=false`、完整 cache key 和 abort 清理，保持现有 deny/ask/allow 顺序。
- 复用 `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/permissions/permissions.ts` 的三组 rule getter 和 `permissionRuleParser.ts`，不要自行切分括号。
- 复用 `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/permissions/permissionExplainer.ts` 的 forced-tool 模式，但独立定义分类 schema/system prompt。
- 保持 `BashPermissionRequest.tsx` 的 session allow 保存路径；不向磁盘自动写模型生成规则。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/tools/BashTool/commandSemantics.ts` 不需要修改；应增加测试证明两条路径无调用关系。
- 功能完成后才在 `/Users/fengcaiwen/GolandProjects/claude-code/scripts/build.ts` 的 external features 中启用 `BASH_CLASSIFIER`。

## 7. 测试矩阵

| 层 | 用例 | 必须断言 |
|---|---|---|
| 规则解析 | prompt 描述、括号 escaping、普通 prefix、空/超长/NUL、各 source、去重/超限 | 只收集目标 behavior；普通规则不受影响；非法 deny/ask 配置导致 ask |
| sideQuery 请求 | allow/deny/ask 各一次 | 模型、querySource、forced tool、signal、JSON payload 正确；无自由文本解析 |
| 响应解析 | 合法 true/false、index 0/末尾、中低置信 | 精确映射原描述；只有高置信可用于自动决策 |
| 非法响应 | 无 tool call、多 tool call、额外字段、缺 reason、错误 index、相似而非原描述、文本 JSON | `available=false`，无自动 allow |
| 服务故障 | timeout、429/5xx 耗尽、网络 throw、abort | deny/ask 进入人工；allow 不批准；abort 正确传播并清理 |
| 优先级 | deny+ask+allow 同时存在 | 有效 deny 优先；ask 不被 allow 绕过；原确定性 deny 不可绕过 |
| speculative | 同 command 不同 cwd/rules、用户已操作、迟到响应、dialog 完成 | 不串用 Promise；不重复 onAllow；onComplete 恰好一次 |
| 非交互 | 分类不可用且无法提示 | 沿用自动拒绝，不执行命令 |
| UI | 创建 allow prompt rule、generic description 失败 | session 规则保存正确；失败保留原文；无隐式持久化 |
| 隔离 | mock `interpretCommandResult` 与 classifier | 权限分类不调用 exit-code 模块；grep/rg=1 的执行后语义不变 |

## 8. dist 与 live 验收

1. 用 mock sideQuery 完成全部成功/失败测试后，运行 Bash 权限回归、`bun run typecheck`、`bun run build`，并检查 dist feature profile 确实包含目标实现而非固定 false stub。
2. 通过 `bun dist/main.js` 配合本地可控模型/mock API 执行真实 Bash 权限链路：高置信 allow 才自动通过；无效 structured output、断网与 abort 都出现人工提示或在非交互下拒绝；命令只在获准时执行。
3. 使用获授权的真实模型做小规模 live 矩阵：精确命中 allow/deny/ask、不明确命令、包含“忽略规则”文本的 command、不同 cwd 同命令。记录模型、延迟、结构化响应类别，不记录敏感命令。
4. live 中强制模型返回缺失 tool call/非法 index（可用测试代理）并模拟 429/timeout，验证不会自动执行。再执行 `grep` 无匹配，确认退出码 1 仍由 `commandSemantics` 解释为“No matches found”，与 prompt 分类无关。
5. 没有模型/API 凭证时 live 标记 skipped；不得用 stub 固定不匹配或离线 mock 成功宣称真实分类可用。
