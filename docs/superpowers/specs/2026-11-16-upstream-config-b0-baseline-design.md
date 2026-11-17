---
id: upstream-config-b0-baseline
batch: 3
title: 全量配置对齐 B0：稳定基线、兼容矩阵与局部 Hook 容错设计
date: 2026-11-16
status: approved
---

# 全量配置对齐 B0：稳定基线、兼容矩阵与局部 Hook 容错设计

本文细化已批准的 `upstream-configuration-alignment` 路线中的 B0，不提前实现 B1–B5。B0 交付固定证据、完整清单、机器可读矩阵、schema/hook 差异检查，以及普通文件来源的 hook 局部容错；新增事件的真实运行时协议属于 B1。

## 1. 问题与约束

### 1.1 固定基线

- 2026-11-16 查询官方 `@anthropic-ai/claude-code` dist-tags：`stable=2.1.311`、`latest=2.1.326`、`next=2.1.326`。B0 固定 stable `2.1.311`，不是本机旧版 2.1.212，也不是 latest。
- 原生二进制观测版本为 `2.1.311 (Claude Code)`，doctor 报告 commit `e7d3b8365a0f`、平台 `darwin-arm64`。
- 文档是 2026-11-17T08:57:19Z 获取的实时页面快照；spec/plan 文件名的 2026-11-16 是创建日期，版本目录只表示本批基线，不宣称官方提供版本化文档。证据包记录 URL、实际采集时间和 SHA-256。
- 实时文档可能领先 stable。例如 `permissions.denyInsteadOfPrompting` 标注 Requires v2.1.319。此类条目仍进入清单，但记录 `introduced` 和 `afterBaseline:true`，本批 runtime 只能 blocked，不能声称已在 2.1.311 验证。
- 文档快照包括 settings reference、settings、hooks reference 和 environment variables。证据包还记录 llms.txt 的索引 URL。
- 不采用 `npm view claude-code` 的结果；该名称返回无关包 1.0.0。

### 1.2 已复现行为

2.1.311 在隔离 HOME、`CLAUDE_CONFIG_DIR` 和临时 project 下运行 doctor，得到：

| 输入 | 上游观测 | B0 决策 |
|---|---|---|
| 未知 `FutureUpstreamEvent` | Settings Warning；只忽略该事件，其余配置保留 | 普通文件来源删除该 entry 并产生 warning |
| `SessionStart` 为对象、`PostToolUse` 为数字 | 提示事件必须是 matcher 数组并忽略该 entry | 普通文件来源删除该 entry 并产生 warning |
| `hooks: "invalid"` | 提示 hooks 必须是 event→matcher-array 对象并忽略 hooks 字段，其他配置保留 | 普通文件来源删除 hooks 并产生 warning |
| `model: 42` | `model: Expected string, but received number` | 保持普通 Zod schema 错误，整来源不生效 |
| doctor 有效事件列表 | 33 个事件；含 `UserPromptExpansion`、`PostToolBatch`、`MessageDisplay`、`DirectoryAdded`、`PreModelSwitch`、`PostModelSwitch` | B0 全量登记；B1 才实现运行时协议 |

官方 settings 文档第 195–206 行区分 Settings Error 与 Settings Warning：普通 JSON/schema 错误可跳过文件；未知 hook、畸形权限规则等跳过坏 entry 并保留其余配置。Managed settings 有独立安全降级规则，不能统一 fail-open。

### 1.3 当前实现差异

- `src/utils/settings/settings.ts:178-231` 在 JSON 解析和权限规则预过滤后执行 `SettingsSchema().safeParse()`；任一同类 schema 错误令该来源返回 `settings:null`。
- `src/schemas/hooks.ts:211-213` 使用 `z.partialRecord(z.enum(HOOK_EVENTS), ...)`，未知事件因此污染整个文件。
- `src/utils/settings/schemaOutput.ts` 已有 `generateSettingsJSONSchema()`，可直接作为差异检查输入。
- `src/utils/settings/settingsCache.ts` 缓存 parse/source/session 三层结果；诊断必须与 settings 一起命中和失效，不能另建不同步缓存。
- 本仓库 settings/hooks 既有 spec 与 external-stubs 契约没有授权“所有 managed 错误均忽略”；B0 不发明该语义。

## 2. 设计理由与备选方案

| 决策 | 机制 | 理由 | 不采用的方案 | 证据 |
|---|---|---|---|---|
| 固定 2.1.311 | 证据包记录精确版本、commit、采集日期和内容哈希 | 可重复，且覆盖 33 个事件 | 移动 latest；旧 2.1.212 | 官方 dist-tags；2.1.311 doctor |
| 原始文档与 CI 分离 | 采集时从 Markdown 生成 inventory；CI 只读提交的 JSON/YAML | CI 不依赖网络、私有二进制或账号 | 每次测试下载文档/执行上游 | 总路线第 2 节 |
| inventory 与 matrix 分离 | inventory 是上游事实；matrix 额外记录 flash 实现和验收 | 重采集不会覆盖人工验证结论 | 单一文件全部由生成器覆盖 | B0 需要可重生成与人工状态并存 |
| 只自动 diff settings 与 hooks | settings 来自 JSON Schema，hooks 来自 `HOOK_EVENTS`；env 仍由矩阵证据约束 | 当前没有可信的全量 env 注册表，不能用 grep 冒充语义检查 | 对源码做字符串存在性检查即标记 aligned | 总路线“注入不算完成” |
| 保留 deprecated/removed 标签 | 文档明确标记的项进入 inventory，再由 matrix 记录替代项或排除理由 | 防止悄悄漏项；区分不支持与故意迁移 | 解析时直接删除废弃行 | 总路线排除记录要求 |
| 复合类型保留完整语义 | 仅规范化简单主类型；object/array 的属性、映射、union 与反引号 code span 全文保留；非主类型复合描述保留大小写 | 首个逗号/冒号可能属于属性列表或 code span，截断或整体小写化会伪造类型 | 按首个逗号/冒号切割全部类型；对未识别复合 Type 整体小写化 | 官方 settings reference 的 `hooks`、`permissions`、`sandbox.filesystem`、`strictPluginOnlyCustomization.*` Type 行；SHA-256 `7817edfb…6a6f2f` |
| Type 声明的静态子键同等登记 | 非示例 Type 以 `object with` 开头时，提取该行的静态子键并生成父 anchor 下的 nested entry；已有 index/detail 路径优先 | 上游在父 Type 中明确声明的字段与显式小节一样是配置事实，不能因没有独立标题而漏项 | 只登记 11 个 schema 已知名；从 JSON 示例或动态 map 猜路径 | 同一文档 `modelPicker`、`autoMode`、`sandbox.ripgrep`、`spinnerTipsOverride`、`statusLine`、`voice` 等 Type 行；SHA-256 `7817edfb…6a6f2f` |
| 默认值对齐固定基线 | `default` 表示 2.1.311 有效值；明确 `Before vX` 历史语句按版本边界选择 literal，当前原文留在 excerpt | 实时文档可能已修改默认值，不能把当前文档值误记为 stable 基线值 | 另设平行默认值体系；针对单条路径硬编码 | `sandbox.autoAllowBashIfSandboxed` Default：`false`，Before v2.1.324 为 `true`；同文档 SHA-256 `7817edfb…6a6f2f` |
| 未列出不等于 removed | 只有文档明确标记才设 lifecycle；重采集消失记为 upstream-disappeared 并人工复核 | 实时文档可能调整结构 | 将消失项自动删除或宣称上游移除 | 文档非版本化快照 |
| hooks 三类局部清洗 | 非对象 hooks、未知事件、已知事件非数组分别删除并诊断 | 与 2.1.311 黑盒观测一致，保留有效兄弟配置 | 全字段通用容错；继续整文件失败 | doctor probe；官方 settings 文档 |
| 不扩散容错 | 已知事件数组内部的坏 matcher 仍走 schema；`model` 等普通字段不变 | 这些行为未在本批完整测量 | 递归清洗任意 hook 内容 | 2.1.311 仅证明三类局部行为 |
| managed 默认不启用新增清洗 | managed file 显式关闭；MDM、remote、inline 原路径不变 | 新增容错不得削弱管理策略；待专项证据 | 所有来源复用同一 fail-open | 官方 managed 安全规则；总路线约束 5 |
| warning 与 error 分型 | `ValidationError.severity` 缺省为 error；局部清洗和权限预过滤为 warning | UI 不能把“保留有效配置”显示成“文件整体跳过” | 全部沿用 Settings Error 文案 | 官方 Settings Warning/Error 分类 |
| aligned 需要六维证据 | path/type/default/source/precedence/runtime 各自 aligned 且有证据 | schema 或注入不能代表运行时完成 | 只填一个状态字段 | 已批准总路线验收定义 |

## 3. 目标与非目标

### 3.1 目标

- 固定可审计、可离线检查的 2.1.311 证据和完整 settings/hooks/env 清单。
- 用矩阵区分路径声明、六维运行时证据、未实现、明确差异与排除项。
- 让普通文件来源的三类 hook 局部错误只影响目标字段或 entry，并提供正确 warning。
- 保持普通 schema、managed 安全语义和缓存合并顺序不变。

### 3.2 非目标

- 不实现 B1 新事件运行时协议，不推进 B2–B5 字段实现。
- 不提交完整上游文档、二进制或任何真实用户配置。
- 不通过排除规则、schema passthrough 或环境变量注入伪造 aligned。
- 不在缺少 managed 专项证据时推断其容错规则。

## 4. 架构、模块与数据流

### 4.1 证据包与清单

#### 4.1.1 文件布局

```text
fixtures/upstream-config/2.1.311/
  evidence.json          # 版本、URL、采集时间、文档和二进制哈希、probe 摘要
  inventory.json         # 从文档生成的完整上游事实，不记录 flash 状态
  compatibility.yaml     # 与 inventory 一一对应的实现/测试/排除状态
  probes/
    hooks-doctor.txt     # 脱敏后的有效事件与 warning 输出
    hooks-results.json   # 每个输入的结构化观测，不含 HOME、token、配置正文
```

原始 Markdown 保存在采集流程的临时目录，不提交完整文档或上游二进制。inventory 的每项保留来源 URL/anchor、文档 SHA-256 和必要短摘录，使提交后的证据可审计且测试离线可运行。证据文件中的上游产品名属于外部事实，不是 flash 产品命名。

#### 4.1.2 inventory 数据契约

```ts
type UpstreamInventory = {
  schemaVersion: 1
  baseline: {
    version: '2.1.311'
    distTag: 'stable'
    capturedAt: string // ISO 8601，采集时写入
    documents: Record<string, {
      url: string
      sha256: string
      capturedAt: string
    }>
    binary: {
      version: string
      commit: string
      platform: string
      sha256: string
    }
  }
  entries: UpstreamEntry[]
}

type UpstreamEntry = {
  id: string             // setting:model / setting:sandbox.network / hook:Stop / env:API_TIMEOUT_MS
  kind: 'setting' | 'hook' | 'env'
  path: string           // setting 为点路径；hook/env 为自身名称
  title: string
  types: string[]
  default: unknown       // 固定 2.1.311 的有效默认值；未说明时为 null，另设 defaultDocumented=false
  defaultDocumented: boolean
  scopes: string[]
  sourceRules: string   // 完整 Scope 与来源限制原文；不从 scope 名称推断额外规则
  precedence: string    // Per-session overrides、merge、highest/override 等原文；未说明为空串
  precedenceDocumented: boolean
  lifecycle: 'active' | 'deprecated' | 'removed'
  introduced?: string
  afterBaseline?: boolean
  replacement?: string
  source: { url: string; anchor: string; sha256: string }
  excerpt: string        // 单行、去凭据，只用于审计，不作为运行时输入
}
```

生成器必须：

1. 读取 settings reference 的有效设置表和嵌套小节，保留点路径、scope、完整来源限制、优先级/合并原文、类型、默认值、deprecated/removed。表格索引和详情标题只识别 fenced code block 外的结构行；目标表连续非空块中的畸形数据行必须抛错，正常空行或新标题结束表格。表格 cell 按连续反引号 run 识别 code span，span 内的 `|` 不分列。
2. Scope 行中的 precedence/override/merge/highest/outrank 原文同样进入 `precedence`。未找到优先级说明时 `precedenceDocumented:false`，不得把空串解释为固定优先级。
3. 简单主类型 string/boolean/number/object/array 可规范化为小写主类型；带描述的复合 object/array 必须保留完整语义，不得按逗号/冒号截断属性列表或反引号 code span。非主类型复合 Type 保留原文大小写及 code span/link 文本，只对已识别的主类型术语做小写规范化。Default 的反引号布尔、null、有限数字在后接空白或 `, . ; : ! ?` 时仍转 JSON 值；unset 和描述性默认值保留 `default:null`、`defaultDocumented:true`。`UpstreamEntry.default` 始终表示固定 2.1.311 的有效默认值：对明确的 `Before vX, the default was \`literal\``，baseline<X 时通用解析该历史 literal，baseline>=X 时使用当前 literal；当前文档 Default 原文继续完整保留在 excerpt，不新增平行默认值字段。
4. 只有 lifecycle 为 deprecated/removed 时才从 `use \`replacement\`` 提取 replacement；active 条目的普通示例用语不得生成 replacement。详情警告实际驱动 deprecated/removed 时，必须把该警告原文纳入 excerpt；不得因此放宽 active replacement 提取。
5. 读取 hooks reference 的事件清单；二进制 doctor 列表用于交叉验证，不以文档缺行推断事件不存在。
6. 读取 environment variables 的 Variables 表；包含 deprecated 项。
7. 按 `kind`、`id` 稳定排序，拒绝重复 ID、空 path、非法 lifecycle、无来源或空 source anchor 条目。
8. 从 Requires 语句提取 `introduced`；版本高于 2.1.311 时设 `afterBaseline:true`，matrix 初始状态为 blocked，并在 notes 中记录文档领先 stable。
9. 数量由当次文档重新计算，禁止把早期审核的 `99 + 22` 写成预期常量。

**Type-declared nested entries 数据契约：** 显式 index/detail 小节与父设置非示例 Type 中明确声明的静态子键都是上游事实。后者没有独立标题时也必须进入 inventory，但不能虚构独立小节的元数据。

- 只处理规范化后以 `object with` 开头的父 Type，并且只读取同一 Type 行中的顶层反引号 code span。键名必须匹配静态标识符；括号内的枚举/类型注记、带引号字符串、数字、颜色/函数样值、`Boolean`/`string` 等类型词和 `false`/`null` 等字面量都不是路径。已有 index 或 detail 路径不重复生成。
- `object mapping ... to an object with ...` 表示动态 map，`object keyed by hook event` 表示 hooks 的动态 event 结构；二者不生成去掉动态段的伪静态路径。`object with the sub-keys below` 没有在同行声明键时不猜测。hooks 的 event/matcher 和 JSON/fenced 配置示例均不是该提取器的输入。
- `id`/`path`/`title` 使用 `parent.child`；`source.url`、`source.sha256`、`source.anchor` 指向父节，`excerpt` 保留父 Type 原文并可附父 Scope，确保事实可追溯。`scopes` 与 `sourceRules` 只继承父 Scope 的明确事实。
- 子 entry 一律 `default:null`、`defaultDocumented:false`，不把父对象默认值或示例值当作子字段默认值。`precedence:''`、`precedenceDocumented:false`，不把父对象整体优先级推断成子键独立规则；不继承父 replacement。`lifecycle`、`introduced`、`afterBaseline` 只沿用父级明确事实。
- `types` 默认为 `[]`；只有同一 Type 行把单数 `array`/`object`/`string`/`number`/`Boolean` 直接绑定到该子键、且无歧义提取时才记录对应小写主类型。共享复数类型后缀、字面量 union、动态 map 或仅从 prose/example 可见的类型保持 `[]`，父 Type 原文仍完整保留在 excerpt，未提取不等于宣称上游未说明。

#### 4.1.3 compatibility 数据契约

```yaml
schemaVersion: 1
baseline: 2.1.311
entries:
  - id: setting:model
    status: partial
    implementation:
      - src/utils/settings/types.ts
      - src/services/modelConfig.ts
    tests:
      - tests/upstreamConfigCompatibility.test.ts
    evidence: []
    dimensions:
      path: { status: aligned, evidence: tests/upstreamConfigCompatibility.test.ts }
      type: { status: aligned, evidence: tests/upstreamConfigCompatibility.test.ts }
      default: { status: missing, evidence: '' }
      source: { status: aligned, evidence: src/utils/settings/settings.ts }
      precedence: { status: partial, evidence: src/utils/settings/settings.ts }
      runtime: { status: partial, evidence: src/services/modelConfig.ts }
    notes: B2 完成来源与优先级验收
    exclusion: null
schemaExclusions: []
```

状态只允许 `aligned | partial | missing | different | blocked | excluded`。规则：

- 每个 inventory ID 恰好出现一次；matrix 不得出现 inventory 之外的配置项。
- `aligned` 要求六个 dimension 全为 aligned 且 evidence 非空，implementation/tests 非空；外部 live 尚未验证时只能 blocked/partial。
- `excluded` 必须填写 exclusion 的 `reason`、`evidence`，deprecated 项若有 replacement 必须记录；排除不等于完成。
- `different` 必须记录 notes 和 evidence，属于已声明差异，不会被差异门禁当作“未记录漂移”。
- `schemaExclusions` 只用于 flash 自有 schema 扩展，每项包含 path、reason、evidence；不能用通配符吞掉一组未来字段。
- B0 允许大量 missing/partial，但不允许无记录的新增/删除键。B1–B5 推进状态时必须附行为测试。

### 4.2 生成与差异检查

#### 4.2.1 模块

- `scripts/upstreamConfigInventory.ts`：Markdown→inventory 的纯解析函数和 CLI；重采集时更新 inventory，不修改 compatibility 中的人工状态。
- `scripts/checkUpstreamConfigCompatibility.ts`：读取 inventory/matrix、`generateSettingsJSONSchema()` 和 `HOOK_EVENTS`，输出明确差异并以退出码失败。
- `tests/upstreamConfigInventory.test.ts`：合成 Markdown、重复项、deprecated、稳定排序和真实快照 smoke。
- `tests/upstreamConfigCompatibility.test.ts`：JSON Schema `$ref`/union/嵌套遍历、matrix 状态规则和真实基线检查。

#### 4.2.2 schema 遍历

检查器解析本地 `#/$defs/...` 和 `#/definitions/...` 引用，递归处理 `properties`、`anyOf`、`oneOf`、`allOf`；只收集声明的 properties，不把 `additionalProperties` 的动态 key（如 `env.*`）当作设置路径。循环引用使用 visited 集合。嵌套对象本身和叶子都可登记，但比较集合必须稳定去重。

自动检查：

1. `setting:*` 文档路径与 JSON Schema 声明路径双向比较。
2. `hook:*` 与 `HOOK_EVENTS` 双向比较。
3. schema 独有路径必须存在于精确 `schemaExclusions`。
4. env 不做“源码出现即支持”的判断，只检查矩阵结构、证据和状态。
5. 输出按 `missing-in-flash`、`undocumented-schema-key`、`missing-matrix-entry`、`stale-matrix-entry`、`invalid-aligned-evidence` 分组。`missing-in-flash` 是差异报告：只要 matrix 已如实标为 missing/partial/different/blocked/excluded，B0 不因尚未实现而失败；但若条目或 path dimension 标为 aligned，则失败。其余四组存在未豁免项时退出 1。

B0 初次的真实缺失项必须先全部进入 matrix，再让门禁通过。不得通过把 status 改成 excluded 或添加宽泛 schemaExclusions 消除实现工作；后续批次把 missing 推进到 aligned 时，六维证据门禁会要求真实实现与测试。

## 5. 失败语义与工程取舍

Hook 局部清洗只改变下述普通文件来源的局部失败，不改变其他错误模型。

### 5.1 接口与顺序

在 `src/utils/settings/validation.ts` 增加：

```ts
export function filterInvalidHookSettings(
  data: unknown,
  filePath: string,
): ValidationError[]
```

函数与现有权限预过滤一样，只处理已解析 JSON 的可变对象，并返回诊断：

1. `data` 不是非数组对象，或没有 `hooks` 属性：原样返回空数组。
2. `hooks` 不是非数组对象（包括 null）：删除 `data.hooks`，返回 path=`hooks` 的 warning。
3. 对 `Object.keys(hooks)` 按配置文件原顺序处理：未知事件删除并返回 path=`hooks.<event>` 的 warning；已知事件值不是数组则删除并返回同 path warning。
4. 已知事件数组及其元素不在 B0 清洗；后续 `SettingsSchema().safeParse()` 保持原语义。
5. 不写回文件，不修改其他字段，不执行 hook，不读取事件值中的命令正文用于日志。

`ValidationError` 增加可选 `severity?: 'error' | 'warning'`，缺省按 error 处理，避免批量修改现有构造方。新 hook warning、既有权限 entry warning 显式为 warning，并带 hooks 文档 docLink；schema formatter 显式为 error。

### 5.2 来源边界

`parseSettingsFile(path, options?)` 新增内部选项 `allowHookEntryRecovery`，默认 true，仅普通文件解析使用。`loadManagedFileSettings()` 对 base 与 drop-in 均传 false。以下来源不经过新增清洗：

- managed-settings.json 与 managed-settings.d；
- MDM/HKCU/HKLM；
- remote managed settings；
- flag inline settings；
- 其他直接调用 `SettingsSchema().safeParse()` 的路径。

这不是声明上游 managed 一定整文件失败，而是证据不足时保持现状。矩阵将 managed hooks 容错标为 blocked，后续专项 probe 再决定。

parse 返回的 settings 与 errors 继续一起进入 `settingsCache`；调用方仍收到 clone 的 settings，warning 数组沿用现有缓存语义。清洗后为空对象的 hooks 保留为空对象，不因此发明默认 hook。

### 5.3 展示

`InvalidSettingsDialog` 按 severity 区分：

- 含至少一个 error：保留 Settings Error、跳过无效文件及退出选项。
- 只有 warning：标题为 Settings Warning，说明仅无效 entries 被跳过、有效配置仍生效，只提供 Continue；Escape/onCancel 也执行 Continue，不退出进程。
- warning 与 error 混合：按 error 处理，列表仍展示全部诊断。

这同时修正既有权限 entry warning 的文案，但不改变权限规则解析和 managed 策略。

## 6. 现状验收标准

### 6.1 必测行为

- 未知 hook 与有效 `model`、`apiKeyHelper`、有效 hook 同文件时，仅未知 entry 消失，warning 为 warning。
- `hooks` 为 string/null/array 时只删除 hooks；`model` 等有效兄弟字段保留。
- 已知事件值为 object/number/string/null 时只删除该事件；其他有效事件保留。
- 已知事件数组中的非法 matcher 仍使整个普通来源返回 `settings:null`。
- `model:42` 仍返回 `settings:null` 和 error。
- managed base 与 drop-in 遇到未知 hook 时保持 `settings:null`，不新增 warning 容错。
- cache 首次与二次读取诊断一致，`resetSettingsCache()` 后重新读取。
- 只有 warning 与混合诊断的 dialog 文案和选项分别正确。
- 真实 2.1.311 inventory/matrix 完整对应；33 个 hook 全部登记；deprecated 项未静默消失。

### 6.2 B0 完成条件

- 证据包、inventory 和 matrix 提交，条目数量来自真实快照。
- `bun scripts/checkUpstreamConfigCompatibility.ts` 成功且输出统计；统计不是 aligned 完成声明。
- `bun test ./tests/upstreamConfigInventory.test.ts`、`bun test ./tests/upstreamConfigCompatibility.test.ts`、新增 settings/hook/dialog 测试通过。
- `bun run test`、`bun run build`、`bun run typecheck`、`bun scripts/check-design-docs.ts` 全部以退出码验收。
- B0 不把任何 B1 新事件标为运行时 aligned；不声称全量配置已经完成。

## 7. 代码与测试证据

实施计划：`docs/superpowers/plans/2026-11-16-upstream-config-b0-baseline.md`。

| 层 | 证据位置 | 验证内容 |
|---|---|---|
| 官方文档 | `fixtures/upstream-config/2.1.311/evidence.json` 的 URL、采集时间和 SHA-256；inventory 每项 anchor/excerpt | 配置、事件、环境变量和版本要求 |
| 上游二进制 | evidence binary version/commit/hash；`probes/hooks-doctor.txt`、`probes/hooks-results.json` | 33 个事件、三类 hook 局部 warning、普通字段 error |
| 本仓库契约 | 本 spec、`upstream-configuration-alignment`、既有 settings/hooks-system spec | managed 不扩大容错、六维完成定义、文件归属 |
| 实现与测试 | `scripts/upstreamConfigInventory.ts`、`scripts/checkUpstreamConfigCompatibility.ts`、`tests/upstreamConfig*.test.ts`、`tests/settings*HookCompatibility.test.ts`、`tests/invalidSettingsDialog.test.tsx` | 离线差异、解析行为、managed 边界、诊断展示 |

最终验收以 `bun run test`、`bun run build`、`bun run typecheck`、`bun scripts/check-design-docs.ts` 和 `bun scripts/checkUpstreamConfigCompatibility.ts` 的退出码为准。计划完成时把实际条目和状态统计附在提交/执行报告中，不在证据生成前写死数量。

## 8. 文件覆盖与相关子系统

本 spec 的 coverage：[`upstream-config-b0-baseline.yaml`](../../architecture/coverage/upstream-config-b0-baseline.yaml)。该 coverage 使用 `groups:[]`，不重复取得运行时代码主归属。

- `settings` 继续拥有 `src/utils/settings/**` 的来源、合并、缓存和诊断设计。
- `hooks-system` 继续拥有 hook schema 与运行时协议设计；B1 新事件须在该子系统补充具体行为。
- `upstream-configuration-alignment` 是路线与批次划分，不代替本批实现证据。
- B0 新增的 scripts/tests/fixtures 由本批计划明确列出；若后续转为长期子系统模块，应在 coverage 中登记精确文件主归属，不能与其他 coverage 重复。

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 6 个事件只在 B0 登记，运行时协议尚未实测 | B1 分别收集输入/输出、阻塞、异步和 matcher 证据，再修改 `HOOK_EVENTS` 与运行时 | 高：hook 可影响权限和主流程 | 每个事件的触发、payload、输出和错误行为测试 | M | 已证实：doctor 确认事件，协议尚未验证 |
| P1 | 实时文档含高于 2.1.311 的配置项 | 对应批次重新固定当时 stable，不能沿用 B0 的 runtime blocked 结论 | 中：默认值和合并语义可能变化 | 新基线差异报告及受影响行为测试 | M | 已证实：v2.1.319 Requires 语句 |
| P1 | managed、matcher 内部、remote/inline 的错误语义证据不足 | 另做隔离 probe，只有证据明确时才扩大局部清洗 | 高：可能放宽管理策略 | 各来源有效兄弟配置与安全失败测试 | M | 待运行验证：managed hooks 与各来源错误语义尚未实测 |
| P2 | 实时文档重采集可能出现条目消失 | 保留人工复核记录，不自动删除 matrix 或改写历史证据 | 低：仅影响证据维护 | 新旧 inventory 差异和消失项复核记录 | S | 设计推断 |
