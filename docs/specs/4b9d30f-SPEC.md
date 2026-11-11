---
commit: 4b9d30f7953273e567a18eb819f4eddd45fcc877
title: "asdf"
date: 2026-03-31T03:34:03-07:00
status: partial
kind: component
---

# asdf

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

该提交没有父提交，是仓库可见历史的根节点。提交正文只说明应要求把当时仓库状态压缩为一个 baseline commit，并保留 README reframing 与 repository contents；它同时承认这是对已发布历史的刻意重写。因此，本文能够确认的“之前状态”仅限于此前存在多提交历史，不能从空树 diff 反推旧版本的文件变化、实现先后或原始设计讨论。

问题有两个层次：形式上要把当时内容保存成单提交基线；实质上得到的是一份只有 README.md 与 src/ 的研究源码镜像，而不是可直接重建的产品仓库。根快照包含查询、工具、终端 UI、MCP、权限和远程桥接等大量实现，却缺少依赖清单、锁文件、TypeScript/构建配置与常规测试，并存在可静态确认的核心导入缺口。文档必须同时忠实呈现架构价值和不可运行、不可追溯的边界，不能把 513517 行对空树的插入量误写成一次开发新增量。

## 目标与非目标

### 目标

- 按提交正文明示的约束，把当时 repository contents 与重新定位的 README 保存到一个无父提交的 baseline。
- 保留 CLI、Agent SDK、查询循环、工具权限、Ink UI、服务与远程适配代码，使后续审阅能够重建模块关系。
- 用精确的 Git 文件清单描述快照规模，并把代码可证事实、README 声明和提交正文自述分开。
- 明确标出构建、测试、缺失模块和 fresh-clone 验证缺口，为后续恢复工作提供可核对的起点。

### 非目标

- 不重建或虚构被压缩历史中的逐提交意图，也不把根快照中的全部文件称为本提交新写代码。
- 不把 README 所述 source map 暴露事件、归属或外部研究背景当作已经独立核验的事实。
- 不承诺该树可以独立安装、类型检查、构建或运行，也不把静态存在权限代码等同于安全审计通过。
- 不在本提交层面补写后续恢复提交才加入的依赖、测试、CI、发布状态或外部功能边界。

## 方案架构与数据流

启动链路由 src/main.tsx 的 Commander CLI 组织，src/setup.ts、src/bootstrap/、src/entrypoints/ 与 src/cli/ 分担初始化、认证、配置、传输和不同执行入口。交互 REPL 直接调用 query()，headless 路径通过 src/cli/print.ts 的 QueryEngine.ask() 复用查询核心，remote/bridge 适配本地会话。src/entrypoints/agentSdkTypes.ts 共享 SDK 类型与协议契约，但其 query、V2、session 管理和 connectRemoteControl 等公共函数均显式未实现，不能描述为已接通 QueryEngine/query 的可用 SDK 入口。启动早期还会并行发起 MDM 读取与 Keychain 预取，这些属于代码中可观察的加载安排，不代表本快照已验证各平台成功运行。

会话核心以 src/QueryEngine.ts 的 submitMessage() 接收输入并维护消息、usage、权限拒绝和文件历史；src/query.ts 与 src/query/ 中的 async generator 循环构造模型请求、流式转发 assistant/system 消息、收集 tool_use、执行工具并把 tool result 回填到下一轮。压缩、token budget、模型 fallback、停止条件、abort 和 max_turns 都围绕这一循环协作，数据主线是“用户输入—模型流—工具调用—结果回填—后续 turn”。

src/Tool.ts 用 inputSchema、validateInput、checkPermissions、call、isReadOnly 与 isConcurrencySafe 统一工具契约；src/tools.ts 和 src/tools/ 提供内建工具并应用 deny rules、权限模式及功能开关，再与 MCP/plugin 工具组合。src/commands.ts、src/commands/、src/skills/ 与 src/plugins/ 以类似注册方式组织 slash commands 和扩展，并区分 availability、remote-safe 与 bridge-safe。src/Task.ts、src/tasks.ts 和 src/tasks/ 则把本地 shell、本地/远程 agent 等长生命周期工作从单次工具调用中分离。

UI 不是查询核心的替代品：src/components/、src/ink/、src/screens/ 与若干 launcher 负责终端渲染、输入和权限确认，核心查询仍由 QueryEngine/query 驱动。服务层的 src/services/ 涵盖 API、OAuth、MCP、compaction、analytics 与 LSP；src/bridge/、src/remote/ 和 src/server/ 将 WebSocket、会话订阅、远程权限回调及 trusted device 等协议适配到本地会话。src/coordinator/ 提供协调者模式门控、提示和 worker 工具约束；AgentTool 等 agent 相关工具可再次进入 query()，并使用独立工具池、权限上下文、abort 和清理过程。

横切能力集中在 src/hooks/ 与 src/utils/：权限判定、设置、沙箱、secure storage、模型、插件和任务支撑被多个入口复用。代码还通过 bun:bundle 的 feature(...) 与条件 require、动态 import 控制功能裁剪和重模块加载；然而该树没有相应构建配置，所以只能说明源码预设了这些边界，不能证明裁剪产物或 external/internal 行为已在此提交验收。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `README.md` | 保留研究快照定位、仓库规模和关键文件说明；其中外部事件声明与行数误差需要单独辨析。 |
| 变更 | `src/main.tsx` | Commander 主入口，连接启动预取、完整 CLI、交互与headless执行路径。 |
| 变更 | `src/setup.ts` | 承载启动期环境与初始化辅助逻辑，是入口与底层状态之间的支撑文件。 |
| 变更 | `src/QueryEngine.ts` | 维护会话消息、usage、权限拒绝和文件历史，并提供 submitMessage() 会话入口。 |
| 变更 | `src/query.ts` | 实现模型流、工具调用、结果回填、压缩、fallback 与终止条件的核心异步循环。 |
| 变更 | `src/Tool.ts` | 定义工具输入、校验、权限、调用、只读和并发安全的统一契约。 |
| 变更 | `src/Task.ts` | 抽象长生命周期任务及其状态，与一次性 Tool 调用区分。 |
| 变更 | `src/context.ts` | 提供查询和工具执行所需上下文入口，连接状态、权限与服务。 |
| 变更 | `src/tools.ts` | 汇总内建工具并应用 deny rules、权限模式和功能开关，也暴露缺失工具模块的导入缺口。 |
| 变更 | `src/commands.ts` | 注册内建命令、skills 与 plugin commands，并标记远程和 bridge 可用性。 |
| 变更 | `src/replLauncher.tsx` | 把完整初始化后的交互会话接入 REPL 与终端渲染。 |
| 变更 | `src/ink.ts` | 作为 Ink 渲染支撑入口，连接自定义终端组件与应用 UI。 |
| 变更 | `src/dialogLaunchers.tsx` | 集中交互对话框启动逻辑，供命令和权限流程复用。 |
| 变更 | `src/interactiveHelpers.tsx` | 提供交互模式公共辅助逻辑，避免入口与屏幕重复处理。 |
| 变更 | `src/projectOnboardingState.ts` | 保存项目 onboarding 状态，支撑首次交互流程。 |
| 变更 | `src/tasks.ts` | 提供任务注册与访问入口，连接查询工具和后端任务实现。 |
| 变更 | `src/cost-tracker.ts` | 跟踪模型使用成本，为会话状态和展示提供计量数据。 |
| 变更 | `src/costHook.ts` | 把成本变化接入响应式 UI 生命周期。 |
| 变更 | `src/history.ts` | 处理输入或会话历史辅助逻辑，与查询消息存储相区分。 |
| 复用 | `src/hooks/useCanUseTool.tsx` | 权限确认 UI 与工具权限上下文之间的复用点，供交互查询流程调用。 |
| 复用 | `src/services/mcp/client.ts` | MCP 工具发现与连接管理的复用位置，向内建工具池提供外部工具。 |
| 证据 | `src/bridge/jwtUtils.ts` | 用于确认无签名 JWT decode 的有限用途及其信任边界。 |

### 大型快照分组核对

- 启动状态文件，承载大型 AppState/bootstrap 状态组合。：`src/bootstrap/`，1 个文件。
- CLI、初始化和 SDK 入口组，包含当时仍显式未实现的 SDK API 边界。：`src/entrypoints/`，8 个文件。
- headless输出、结构化 IO、handlers 与 transports 的 CLI 支撑组。：`src/cli/`，19 个文件。
- 配置和状态迁移组，为既有安装保留升级路径。：`src/migrations/`，11 个文件。
- 共享 schema 定义，为解析和数据校验提供契约。：`src/schemas/`，1 个文件。
- 核心 queryLoop 的拆分辅助模块，围绕模型流和工具结果续轮协作。：`src/query/`，4 个文件。
- 上下文构造与项目环境信息组，为系统提示和工具执行提供输入。：`src/context/`，9 个文件。
- 共享状态定义与更新辅助组，连接核心会话和 UI。：`src/state/`，6 个文件。
- 公共类型契约组；快照中部分被引用的基础类型文件并不在树内。：`src/types/`，11 个文件。
- 文件、shell、搜索、agent、Web 等内建工具及各自权限和输出实现。：`src/tools/`，184 个文件。
- 交互 slash commands 的完整目录快照，覆盖配置、会话、IDE 和扩展命令。：`src/commands/`，207 个文件。
- 技能发现、bundled skills 与加载支撑，供命令和代理上下文复用。：`src/skills/`，20 个文件。
- 插件公共入口与装配辅助，区别于 utils 下的插件管理实现。：`src/plugins/`，2 个文件。
- React hooks、工具权限交互和会话副作用组，连接核心状态与终端 UI。：`src/hooks/`，104 个文件。
- 权限、设置、沙箱、存储、模型、插件、任务等横切支撑的最大目录组。：`src/utils/`，564 个文件。
- 消息、输入、权限、设置等 React 终端组件，负责展示而非替代查询核心。：`src/components/`，389 个文件。
- 自定义 Ink 渲染、布局、事件和 termio 基础设施。：`src/ink/`，96 个文件。
- REPL 等屏幕级组合，把 hooks、组件和会话状态连接起来。：`src/screens/`，3 个文件。
- API、OAuth、MCP、compaction、analytics、LSP 等外部与领域服务。：`src/services/`，130 个文件。
- 本地会话与远程 bridge 的会话运行、token、设备和权限回调适配。：`src/bridge/`，31 个文件。
- 远程会话管理与 WebSocket 控制路径的支撑模块。：`src/remote/`，4 个文件。
- 本地 server 侧协议与连接支撑，和 CLI 传输层协同。：`src/server/`，3 个文件。
- 语音能力入口，属于独立可选功能模块。：`src/voice/`，1 个文件。
- 协调者模式提示与 worker 约束，受功能开关控制。：`src/coordinator/`，1 个文件。
- 本地 shell、本地/远程 agent、teammate 等后台任务实现及输出管理。：`src/tasks/`，12 个文件。
- assistant 会话历史辅助模块，支撑相关选择或恢复流程。：`src/assistant/`，1 个文件。
- companion/buddy 的 UI 与通知逻辑，属于附加交互能力。：`src/buddy/`，6 个文件。
- external build 的 useMoreRight stub；真实 hook 为 internal-only，本文件不是可用的附加功能实现。：`src/moreright/`，1 个文件。
- 模型、产品、路径和提示等共享常量，避免各入口散落字面值。：`src/constants/`，21 个文件。
- 键位解析、配置和终端输入映射，为交互组件提供统一行为。：`src/keybindings/`，14 个文件。
- 记忆目录与相关持久化辅助，支撑项目上下文。：`src/memdir/`，8 个文件。
- 原生能力的 TypeScript 适配层，与平台运行时边界相连。：`src/native-ts/`，4 个文件。
- 输出样式定义入口，供终端展示配置复用。：`src/outputStyles/`，1 个文件。
- 上游代理适配模块，与网络和 API 配置协同。：`src/upstreamproxy/`，2 个文件。
- Vim 编辑模式状态和按键处理，为输入组件提供可选交互方式。：`src/vim/`，5 个文件。

## 关键决策与工程取舍

- 从提交正文可确认的决策是服从单根提交与保留当前内容的要求；不保留可见父历史意味着获得简洁基线的同时放弃逐文件演进证据。baseline 虽已写入，但状态保持 partial：该树缺少依赖、构建与测试配置，存在核心导入和显式 SDK 实现缺口，尚不是可构建、可测试的产品基线，恢复工作属于后续提交。
- 从代码结构归纳的决策是让 QueryEngine/query 成为 CLI 与远程路径共享的会话核心，工具、命令、任务和 UI 通过明确模块边界接入，而非复制代理循环；SDK 文件在该 revision 仅保留类型契约和显式 unsupported stub，不属于已实现的共享核心消费者。
- 工具执行前先经过输入校验和权限上下文，长任务与一次性工具分开建模；这些接口使 allow、ask、deny、并发安全和只读属性能够参与调度。
- 功能开关与动态加载放在模块注册和入口附近，使重型或内部能力可以按构建条件排除；本记录只确认该机制存在，不断言具体构建结果。
- README 把仓库定位为安全研究源码快照，与实际仅有源码的树形态一致；其中把若干文件字节规模写成行数的表述不作为验收指标。

### 备选方案与回溯分析

- 回溯性工程分析：若目标是可复现构建，应保留或补齐依赖清单、锁文件、tsconfig、构建脚本、缺失模块与测试；只保存 src/ 更轻量，但无法证明源码可重建。
- 回溯性工程分析：保留原始历史或另存 provenance 会比单根快照更适合追踪研究来源；当前形式满足历史压缩要求，却牺牲修改归因和演进审查能力。
- 回溯性工程分析：为 CLI 与远程端分别实现代理循环可能获得局部隔离，但会造成模型流、权限和会话行为漂移；现有共享 QueryEngine/query 方案的代价是全局状态和初始化耦合。SDK 若后续接通同一核心可复用该约束，但本 revision 的公共 SDK 函数仍是显式 stub。
- 回溯性工程分析：JWT 的认证使用应采用经过签名验证的 claims；快照中的 decodeJwtPayload() 只适合当前 expiry/refresh 调度语境，不能升级为授权依据。

## 安全与协议边界

- 工具层包含输入 schema、只读与并发属性，权限 hooks 和 src/utils/permissions/ 提供 allow/ask/deny、managed rules 及 bypass 控制；shell、文件写入和子代理仍属于高权限能力，静态控制存在不代表审计完成。
- src/utils/sandbox/、Bash 命令解析和路径检查用于缩小命令执行风险，启动代码还处理 Windows 当前目录 PATH 劫持；这些机制需要按平台和配置另行验证。
- OAuth、secure storage、trusted device、mTLS 与 WebSocket 认证分布于 src/services/、src/utils/、src/bridge/、src/remote/ 和 src/cli/transports/；本文不记录任何凭据，也不把源码中的认证流程视为已取得外部授权环境的验证。
- src/bridge/jwtUtils.ts 的 decodeJwtPayload() 不验证签名，当前只可用于 expiry/refresh scheduling；若把它用于身份或权限判定会形成信任边界错误。
- README 对源码暴露背景的描述仅是仓库内声明；本记录不重复任何敏感值，也不据此推断事件责任或影响范围。

## 验收标准

- Git 验收应确认该 SHA 无父提交，根 diff 恰有 1903 条 A 记录，其中 README.md 一个文件、src/ 下 1902 个文件且无 rename。
- 结构验收应能从入口追踪到 QueryEngine/query、Tool/tools、权限上下文、消息流和工具结果回填，并识别 UI、任务、MCP 与 bridge 的适配位置。
- 文档验收必须把根快照保留内容的提交约束与回溯性模块分析分开，不能虚构先前提交或原始设计讨论。
- 完整性验收必须报告缺失 package/build/test 配置和具体未解析核心导入，不能把文件数量或静态源码规模当作可构建证明。
- 操作证据验收只能引用提交正文自述的 clean status、本地单提交历史和 force-push；fresh clone、安装、测试和运行仍应列为未验证。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | 按 --root、-r、-M 的 diff-tree 口径观察到 1903 个新增文件、零重命名；顶层仅 README.md 与 src/，其中 src/ 为 1902 个文件。 | 该提交 diff 与 Git 元数据 |
| diff-observed | 源码中可直接观察 submitMessage()、query/queryLoop 的 async-generator 消息循环、tool_use 收集和 tool result 回填；这证明结构存在，不证明运行成功。 | `src/query.ts` |
| diff-observed | src/tools.ts 引用了树中不存在的 TungstenTool 模块，核心源码还引用缺失的 src/types/message 与 src/types/tools；这些是静态导入核对结果，不伪装成编译器输出。 | `src/tools.ts` |
| diff-observed | README 将 QueryEngine.ts 写成约 46K 行，但该 revision 实际为 1295 行、46630 字节；因此文档采用 Git 与源码实测值，而不沿用字节/行混用的描述。 | `README.md` |
| not-recorded | 提交正文只自述 git status clean、本地历史变为一个提交及向两个远端 force-push；明确未做 push 后 fresh clone。没有安装、类型检查、构建或测试命令记录，本记录也不声称执行过这些检查。 | 未随提交记录执行证据 |
| later-evidence | 直接后续恢复提交 9b2a352 的 docs/RELEASE.md 将该根快照标为 Source baseline；这一归属说明属于后续文档证据。 | `docs/RELEASE.md`，revision `9b2a35201244ca84adeaa6844bf799e5a18aff6d` |
| later-evidence | 同一后续提交的 docs/STATUS.md 记录后续完成的构建、测试、真实模型检查与仍受限能力；这些均为 later-evidence，不能倒写为根提交已经验证。 | `docs/STATUS.md`，revision `9b2a35201244ca84adeaa6844bf799e5a18aff6d` |

## 实现状态与剩余范围

- 状态：**partial**
- 该树缺少 package.json、锁文件、tsconfig、构建脚本和常规测试套件，因而不能验收为可独立构建的发布源树。
- 静态核对发现 TungstenTool、message/tools 类型、SDK controlTypes 以及部分任务类型等导入目标缺失；缺失原因没有历史证据，不能补写成有意裁剪。
- README 的关键文件行数存在字节与行混用，且 source-map 暴露背景未由本提交独立证明，后续使用时应分别修正和核实。
- 提交正文明确没有 fresh-clone verification；安装、类型检查、测试、CLI/SDK 启动和各平台安全机制均需要在完整环境中另行验证。
- 单根历史无法提供逐文件演进与归因；若研究需要来源链，必须依赖外部保存的历史或 provenance，而不是从该 diff 推断。
