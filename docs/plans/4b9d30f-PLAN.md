---
commit: 4b9d30f7953273e567a18eb819f4eddd45fcc877
title: "asdf"
date: 2026-03-31T03:34:03-07:00
status: partial
kind: component
---

# 实施计划：asdf

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

问题有两个层次：形式上要把当时内容保存成单提交基线；实质上得到的是一份只有 README.md 与 src/ 的研究源码镜像，而不是可直接重建的产品仓库。根快照包含查询、工具、终端 UI、MCP、权限和远程桥接等大量实现，却缺少依赖清单、锁文件、TypeScript/构建配置与常规测试，并存在可静态确认的核心导入缺口。文档必须同时忠实呈现架构价值和不可运行、不可追溯的边界，不能把 513517 行对空树的插入量误写成一次开发新增量。

- 确认目标 SHA 是无父提交的根节点，所有文件统计都采用根 diff，而不是伪造 parent revision。
- 记录提交正文中的单提交、保留 README reframing/repository contents 和已发布历史重写约束；后续 force-push 需要协调。
- 把 README 的外部背景声明、源码可观察结构和后续 revision 的证据分别标记，避免证据时代倒置。
- 审阅环境只读取 Git 对象和源码，不需要也不应读取任何本地凭据。

## 复用与兼容处理

### 复用现有实现

- 根提交没有父树可复用；以下复用仅指同一快照内的模块关系，不表示从先前 Git revision 继承。
- 交互 REPL 直接复用 query()，headless 与远程入口复用 QueryEngine/query 的会话循环，避免分别实现消息流和工具续轮；SDK 公共函数在该 revision 显式 unsupported，仅共享类型与协议契约。
- 工具与命令复用 Tool.ts、tools.ts、commands.ts 的注册契约，权限 UI 复用 useCanUseTool 与 utils/permissions。
- React/Ink 组件复用 hooks、state 和 ink 基础设施，MCP、OAuth、API 与 bridge 复用 services 中的连接和认证支撑。

### 兼容、迁移与生命周期

- 保留 src/ 原有目录和模块命名，有助于后续按导入路径恢复缺失依赖；单根历史本身不提供旧版本兼容证据。
- migrations 与 settings 代码表明源码考虑既有配置升级，但没有运行 fixtures 或测试，不能承诺真实用户目录可无损迁移。
- feature gate、动态 import 和 SDK unsupported 边界应原样识别，不能为了让文档完整而改写成已支持能力。
- 后续恢复构建时应保持公开 CLI/SDK 语义，并单独处理缺失类型和模块，避免用任意空实现换取表面编译通过。

## 文件级实施步骤

### 1. 建立根快照与仓库说明

先以空父树建立单个 baseline，将 README 的研究归档定位和实际源码规模一起保存；提交说明只记录明确的压缩要求与操作结果，不为旧历史编造设计理由。后续步骤是按 imports 回溯的依赖审阅顺序，不是可从根提交恢复的历史作者顺序。

涉及位置：`README.md`

### 2. 归档基础类型、常量与通用依赖

先按 imports 归档共享类型、常量、上下文、状态、记忆、历史和成本辅助，再审阅权限、设置、沙箱、secure storage、模型与任务工具函数；这些是 query、服务和 UI 的依赖基础，不能留到消费者之后才被描述为反向引用核心。

涉及位置：`src/types/`、`src/constants/`、`src/context.ts`、`src/context/`、`src/state/`、`src/utils/`、`src/memdir/`、`src/cost-tracker.ts`、`src/costHook.ts`、`src/history.ts`

### 3. 归档 API、MCP、认证与配置服务

在查询组合之前审阅 API/OAuth/MCP/compaction 等服务、schemas 与配置迁移，明确核心循环所需的外部契约；JWT 解码不得越权承担认证，服务源码存在也不等于外部协议已经验证。

涉及位置：`src/services/`、`src/schemas/`、`src/migrations/`

### 4. 建立会话契约与查询循环

在基础契约后落 Tool、Task、QueryEngine 与 query/queryLoop，确保输入、消息状态、模型流、工具结果和终止条件有明确数据主线；缺失类型和导入仍需在完整性审计中报告。

涉及位置：`src/QueryEngine.ts`、`src/query.ts`、`src/Tool.ts`、`src/Task.ts`、`src/query/`

### 5. 接入工具、命令、代理与后台任务

依赖核心 Tool/query 契约组织内建工具与 agent 子循环，再注册 slash commands、skills 和 plugins，保留 coordinator 的模式门控、提示和 worker 约束，并以 Task/tasks 管理长生命周期工作；assistant、buddy 保持独立边界，moreright 仅为 external stub。

涉及位置：`src/tools.ts`、`src/commands.ts`、`src/tools/`、`src/commands/`、`src/skills/`、`src/plugins/`、`src/tasks.ts`、`src/coordinator/`、`src/tasks/`、`src/assistant/`、`src/buddy/`、`src/moreright/`

### 6. 放入启动、配置和入口层

在核心与工具依赖明确后审阅 Commander 入口、bootstrap、CLI transports 和 SDK 边界，使入口按依赖组合底层模块；保留当时显式 unsupported 的 SDK 方法，而非写成可用。

涉及位置：`src/main.tsx`、`src/setup.ts`、`src/bootstrap/`、`src/entrypoints/`、`src/cli/`

### 7. 组装 React/Ink 交互层

在会话状态和权限接口之后放置 hooks、终端渲染、屏幕、对话框、输入、键位、Vim 与 onboarding，使 REPL 用户输入进入 query()，消息和权限请求返回 UI，而不在组件中另写代理循环；QueryEngine.ask() 服务于 headless/one-shot 等路径，不是所有交互输入的统一入口。

涉及位置：`src/replLauncher.tsx`、`src/ink.ts`、`src/dialogLaunchers.tsx`、`src/interactiveHelpers.tsx`、`src/projectOnboardingState.ts`、`src/hooks/`、`src/components/`、`src/ink/`、`src/screens/`、`src/keybindings/`、`src/outputStyles/`、`src/vim/`

### 8. 接入远程与平台适配

在工具和权限契约可复用后，以 remote、server 和 bridge 适配订阅、控制消息及远程权限回调，并归档语音、原生适配和上游代理；这些路径保持各自网络与平台边界，不把源码存在提升为运行验证。

涉及位置：`src/bridge/`、`src/remote/`、`src/server/`、`src/voice/`、`src/native-ts/`、`src/upstreamproxy/`

### 9. 执行快照完整性与证据审计

核对根节点、1903 个新增路径和目录计数，检查 README 行数、静态相对导入、缺失构建配置与测试；提交正文没有记录的运行检查一律保持未验证，并把 fresh-clone 留作明确后续步骤。

涉及位置：`README.md`、`src/tools.ts`、`src/types/`

## 风险与处理

- 历史压缩使文件来源和修改理由不可追溯，任何“原始意图”断言都可能失真。
- 大量生成或转换后的源码与缺失导入会制造静态可审阅但不可构建的假象，需要专门完整性检查。
- shell、文件写入、MCP 和远程权限具有高权限影响，未经隔离环境验证不应直接运行完整快照。
- 无签名 JWT decode、平台凭据存储和代理认证都有明确信任边界，文档必须防止把辅助解析误当安全证明。
- README 的规模单位和外部背景存在准确性风险，应以 revision 实测与独立来源分别校正。

## 验证顺序

1. 用 rev-list --parents 与根 diff-tree 验证无父节点、1903 个新增文件、零重命名及 README/src 的完整覆盖。
2. 抽查入口、QueryEngine/query、Tool/tools、权限和 bridge 源码，确认文档中的数据流都能落到实际符号。
3. 用静态导入扫描定位缺失模块，并把扫描结果标为词法核对而非编译通过；后续补齐后再运行 TypeScript 检查。
4. 在具备依赖和隔离配置的环境中依次执行安装、类型检查、测试、CLI/SDK 构建与 smoke；本提交没有这些执行记录。
5. 完成 fresh clone 后复核文件树和后续恢复能力，不能用提交正文的 clean status 或 force-push 自述替代。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- 已形成无父提交的单根基线，README 与 1902 个 src/ 文件全部进入 Git 树。
- 查询、工具、命令、任务、终端 UI、服务、权限和远程桥接的源码结构可从该 revision 直接审阅。
- 提交正文记录了历史重写约束、clean status 和推送自述，并明确保留 fresh-clone 未测试项。
- 本记录已完成全量路径分组、具体核心文件说明和后续证据隔离。

### 未完成或后续工作

- 依赖、锁文件、构建与 TypeScript 配置、常规测试和 CI 均不在根快照中。
- 若干核心导入目标缺失，尚未通过安装、类型检查或构建确定完整修复集合。
- agentSdkTypes.ts 的 query、V2、session 管理和 connectRemoteControl 等公共 SDK 函数显式抛出未实现错误，不只是缺少运行证据。
- 没有 fresh-clone、CLI/SDK 启动、模型往返、权限或平台安全机制的运行验证。
- 被压缩历史、README 外部事件归因与文件来源没有由本提交恢复或独立证明。
