---
id: config-acceptance-suite
title: 集成测试子项目 2：配置对齐行为验收套件设计
date: 2026-11-18
status: approved
---

# 集成测试子项目 2：配置对齐行为验收套件设计

本文细化已批准的集成测试总体架构（`docs/superpowers/specs/2026-11-18-integration-testing-architecture-design.md` 第 5.2 节）中 config-acceptance 套件的具体设计：用例明细、fixture 设计、断言引擎与验收标准。本套件是 upstream-configuration-alignment 路线各批次的行为验收承载。

## 1. 问题与约束

### 1.1 背景事实（执行环境实测）

- B0（`docs/superpowers/specs/2026-11-16-upstream-config-b0-baseline-design.md`）的三类 hook 局部清洗运行时尚未落地：`src/schemas/hooks.ts:212` 仍为 `z.partialRecord(z.enum(HOOK_EVENTS), ...)`，未知 hook 仍拖垮整个文件。
- managed 路径覆盖 `CLAUDE_CODE_MANAGED_SETTINGS_PATH` 被 `USER_TYPE === 'ant'` 门控（`src/utils/settings/managedPath.ts:8-16`），external dist 形态不可用 —— dist 形态无法注入 managed 来源。
- 首轮集成测试（PR #18）已交付可复用支撑设施：mock-anthropic（剧本化 + 请求录制 + `setRouter`）、pty-driver（forkpty）、sandbox（onboarding/信任/API key 预置 + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 离线）、dist-fixture、stripAnsi。已验证的 REPL/请求事实：提示符 `❯`、ready 信号 `/effort`、print 模式请求录制断言可用、首个用户提示可能附带 haiku 辅助请求（路由解决）。

### 1.2 约束

1. 双形态：dist 形态测普通来源与 hook 触发（CI 必跑）；源码形态（`bun src/entrypoints/cli.tsx` + `USER_TYPE=ant` + `CLAUDE_CODE_MANAGED_SETTINGS_PATH` 指向沙箱）测 managed 注入与 fail-closed。源码形态在 dist 形态下必须以 skip 行呈现原因，禁止静默缩覆盖。
2. 目标断言 + skip 标记：依赖 B0/B1 运行时改造的验收项直接断言对齐目标行为，未实现期间 `test.skip` 并输出 `SKIP [blocked-by-batch:X] <条目 id>`；批次落地后改 fixture 的 `status` 字段点亮 —— 测试即批次验收门。
3. hook 事件矩阵本轮全量：33 个事件逐个 fixture；27 个既有事件真实运行断言，6 个新事件（`UserPromptExpansion`、`PostToolBatch`、`MessageDisplay`、`DirectoryAdded`、`PreModelSwitch`、`PostModelSwitch`）`blocked-by-batch:B1` skip。
4. 安全策略不降级：managed fail-closed 断言按上游证据；证据不足的行为只记录观测不声称对齐。
5. 命名遵守 flash 排除清单；测试证据不记录真实凭据。

2026-11-18 修订：源码形态在本仓库不可运行（USER_TYPE=ant 需要 ant 专属私有模块 REPLTool.js 等，快照中不存在，探针证据 src/tools.ts:16-22）；managed 注入验收条目统一标记 blocked-by-prereq:source-form-missing-ant-modules，待私有模块可用后点亮。

## 2. 设计决策

| 决策 | 机制 | 为什么 | 备选及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 表驱动矩阵 + 断言引擎 | fixtures YAML 表 + 每组一个小引擎生成测试 | 33 事件是数据不是代码；与 B0 机器可读矩阵理念对齐；批次推进 = 改 status 字段 | 每事件一个测试文件：样板泛滥且与矩阵无对照；进程内直测解析函数：不满足总路线"运行时效果"验收定义 | 引擎自身需要设计+单测 | 架构 spec 5.2 节；B0 设计 2 节矩阵理念 |
| 双形态 launcher | dist 与 source 两个 launcher 注入同一引擎 | managed 路径覆盖被 ant 门控，external dist 不可用；同时保住 dist 形态的发布真实性 | 全部源码形态：丢失 dist 链路验证；产品加测试钩子：产品行为变更需独立 spec 与上游论证 | source 形态仅本地，CI 不跑 | `src/utils/settings/managedPath.ts:8-16` |
| 目标断言 + blocked 标记 | fixture 条目 `status: active \| blocked-by-batch:X`，引擎映射 `test.skip` | 测试即批次验收门；skip 行显式输出符合"禁止静默缩覆盖" | 只测当前行为：批次落地时需人工改断言，测试不构成验收门 | 未实现批次期间套件带 skip 运行 | B0 设计 1.2 节上游观测；架构 spec 6 节 skip 行要求 |
| hook 断言用标记文件 | hook 命令写沙箱内标记文件，断言文件存在性 + 内容 JSON 字段 | 离线稳定；stdin schema 可直接断言；不依赖 UI 文案 | 断言 UI 输出文案：脆弱且被 ANSI 干扰 | 需要每个 trigger 一个场景构造器 | 首轮 e2e 已验证 print/PTY 模式离线可控 |
| 来源优先级用请求录制断言 | 多来源同键冲突 → print 一轮 → mock 录制请求中的 model 等字段反映胜出值 | 借用已验证的请求录制手段；比 UI 断言稳定 | 读进程配置快照：拿不到运行时合并结果 | 需选取可观察的键（model） | 首轮 Task 8 已验证请求录制 |

## 3. 套件结构与双形态执行

```text
tests/integration/config-acceptance/
├── fixtures/
│   ├── hooks.yaml           # 33 事件全量矩阵
│   ├── sources.yaml         # 来源优先级组合
│   ├── tolerance.yaml       # 解析容错矩阵
│   ├── env-keys.yaml        # env 键运行时效果
│   └── migration-keys.yaml  # ~/.claude.json 迁移键
├── engine/
│   ├── hook-matrix-engine.ts
│   ├── source-engine.ts
│   └── engine.test.ts       # 引擎单测
├── form/
│   ├── dist-form.ts         # dist 形态 launcher
│   └── source-form.ts       # 源码形态 launcher（USER_TYPE=ant + managed 路径覆盖）
├── hooks-matrix.test.ts
├── sources.test.ts
├── tolerance.test.ts
├── env-keys.test.ts
├── migration-keys.test.ts
└── managed-security.test.ts   # form:source 专属
```

- dist 形态并入现有 `bun run test:integration`（runner 已按目录自动发现，无需改动）。
- 源码形态：`bun scripts/test-integration.ts --suite=config-acceptance --form=source`；runner 增加 `--form` 透传（改动点属本子项目）；无 ant 门控环境下输出 skip 行而非失败。
- 源码形态在 dist 形态运行时以 `SKIP [form:source] <条目 id>` 呈现。

## 4. fixture 设计

### 4.1 hooks.yaml（33 事件）

每事件一条目：

```yaml
- event: PreToolUse
  status: active            # active | blocked-by-batch:B1
  trigger: tool_call        # 场景构造器选择
  matcher: '*'
  input_schema:             # stdin JSON 关键字段断言
    tool_name: string
    tool_input: object
  exit_semantics: block     # block | allow | nonblock
  expected_effect:
    tool_executed: false
    model_sees_denial: true
```

trigger 场景枚举：`tool_call`、`session_start`、`stop`、`user_prompt`、`notification`、`subagent`。

### 4.2 sources.yaml

条目 = 各来源 settings 片段 + 预期胜出值。组合覆盖：user vs project、local vs project、local vs user、flag vs user（dist 形态）；managed vs user、managed vs flag（源码形态，条目标 `form: source`）。断言键选运行时可观察字段（`model`）。

### 4.3 tolerance.yaml

条目 = 输入 settings 文件 + 预期结果：

| 条目类 | 预期 | 状态 |
|---|---|---|
| 未知 hook 事件 | 仅删该 entry，兄弟配置保留 + warning | blocked-by-batch:B0 |
| 已知事件值非数组（如 PostToolUse: 3） | 仅删该 entry | blocked-by-batch:B0 |
| hooks 非对象（`hooks: "invalid"`） | 仅删 hooks 字段 | blocked-by-batch:B0 |
| 普通字段 schema 错误（`model: 42`） | 整来源不生效 | active |
| 未知顶层键 | passthrough 不致命 | active |
| managed 文件损坏 | fail-closed（拒绝，不回退宽松） | form:source |

### 4.4 env-keys.yaml / migration-keys.yaml

- env：选当前有消费者的代表键（实施计划中固定键清单，每个键附消费者代码路径证据）+ 路线点名的无消费者键（如 `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`）作目标断言 + skip 标记。
- 迁移键：`theme`、`autoCompactEnabled`、`verbose` 等（以 `src/tools/ConfigTool/supportedSettings.ts` 点名清单为准），断言从 `~/.claude.json` 读取的行为等价性。

## 5. 断言引擎

```ts
// engine/hook-matrix-engine.ts
loadHookEntries(yamlPath): HookEntry[]     // 解析 + 校验，坏 fixture 抛错
runHookMatrix(entries, launcher): void     // active → 场景断言；blocked → test.skip 行
```

- 引擎形态无关：`launcher` 注入 dist/source 形态执行器。
- trigger 场景构造器（每个 trigger 一个）：构造 sandbox settings（hooks 段）→ 发起对应动作（print 一轮 / PTY 交互）→ 断言标记文件 + mock 请求录制。
- hook 命令统一为沙箱内 shell 脚本写标记文件（stdin JSON 落盘供 schema 断言）。
- 引擎单测（engine.test.ts）：YAML 解析错误呈现、skip 行格式、未知 trigger 报错、失败信息含条目 id。

## 6. 验收标准

1. fixtures 条目 ↔ 生成测试一一对应（引擎单测断言计数：33 hooks + sources + tolerance + env + migration 条目数）。
2. 27 个既有 hook 事件真实运行断言；6 个新事件输出 `SKIP [blocked-by-batch:B1]`；B0 容错条目输出 `SKIP [blocked-by-batch:B0]`；CI 无静默 skip。
3. 双形态本地全跑 exit 0；`--form=source` 在无 ant 门控环境输出 skip 行；managed 条目在两种形态下均以 skip 行呈现。
4. 全套件单轮 ≤ 10 分钟（单事件场景 ≤ 15s）。
5. 不改动产品源码（src/）；runner 仅加 `--form` 透传。
6. CI（dist 形态）并入现有 `test:integration` 门禁。

## 7. 范围边界

- hook 新事件运行时协议属 B1；B0 容错运行时属 B0 批次 —— 本套件只承载验收，不提前实现。
- env 键全量矩阵属 B0 inventory 产物；本轮只锚定代表键与路线点名键。
- Managed/MDM/remote/inline 来源的完整语义（含 remote managed settings）不在本轮，条目级扩展留给对齐批次。
