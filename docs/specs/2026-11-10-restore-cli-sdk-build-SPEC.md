---
commit: 9b2a35201244ca84adeaa6844bf799e5a18aff6d
title: "Restore CLI and SDK build"
date: 2026-11-10T11:39:20+08:00
status: implemented
kind: component
---

# Restore CLI and SDK build

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交 4b9d30f7953273e567a18eb819f4eddd45fcc877 是只有 README.md 与 src/ 的根快照，没有 package.json、锁文件、tsconfig、构建脚本、测试目录、CI 或状态/发布文档。其 agentSdkTypes.ts 中 query、tool、createSdkMcpServer、V2 session、session mutations/fork 和 scheduled-task API 多数直接抛出未实现错误；若干部件还引用快照中不存在的类型和模块。大量 TS/TSX 保留转换后的 compiler 代码形态，LSP 的 restartOnCrash 与 shutdownTimeout 配置也会显式拒绝使用。

需要把研究源码镜像恢复成能够类型检查、构建和验证的 CLI 与 Agent SDK，而不是只增加一个表面可用的打包命令。恢复工作同时包含：从可用 embedded source maps 还原原始 TypeScript/TSX，补齐依赖和公共 SDK 类型，接通 headless CLI、query/tool/MCP 权限链，提供同进程 SDK、V2 多轮会话、portable JSONL session 操作和 scheduled tasks，并用 external-build 边界隔离内部能力。规模上这是一次 789 文件组合恢复，不能把 616 个修改文件都解释成独立新功能，也不能用 build success 覆盖仍然缺失或协议受阻的产品能力。

## 目标与非目标

### 目标

- 建立固定依赖的 Bun/TypeScript 流程，依次支持 SDK 类型生成、typecheck、离线测试、CLI/SDK bundle 和 declaration emit。
- 恢复可维护的原始 TS/TSX 与缺失类型模块，同时保留现有 QueryEngine、工具、权限、MCP 和 Ink 模块边界。
- 实现并验证 external CLI headless 路径、SDK query/async input/abort、in-process MCP、V2 create/resume/prompt、session list/read/rename/tag/fork；实现 scheduled-task watch/fire/missed 接口，并仅验证 missed-task 格式化、初始 missed 事件及 abort/iterator.return 清理路径。
- 提供清晰的包出口、CI smoke、架构说明、分项验证状态和发布范围，使已实现、未验证、未实现、禁用与协议受阻不再混为一谈。
- 保留父提交基线历史，并以离线回归测试覆盖工具池、MCP、session、cron 和 LSP 配置的关键行为。

### 非目标

- 不恢复或验证完整 USER_TYPE=ant 产品，也不宣称 KAIROS、proactive、workflow、computer-use 等内部能力在 external build 可用。
- 不实现 connectRemoteControl、env-less perpetual bridge、Cloud xattr 等需要权威协议或 daemon/bridge 环境的能力。
- 不完成 Linux libsecret、npm marketplace、ultraplan OAuth refresh、SDK rewind、non-REPL stop hooks 和全部 SDK control methods。
- 不把 disabled stub、显式 unsupported error 或成功 bundle 伪装成相应功能已经通过端到端验收。
- 不在本提交中完成远端仓库创建、push、GitHub Actions 验证或最终 release metadata 回写。
- 不承诺 bit-for-bit reproducible artifact；MACRO.BUILD_TIME 仍取构建时当前时间，目标是流程可重复而非输出哈希恒定。

## 方案架构与数据流

构建链路以 package.json 为产品和脚本契约，bun.lock 固定依赖，tsconfig.json 启用 strict、bundler resolution 和 declaration/declarationMap。scripts/build.ts 先调用 generateSdkTypes()，再以 Bun target、ESM、features: [] 分别构建 src/entrypoints/cli.tsx 到 dist/main.js 与 src/entrypoints/agentSdkTypes.ts 到 dist/sdk.mjs；CLI 加 Bun shebang 并设置为可执行。构建注入 MACRO.*、USER_TYPE=external 和 CLAUDE_CODE_VERIFY_PLAN=false，随后 package.json 的 build 脚本调用 tsc --emitDeclarationOnly 输出 dist/types。根 export 同时指向 sdk.mjs 与 agentSdkTypes.d.ts，./cli 和 bin 指向 main.js。

scripts/generate-sdk-types.ts 扫描 coreSchemas.ts 与 controlSchemas.ts 中 exported Zod schema，生成 z.infer<ReturnType<typeof schemas.XSchema>> 形式的 coreTypes.generated.ts 和 controlTypes.ts；提交内记录为 125 个 core types 与 59 个 control types。src/runtimeMacros.ts 为直接 source execution 和测试提供 MACRO 默认值，使模块 import 不必先经过 bundle。tsconfig 的 paths 将私有 @ant/* 模块映射到 src/external-stubs/，配合 features: [] 和 dead-code elimination 形成 external 编译边界，但该边界不是运行时 sandbox。

源码恢复与功能接通是两条相互依赖的线。616 个修改文件中，395 个可明确识别为移除父版 react/compiler-runtime 转换痕迹，552 个文件字节数缩小超过一半；这些只是批量恢复的可观察子集。components、commands、hooks、ink、screens、tools、services 与 utils 恢复原模块结构后，CLI 由 cli.tsx 处理 version fast path；help 与其他完整路径继续动态加载 main.tsx，再进入 Commander、交互 Ink 或 headless 执行；核心仍沿 QueryEngine、query.ts、assembleToolPool 和权限上下文传递消息与工具结果。

SDK 不 spawn CLI，也不启动 Ink。src/utils/sdkQuery.ts 初始化 cwd、bootstrap/AppState、权限上下文、commands、MCP clients/tools/resources 和内建工具池，把字符串 prompt 或 UserMessageChannel 的异步输入送入 QueryEngine.ask()。canUseTool 优先走 SDK callback，否则进入 hasPermissionsToUseTool()；in-process MCP 通过 InMemoryTransport.createLinkedPair() 连接 Client 与 McpServer，process MCP 复用 services/mcp/client.ts 的 getMcpToolsCommandsAndResources() 连接与发现逻辑；SDK 不挂载 React 的 MCPConnectionManager。输出消息直接 yield 给 host，finally 清理 MCP、cleanup registry 并 flush session storage，不主动结束宿主进程。

V2 由 src/utils/sdkSessionConversation.ts 的 LocalSdkSession 保留底层 query 与 input channel：每次 stream() 在 result message 结束，但底层会话继续服务下一 turn。src/utils/sdkSessions.ts 直接处理配置目录 projects/ 下的 JSONL，按 parentUuid 重建主链；rename/tag 追加 metadata，fork 生成新 session ID、重写全部 UUID 和父子链并保留 content-replacement，但不复制 file-history/undo snapshots。scheduled tasks 复用 file-backed cronScheduler 和锁，cronNotification 独立格式化 missed events；LSP 恢复 restart 与 shutdown timeout 行为，但新增测试只覆盖配置接受和 stopped 状态下 stop() 可安全返回。

验证与发布信息被拆成三种职责：README 说明 Build and Verification、Agent SDK 和 external 边界；docs/ARCHITECTURE.md 描述入口与数据流；docs/STATUS.md 保存命令结果和 capability matrix；docs/RELEASE.md 记录保留 baseline 的发布范围及尚未 push/未跑 hosted Actions 的状态。CI 只串行执行 frozen install、generate、typecheck、offline test、build、CLI version/help 和 SDK import smoke，真实模型检查留在 STATUS 的单独记录中。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `package.json` | 定义 1.0.0 包、Bun scripts、依赖以及 CLI/bin、SDK import 和 declaration exports。 |
| 变更 | `bun.lock` | 固定恢复后的依赖解析，使 CI 与本地 frozen install 有共同输入。 |
| 变更 | `bunfig.toml` | 设置测试 timeout/bail、开发依赖安装和 react/compiler-runtime 解析。 |
| 变更 | `tsconfig.json` | 启用 strict、bundler resolution、declarations，并把私有 @ant/* import 映射到 external stubs。 |
| 变更 | `.gitignore` | 排除依赖、dist、日志、环境文件、密钥和常见凭据产物，降低恢复后误提交风险。 |
| 变更 | `.github/workflows/ci.yml` | 以 Bun 1.3.14 串行执行 frozen install、generate、typecheck、test、build 和 CLI/SDK smoke。 |
| 变更 | `README.md` | 改为构建验证、Agent SDK 和 external 边界说明，并修正核心文件行数尺度。 |
| 变更 | `docs/ARCHITECTURE.md` | 记录双产品入口、QueryEngine 数据流、SDK 组合、安全持久化和功能边界。 |
| 变更 | `docs/STATUS.md` | 保存命令结果、真实模型检查和 Verified/unverified/missing/disabled/protocol-blocked 能力矩阵。 |
| 变更 | `docs/RELEASE.md` | 记录 source baseline、源码恢复范围、发布前验证、保留历史决策和尚未 push/CI 的状态。 |
| 变更 | `scripts/build.ts` | 先生成 SDK 类型，再以 external defines 构建 main.js/sdk.mjs，并设置 CLI 可执行权限。 |
| 变更 | `scripts/generate-sdk-types.ts` | 从 core/control Zod schemas 生成 z.infer 类型文件，是声明链路的生成源。 |
| 变更 | `src/runtimeMacros.ts` | 为直接源码执行与测试提供 MACRO 默认值，解除对预先 bundle 的 import 依赖。 |
| 变更 | `src/env.d.ts` | 补充 Bun、资源和环境相关 ambient 类型，使恢复源码进入统一 TypeScript 契约。 |
| 变更 | `src/global.d.ts` | 声明全局构建宏等类型，与 runtimeMacros 和 build defines 配合。 |
| 变更 | `src/main.tsx` | 恢复完整 Commander、交互和 headless 主链的原始 TypeScript/TSX 形态。 |
| 变更 | `src/query.ts` | 修复共享模型流和工具编排边界，供 CLI 与同进程 SDK 复用。 |
| 变更 | `src/tools.ts` | 恢复内建工具池组合并补齐工具集合，支撑 tool-pool smoke 和 SDK/CLI 调用。 |
| 变更 | `src/replLauncher.tsx` | 恢复交互 REPL 启动适配，保持 SDK 不加载 Ink 的边界。 |
| 变更 | `src/dialogLaunchers.tsx` | 恢复终端对话框启动辅助，与交互组件源码同步。 |
| 变更 | `src/interactiveHelpers.tsx` | 恢复交互模式公共辅助实现，配合 main 与 REPL 的原始源码。 |
| 变更 | `src/entrypoints/cli.tsx` | 提供 version fast path，并将 help 及其他完整 CLI 路径动态加载到 main.tsx，是 dist/main.js 的源入口。 |
| 变更 | `src/entrypoints/agentSdkTypes.ts` | 把父快照中抛错的 SDK 入口接到 query、MCP、V2、sessions 和 cron 实现，同时保留未支持边界。 |
| 变更 | `src/entrypoints/sdk/coreSchemas.ts` | 作为核心可序列化 SDK 类型的 Zod source of truth。 |
| 变更 | `src/entrypoints/sdk/controlSchemas.ts` | 定义 SDK control 消息的 schema，并驱动 controlTypes 生成。 |
| 变更 | `src/entrypoints/sdk/coreTypes.generated.ts` | 由 coreSchemas 生成的核心类型文件，补齐父快照缺失的公共 import。 |
| 变更 | `src/entrypoints/sdk/controlTypes.ts` | 由 controlSchemas 生成并 re-export core types，修复 SDK/bridge 类型缺口。 |
| 变更 | `src/utils/sdkQuery.ts` | 实现同进程 SDK 初始化、异步输入、权限、MCP、模型控制、消息 yield 与资源清理。 |
| 变更 | `src/utils/sdkSessionConversation.ts` | 实现 V2 多轮会话，让每 turn 在 result 结束而底层 query 保持可用。 |
| 变更 | `src/utils/sdkSessions.ts` | 实现 portable JSONL list/read/rename/tag/fork 和 fresh UUID parent chain。 |
| 变更 | `src/utils/cronScheduler.ts` | 恢复文件型计划任务调度、锁和 missed/fire 事件，供 SDK watch 接口复用。 |
| 变更 | `src/utils/cronNotification.ts` | 独立实现 missed-task 格式化、用户确认提示与动态 fence 防护。 |
| 变更 | `src/services/mcp/client.ts` | 恢复 MCP 工具、命令和资源发现，供 process 与 SDK 工具池组合复用。 |
| 变更 | `src/services/mcp/MCPConnectionManager.tsx` | 恢复 MCPConnectionManager React context 的原始 TSX；SDK process MCP 直接使用 services/mcp/client.ts，本文件没有 SDK cleanup 适配。 |
| 变更 | `tests/toolPool.test.ts` | 添加两个工具池回归测试，检查无 null、唯一名称和核心工具集合。 |
| 变更 | `tests/sdkMcp.test.ts` | 添加 in-process MCP metadata 与 invocation 测试。 |
| 变更 | `tests/sdkSessions.test.ts` | 添加离线 JSONL session mutations、pagination 和 fork UUID 链测试。 |
| 变更 | `tests/sdkCron.test.ts` | 添加 missed-task 动态 fence、事件格式和 abort 测试。 |
| 变更 | `tests/lsp.test.ts` | 添加 LSP lifecycle options 接受和 stopped 状态下 stop() 安全返回测试，不覆盖真实崩溃重启或运行中进程清理。 |

### 大型快照分组核对

- 恢复 assistant chooser、gate、discovery 和入口，形成会话选择辅助边界。：`src/assistant/`，4 个文件。
- 调整共享 bootstrap/AppState，使 CLI 与 SDK 初始化能够复用。：`src/bootstrap/`，1 个文件。
- 加入 peer session 与 webhook 清理辅助；bridge 产品协议并未因此全部恢复。：`src/bridge/`，2 个文件。
- 恢复 companion observer 与通知/UI 适配，属于附加交互功能。：`src/buddy/`，3 个文件。
- 恢复 headless、后台任务、transports、structured IO、rollback 和 CLI handlers。：`src/cli/`，11 个文件。
- 批量恢复 slash commands 原始 TS/TSX，并加入 buddy、fork 等命令适配。：`src/commands/`，87 个文件。
- 最大的 UI 源码恢复组，还原终端组件并适配消息、权限、设置和输入行为。：`src/components/`，370 个文件。
- 恢复共享常量与产品配置，配合 external 构建和入口行为。：`src/constants/`，3 个文件。
- 恢复项目上下文构造与系统提示辅助，保持查询输入契约。：`src/context/`，9 个文件。
- 恢复协调者模式边界；该源码存在不代表 internal coordinator 已在 external 验证。：`src/coordinator/`，1 个文件。
- 恢复 daemon 相关适配并保留远程协议限制，不等同于 connectRemoteControl 完成。：`src/daemon/`，2 个文件。
- CLI/SDK 入口、Zod schemas、生成类型和公共工具类型组，是构建与 API 恢复核心。：`src/entrypoints/`，10 个文件。
- 恢复环境 runner 适配，保持特定运行环境的独立边界。：`src/environment-runner/`，1 个文件。
- 为私有 computer-use、Chrome 等 @ant/* 模块提供明确 external 编译替代边界。：`src/external-stubs/`，7 个文件。
- 批量恢复 React/session/tool hooks，并适配共享状态和权限流程。：`src/hooks/`，32 个文件。
- 恢复 Ink 渲染、事件和布局支撑，与 components/screens 的原始源码匹配。：`src/ink/`，21 个文件。
- 恢复 job 支撑模块，为后台工作提供独立抽象。：`src/jobs/`，1 个文件。
- 恢复键位配置和输入映射，配合终端 UI 源码。：`src/keybindings/`，3 个文件。
- 恢复记忆目录辅助实现，保持项目上下文持久化边界。：`src/memdir/`，1 个文件。
- 恢复独立附加功能模块，保留原目录隔离。：`src/moreright/`，1 个文件。
- 恢复原生能力 TypeScript 适配，不扩大平台验证结论。：`src/native-ts/`，1 个文件。
- 恢复 proactive 模块的 external/disabled 边界，不声明内部能力启用。：`src/proactive/`，2 个文件。
- 恢复核心查询辅助模块，配合 query.ts 的模型与工具循环。：`src/query/`，1 个文件。
- 恢复远程会话辅助代码，但 remote-control 协议仍属于受阻范围。：`src/remote/`，1 个文件。
- 恢复 REPL 等屏幕级大型 TSX 源码，是批量原始 UI 还原的重要组成。：`src/screens/`，3 个文件。
- 恢复 self-hosted runner 边界，不据此声明 hosted 环境验证。：`src/self-hosted-runner/`，1 个文件。
- 恢复 server 与传输适配，包含 SDK/CLI 所需服务端支撑。：`src/server/`，8 个文件。
- 恢复 API、MCP、LSP、OAuth、compact 等服务并修复生命周期接口。：`src/services/`，36 个文件。
- 恢复技能加载和 bundled skill 适配，继续复用命令注册体系。：`src/skills/`，5 个文件。
- 恢复 SSH 相关传输辅助，保留其环境依赖。：`src/ssh/`，2 个文件。
- 恢复共享状态辅助，配合 bootstrap 与 SDK/CLI 初始化。：`src/state/`，1 个文件。
- 恢复后台任务类型与实现，配合 CLI/SDK 任务支撑。：`src/tasks/`，6 个文件。
- 恢复内建工具原始源码和缺失实现，支撑统一 tool pool。：`src/tools/`，52 个文件。
- 恢复通用传输接口，与 CLI、SDK 和远程适配解耦。：`src/transport/`，2 个文件。
- 补齐 message、tools、SDK 等共享类型，修复父快照核心导入缺口。：`src/types/`，9 个文件。
- 恢复通用支撑并新增 SDK query/session/cron 等关键实现，是功能恢复最大核心组之一。：`src/utils/`，63 个文件。

## 关键决策与工程取舍

- 发布文档明确选择保留 4b9d30f 基线历史，不创建 orphan branch、不重写 baseline，使恢复 diff 与父快照可以直接核对。
- 构建固定 USER_TYPE=external 与 features: []，私有模块采用显式 stub 或裁剪；对未恢复能力保留 unavailable/unsupported，而非返回伪成功。
- SDK 同进程复用 QueryEngine、AppState、工具、权限和 MCP 管理，而非复制 agent loop 或嵌入终端 UI，从而支持 async input、callback、流式消息与长会话。
- 以 Zod schemas 作为 serializable SDK types 的 source of truth，并提交生成结果供源码 import、IDE 和 declaration emit 使用；build 每次重新生成以减少漂移。
- portable sessions 直接操作 JSONL，避免依赖交互 CLI 的全局 session 状态；V2 把单 turn 的流结束与底层 query 生命周期分离。
- 状态文档把 Verified、Implemented/unverified、Not implemented、Explicitly disabled 和 Blocked on protocol 分开，并明确 build success 不能自动提升功能状态。
- README 同时修正父版把 QueryEngine.ts、Tool.ts、commands.ts 字节量级写成行数的描述，采用约 1.3K、800、750 行的实测尺度。

### 备选方案与回溯分析

- 回溯性工程分析：SDK 可以 spawn headless CLI 以获得更强进程隔离，但 async control、in-process MCP、cleanup 和 V2 长会话会更复杂；同进程方案的代价是共享全局状态与环境变量。
- 回溯性工程分析：手写 SDK declarations 可去掉生成器，却容易与 Zod schemas 漂移；当前轻量文本扫描方案要求 schema 保持 export const ...Schema 的匹配格式。
- 回溯性工程分析：一次恢复全部 internal/ant 功能可能追求表面 feature parity，但会引入私有依赖和未知协议；external-first 更容易验证，却不能证明内部路径兼容。
- 回溯性工程分析：让 unsupported API 返回空成功可暂时减少调用方错误，但会破坏 API 语义并掩盖缺口；显式失败更适合作为恢复边界。
- 回溯性工程分析：只用最小 smoke 而不恢复离线测试会降低变更成本，但无法覆盖 JSONL UUID 链、cron fence/abort 和 in-process MCP 等容易回归的细节。
- 回溯性工程分析：BUILD_OUTDIR 可进一步同时约束 declaration 输出；当前只改 Bun JS 输出目录而 build:types 固定写 dist/types，属于保留的构建接口限制。

## 安全与协议边界

- external define、空 features 和 external stubs 收缩公开构建功能面，但不是文件系统、进程或网络安全沙箱，也不能证明被排除的内部实现安全。
- .gitignore 排除环境文件、key/PEM、credentials.json、service-account.json、依赖、构建产物和日志，但未覆盖 plainTextStorage 实际写入的 .credentials.json；防误提交覆盖因此不完整，也不等同于 secret scan 或仓库无敏感信息的独立审计。
- 真实模型检查的文档记录使用 session configured provider 与 isolated HOME，且不在仓库存放凭据；本文不披露任何凭据，也不把该声明扩展为 USER_TYPE=ant 验证。
- macOS 使用 Keychain 并保留 plaintext fallback，其他平台当前依赖 fallback，Linux libsecret 仍未实现；凭据静态保护因此是明确剩余风险。
- SDK 的 options.env 会增删 process.env，核心还使用 bootstrap 全局状态；同进程并发、多租户或不同配置 query 的隔离不能仅凭 portable session 文件得到保证。
- session 目录和文件采用 0700/0600 创建模式并校验 session UUID；fork 不复制 undo history。secret-bearing JSON 仍不得写日志或放入命令行参数。
- missed-task prompt 要求先询问用户确认，并使用长于内容中任意 backtick run 的动态 fence，降低持久任务内容逃逸为即时指令的风险。
- allowDangerouslySkipPermissions 是调用方显式承担的高权限选项；canUseTool 与权限系统的存在不意味着所有工具调用默认安全。

## 验收标准

- 构建验收应同时得到 dist/main.js、dist/sdk.mjs 和 dist/types/entrypoints/agentSdkTypes.d.ts，并确认 bin、根 import/types export 与 ./cli 映射一致。
- 生成验收应核对 coreSchemas/controlSchemas 到生成类型的来源关系；提交内记录的通过结果为 125 core types、59 control types、typecheck 零错误。
- 测试验收应区分 5 个新增测试文件、7 个 test() 与 STATUS 记录的 7 tests/38 assertions passed，不能把测试文件存在本身写成执行证据。
- CLI 验收记录包括 version/help 和真实 model + Read round trip；SDK 验收记录包括 source/packaged query、in-process MCP、V2 multi-turn/resume、abort cleanup 与 scheduled-task formatting/abort。
- 工具池测试应证明无 null、名称唯一和核心 Agent/Bash/Read/Edit/Write/Glob/Grep 存在；23 个工具的数量来自 STATUS 的另行 smoke，不是该测试自身断言。
- LSP 验收只能声称 lifecycle options 被接受及 stopped 状态下 stop() 可安全返回，不能扩大为真实 crash/restart、shutdown-timeout kill 或运行中进程清理已测试。
- 能力验收必须保留 rewind、remote control、SDK controls、Linux secret storage、marketplace、Cloud xattr 和 internal features 的未完成或禁用状态。
- 发布验收在此 revision 只能确认 CI workflow 和发布文档已加入；不得声称 repository creation、push 或 GitHub Actions 已通过。

## 实现状态与剩余范围

- 状态：**implemented**
- changed-file offset/limit 已转发到 FileReadTool，但 STATUS 标为 Implemented/unverified，仍缺专门回归测试。
- SDK rewind、non-REPL prompt/agent stop hooks、getContextUsage、reloadPlugins、stopTask、applyFlagSettings、getSettings 等仍未实现或明确 unsupported。
- connectRemoteControl、Cloud xattr 和 env-less perpetual bridge 分别等待 daemon/duplex、属性编码及 bridge-pointer/JWT 生命周期等权威协议。
- Linux libsecret、npm marketplace source 和 ultraplan OAuth refresh 尚未完成；Linux 当前直接使用 plaintext credential storage，且 .credentials.json 未被 at-commit .gitignore 覆盖，仍是安全缺口。
- LSP 测试没有真实 crash/timeout 生命周期覆盖，大量恢复 UI 也只能由 typecheck/build 提供有限证据，不能视为完整交互回归。
- SDK 同进程全局 state 与 process.env 修改带来并发和配置隔离风险，需要在多 query 场景另行设计和验证。
- 发布仍处于 preparing 状态，push、hosted Actions 与最终 release metadata 未完成；本记录没有独立重跑 at-commit 命令。
