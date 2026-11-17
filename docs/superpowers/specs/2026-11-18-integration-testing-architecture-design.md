---
id: integration-testing-architecture
title: flash 集成测试总体架构设计
date: 2026-11-18
status: approved
---

# flash 集成测试总体架构设计

本文定义 flash 集成测试的总体架构：套件划分、执行模型、公共支撑设施、CI 职责边界和子项目分解路线。本文是架构层设计；每个子项目落地前必须另有具体 spec，给出用例明细、fixture 设计和验收标准。

## 1. 问题与目标

### 1.1 现状

- `tests/` 下约 40 个单测文件由 `scripts/test.ts` 逐文件顺序执行（Bun test，退出码判定），无集成测试层。
- 发布前依赖 smoke 管道（真实 API、真实 MCP、真实 Chrome、三平台 runner），最近多个提交在修 smoke 稳定性（spawn cap、MCP 超时、Chrome 安装）。smoke 只在发布时跑，日常 PR 没有集成级门禁。
- upstream-configuration-alignment 路线（`docs/superpowers/specs/2026-11-16-upstream-configuration-alignment-design.md`）明确要求"配置路径、类型、默认值、合并优先级和运行时效果都必须有测试"，但目前没有承载这些验收测试的设施。
- 仓库中存在未提交的 `test-pty.ts`、`test-pty2.ts` 草稿和 `fixtures/token-count-*.json` 录制文件，说明 PTY 驱动和录制回放已有局部尝试，但没有形成体系。

### 1.2 目标

1. 建立 hermetic（离线、无凭据、可重复）的集成测试层，覆盖三个范围：CLI 端到端、配置对齐行为验收、Agent SDK 集成。
2. 为 alignment 路线各批次提供统一的验收测试承载。
3. 集成测试进 PR 门禁；与 smoke 共存、职责分离。
4. 用例总量估算 80–120 个，按套件分三个子项目独立推进。

### 1.3 约束

1. 集成测试默认离线：模型响应来自 mock API，不依赖真实凭据；需要真实 API 的用例单独标记 live 层，默认跳过。
2. 命名遵守 flash 排除清单（CLAUDE.md 规则 1）：测试代码中的协议常量、外部标识符按既有清单处理。
3. 测试证据不得记录真实凭据、OAuth token 等敏感内容（对齐 alignment 路线约束 8）。
4. 本架构是工程改造类设计，不登记 `docs/architecture/coverage/manifest.yaml`；但由它承载的配置对齐验收属于 alignment 各批次 spec 的验收部分。

## 2. 设计决策

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 三套件 + 共享支撑设施 | `tests/integration/` 下 cli-e2e、config-acceptance、sdk 三套件，公共设施在 `support/` | mock API、构建产物、PTY 驱动是三套件真正可复用的部分，套件边界与子项目分解天然对齐 | 三套件完全独立：公共设施写三遍；统一场景 DSL：CLI 交互与 SDK 调用差异过大，抽象会泄漏 | support 层需一次前期投入 | 现状 1.1 节第 1、4 条 |
| 独立 runner + 构建产物 | `scripts/test-integration.ts`，跑前按需 `bun run build`，产物三套件复用 | PTY 要驱动真实二进制，SDK 要消费 `dist/sdk.mjs` 真实发布形态；单测 runner 保持现状不混入慢用例 | 合并进 `scripts/test.ts`：顺序 runner 变慢、产物依赖隐式；全进程内加载 src：PTY/dist 链路没有真实验证 | 每次全量跑多一次构建（`--no-build` 可跳） | `scripts/test.ts:31-36` glob；`package.json` bin/export 指向 dist |
| Mock API 为主 | 进程内 Bun.serve mock Anthropic API，剧本化响应，`ANTHROPIC_BASE_URL` 注入 | 离线可重复、可脚本化错误与流式场景、可断言 flash 发出的请求；live 用例单列 | 录制回放为主：新场景都要先录制；真实 API：需凭据、慢、不稳定，不能做 PR 门禁 | mock 与真实 API 可能漂移，需 live 层抽查兜底 | `fixtures/token-count-*.json` 已是录制形态但覆盖场景有限；smoke 需真实 runner 说明真实 API 只适合发布级验证 |
| 与 smoke 共存、职责分离 | 集成测试做 PR 门禁（hermetic），smoke 保留做发布前真实环境验收 | smoke 的场景需要真实 runner（三平台、真实 MCP/Chrome），集成层替代不了；两侧都不删 | 逐步吸收替代 smoke：真实环境验证与离线回归目标不同，吸收会造成职责混乱；集成测试只本地：PR 无门禁，回归滞后 | CI 多一条流水线 | 最近 5 个提交（a6791b7、bff6d54 等）全部在维护 smoke 的真实环境依赖 |
| 单测 runner 排除 integration 目录 | `scripts/test.ts` 的 glob 排除 `tests/integration/` | 集成测试需要产物和 mock 服务，被单测 runner 误跑会必然失败 | 不改 glob，集成文件放仓库外：脱离测试体系难以发现 | 需改动 `scripts/test.ts`（一行级） | `scripts/test.ts:31-36` |

## 3. 执行模型

入口 `scripts/test-integration.ts`，与 `scripts/test.ts` 平行：

```text
bun run test:integration              # 全部 hermetic 套件
bun run test:integration --suite=cli|config|sdk
bun run test:integration --live       # 追加 live 层（默认跳过，输出 skip 行）
bun run test:integration --no-build   # 跳过产物新鲜度校验直接复用
```

- **产物策略**：runner 启动时检查 dist 新鲜度（源码 mtime 对比），陈旧则先执行 `bun run build`；产物作为一次性 fixture 给三套件复用。
- **分层门控**：hermetic 层（默认必跑，无凭据）；live 层（`--live` 显式开启，默认跳过，跳过时输出 skip 原因行，风格与 smoke 一致）。
- **失败处理**：逐文件顺序执行，收集失败清单，最终以退出码判定（与 `scripts/test.ts` 一致，勿只看 tail）。
- 集成测试文件位于 `tests/integration/**/*.test.ts`。

## 4. 公共支撑设施（`tests/integration/support/`）

### 4.1 mock-anthropic（mock Anthropic API 服务）

- Bun.serve 本地 HTTP 服务，实现最小表面：`/v1/messages`（流式 + 非流式）、`/v1/messages/count_tokens`。
- **剧本化响应**：每个用例注册响应剧本（按请求序号返回预设响应），支持工具调用链、多轮对话、错误响应（429/500/overloaded）、流式分块。
- **断言钩子**：记录收到的请求（headers、body），用例可断言 flash 发出的请求内容（system prompt 组装、tool schema 注入、token 计数请求）。
- 注入方式：`ANTHROPIC_BASE_URL` 指向本地端口，API key 用假值；现有 `fixtures/token-count-*.json` 的 token 计数用例最终迁移到该 mock 驱动（属子项目 3）。

### 4.2 dist-fixture（构建产物管理）

- 封装"需要时构建、构建一次复用"：新鲜度检查 → `bun run build` → 暴露 dist 路径。
- CLI 套件取可执行入口；SDK 套件 import `dist/sdk.mjs`（真实发布形态，而非源码直载）。

### 4.3 pty-driver（PTY 会话驱动）

- spawn 真实二进制进 PTY，脚本化 stdin 输入（逐字符/逐行、延时、等待模式）。
- 输出按行/帧收集：等待匹配、超时判定、最终退出码捕获。
- ANSI 清洗层：剥离转义序列后断言，保留原始帧备用。
- 实现参考仓库现有草稿（`test-pty.ts`、`test-pty2.ts`），不直接复用。

### 4.4 settings-sandbox（配置沙箱）

- 临时目录伪 HOME + 伪项目目录，预置各来源 `settings.json`（user/project/local/managed）与 `~/.claude.json`。
- 每用例独立沙箱，测试后清理；managed 来源用受控路径注入。
- 环境变量隔离清单（HOME、CLAUDE_CONFIG_DIR、ANTHROPIC_BASE_URL 等）集中定义，防止用例漏设打到真实配置。

## 5. 套件覆盖清单

### 5.1 套件 1：CLI 端到端（cli-e2e/）

| 用例组 | 覆盖内容 |
|---|---|
| 启动与退出 | 正常启动渲染、`--version`、`--help`、Ctrl+C 退出、退出码 |
| REPL 交互 | 输入提交、斜杠命令分派、未知命令报错、`/exit` |
| 权限流 | Bash 工具权限提示 → 批准/拒绝/always-allow 三条路径及会话影响 |
| 工具执行链 | mock API 下发工具调用 → CLI 执行 Bash/Read/Edit → 结果回传 → 下一轮响应 |
| 会话持久化 | 退出重进 `--resume`，历史恢复 |
| 输出渲染 | 流式输出、markdown 渲染、窄终端自适应 |
| 非交互模式 | `-p` print 模式管道输入输出、退出码语义 |

### 5.2 套件 2：配置对齐行为验收（config-acceptance/）

结构与 alignment 路线批次对齐，每批一个用例文件。

| 用例组 | 覆盖内容 |
|---|---|
| 来源优先级 | managed > flag > local > shared > user 同键冲突的合并结果，含来源追踪 |
| hook 事件矩阵 | 33 个事件逐个：触发时机、matcher、输入 schema、退出码语义（block/allow） |
| settings 解析容错 | 单字段错误只跳过自身不拖垮兄弟字段；未知键 passthrough 诊断 |
| 安全策略 fail-closed | managed permissions、sandbox 配置损坏时的拒绝行为，不允许回退宽松 |
| env 键运行时效果 | 逐键验证有真实消费者（如 `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` 必须真的限制 subagent 数量） |
| `~/.claude.json` 迁移键 | `theme`、`autoCompactEnabled` 等旧位置读取的行为等价性 |
| B0 基线对照 | b0-baseline 计划产出的对照项转为回归用例 |

### 5.3 套件 3：Agent SDK 集成（sdk/）

| 用例组 | 覆盖内容 |
|---|---|
| query 循环 | `query()` 全生命周期：消息流、工具调用授权回调、中断、错误传播 |
| hook 接线 | SDK 侧注册的 hook 在 query 循环中真实触发 |
| MCP 集成 | 进程内 mock MCP server：工具发现、调用、连接断开恢复 |
| 会话管理 | SDK 侧 resume、fork、abort |
| dist 形态 | `import flash from 'flash'`（dist/sdk.mjs）下上述链路仍成立 |
| token 计数 | 现有 token-count fixtures 迁移到 mock API 驱动 |

## 6. CI 职责边界

| 管道 | 触发 | 内容 | 职责 |
|---|---|---|---|
| `bun run test` | 每 PR | 现有单测 | 单元级回归，不动 |
| `bun run test:integration` | 每 PR（hermetic） | 三套件，mock API，无凭据 | 集成级门禁，本设计新增 |
| smoke 管道 | 发布前 | 真实 API/MCP/Chrome、三平台 runner | 发布验收，保留不动 |

- smoke 已覆盖的真实环境场景不重复进 hermetic 层；如需离线等价物，进集成套件，smoke 侧不删。
- live 层不进常规 CI 门禁，需要时手动触发（与 `scripts/live-*-validation.ts` 定位一致）。
- CI 中集成测试必须输出 skip 结果行（哪些用例被跳过、原因），避免静默缩覆盖。

## 7. 子项目分解与落地顺序

| # | 子项目 | 依赖 | 内容 |
|---|---|---|---|
| 0 | 公共支撑设施 | 无 | mock-anthropic、dist-fixture、pty-driver、settings-sandbox、runner 骨架 + `scripts/test.ts` 排除 integration 目录 |
| 1 | CLI 端到端套件 | #0 | PTY 用例组，顺带验证 pty-driver 设计 |
| 2 | 配置对齐验收套件 | #0，与 alignment 批次挂钩 | 来源优先级、hook 矩阵、fail-closed 等 |
| 3 | SDK 集成套件 | #0 | query 循环、MCP、dist 形态、token fixtures 迁移 |

顺序 0 → 1 → 2 → 3。#0 不单独成 spec，并入子项目 1 的 spec：基础设施必须随第一批真实用例验证，避免无用例支撑的设施落地。
