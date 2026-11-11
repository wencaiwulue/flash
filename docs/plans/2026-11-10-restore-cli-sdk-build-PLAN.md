---
commit: 9b2a35201244ca84adeaa6844bf799e5a18aff6d
title: "Restore CLI and SDK build"
date: 2026-11-10T11:39:20+08:00
status: implemented
kind: component
---

# 实施计划：Restore CLI and SDK build

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把研究源码镜像恢复成能够类型检查、构建和验证的 CLI 与 Agent SDK，而不是只增加一个表面可用的打包命令。恢复工作同时包含：从可用 embedded source maps 还原原始 TypeScript/TSX，补齐依赖和公共 SDK 类型，接通 headless CLI、query/tool/MCP 权限链，提供同进程 SDK、V2 多轮会话、portable JSONL session 操作和 scheduled tasks，并用 external-build 边界隔离内部能力。规模上这是一次 789 文件组合恢复，不能把 616 个修改文件都解释成独立新功能，也不能用 build success 覆盖仍然缺失或协议受阻的产品能力。

- 以 4b9d30f 为唯一父提交审阅实际 diff，保留其根快照历史，不把 789 个路径都视为新功能。
- 确认可用的 embedded source maps、转换后源码和缺失 import 清单，恢复源码时保留原模块边界。
- 准备 Bun 1.3.14、TypeScript 与锁定依赖；真实模型验证另用 configured provider 和 isolated HOME，不把凭据写入仓库。
- 先定义 external 范围与未支持能力，避免为了编译通过而恢复私有实现或伪造协议行为。

## 复用与兼容处理

### 复用现有实现

- 复用父快照 QueryEngine/query、AppState、Tool/tools 和权限上下文；SDK process MCP 复用 services/mcp/client.ts 的连接与发现逻辑，交互 UI 则保留 React MCPConnectionManager 与 Ink 组件，不另写平行 agent loop。
- 复用已有 file-backed cronScheduler、PID-liveness lock 和 session JSONL 格式，在其上增加 SDK watch、missed notification 和 portable operations。
- 复用 coreSchemas/controlSchemas 的 Zod 定义生成公共类型，让运行时校验与 TypeScript 声明保持同源。
- 复用 entrypoints/init、CLI transports、commands/skills/plugins 注册机制，SDK 只绕开交互 UI，不复制配置和工具初始化。
- 复用父快照作为发布基线；RELEASE 明确不采用 orphan 或 rewrite，从而保留恢复前后可核对性。

### 兼容、迁移与生命周期

- 保留父提交历史和现有 src/ 模块路径，恢复后的导入与声明可以逐文件和父快照比较。
- 包目标为 Bun/ESM，README 要求 Bun 1.3+、CI 固定 1.3.14；不能据此承诺 Node.js 可直接运行产物。
- runtimeMacros 让直接源码执行和测试无需先 bundle，build defines 则在产物中固定 external 值，两者需保持字段一致。
- SDK 复用核心权限和消息格式，同进程 async input、abort 和 V2 session 不应终止宿主进程；但全局 env/state 限制仍需调用方考虑。
- session fork 重建 UUID 链并保留 content-replacement，但不复制 file-history/undo snapshots，不能宣传为完整工作区克隆。
- 生成类型文件会在 build 时被重写，消费者应修改 Zod schemas 而非手改生成结果；schema 命名要匹配生成器文本规则。
- BUILD_OUTDIR 只控制 Bun JS 输出，build:types 固定 dist/types；自定义输出目录调用者必须处理这一不一致。
- 真实模型验证、CI smoke 和离线测试是不同证据层级，后续兼容声明必须保留这种区分。

## 文件级实施步骤

### 1. 固定依赖、脚本和产品出口

先建立 package.json、bun.lock、bunfig.toml 与 ignore 规则，定义 dev/start/generate/typecheck/test/build 脚本和 CLI/SDK exports；这一步为后续恢复源码提供一致依赖与包契约。

涉及位置：`package.json`、`bun.lock`、`bunfig.toml`、`.gitignore`

### 2. 建立编译、宏和 external 构建底座

配置 strict TypeScript、ambient declarations、私有模块 stubs 和运行时宏，再实现 Zod 类型生成器及双入口 Bun.build。声明 emit 接在 JS bundle 后执行，生成器依赖后续 schemas 才能运行。

涉及位置：`tsconfig.json`、`scripts/generate-sdk-types.ts`、`scripts/build.ts`、`src/runtimeMacros.ts`、`src/env.d.ts`、`src/global.d.ts`、`src/external-stubs/`

### 3. 恢复共享类型、核心查询和通用支撑

按 imports 先补 message/tools 等类型、常量和上下文，再恢复 utils、services、query 与 tools，使 AppState、模型流、权限、MCP 和工具池能够共同类型检查；批量 source-map 恢复与手工功能补丁必须分别审阅。

涉及位置：`src/types/`、`src/constants/`、`src/context/`、`src/state/`、`src/bootstrap/`、`src/utils/`、`src/services/`、`src/query.ts`、`src/query/`、`src/tools.ts`、`src/tools/`

### 4. 接通 CLI、命令和交互终端

在共享核心可解析后恢复 cli.tsx、main.tsx、headless handlers/transports、commands 和 React/Ink UI。version fast path 保持轻量；help 与完整路径再加载 Commander、REPL、权限对话框和 screens，避免复制查询逻辑。

涉及位置：`src/entrypoints/cli.tsx`、`src/main.tsx`、`src/cli/`、`src/commands/`、`src/replLauncher.tsx`、`src/dialogLaunchers.tsx`、`src/interactiveHelpers.tsx`、`src/components/`、`src/hooks/`、`src/ink/`、`src/screens/`、`src/keybindings/`、`src/skills/`

### 5. 按 schema 到 runtime 的顺序实现 SDK

先恢复 core/control Zod schemas 与生成类型，再实现 sdkQuery 的初始化、权限、MCP、异步输入和 cleanup，随后加入 V2 与 portable sessions，最后从 agentSdkTypes.ts 导出；未实现 controls 和 rewind 保持明确失败。

涉及位置：`src/entrypoints/sdk/coreSchemas.ts`、`src/entrypoints/sdk/controlSchemas.ts`、`src/entrypoints/sdk/coreTypes.generated.ts`、`src/entrypoints/sdk/controlTypes.ts`、`src/utils/sdkQuery.ts`、`src/utils/sdkSessionConversation.ts`、`src/utils/sdkSessions.ts`、`src/entrypoints/agentSdkTypes.ts`、`src/services/mcp/client.ts`

### 6. 接入 scheduled tasks 与 LSP 生命周期

复用 cronScheduler 增加 SDK watch 和独立 notification，确保 missed prompt 需要确认且 fence 不被内容逃逸；在 services 中恢复 LSP restart/shutdown timeout，同时把测试结论限定到实际覆盖范围。

涉及位置：`src/utils/cronScheduler.ts`、`src/utils/cronNotification.ts`、`src/services/`、`src/tasks/`、`src/jobs/`

### 7. 恢复其余环境模块并保持禁用边界

按依赖恢复 assistant、bridge、daemon、remote、server、transport 与环境 runner，同时处理 buddy、coordinator、proactive 和平台模块。源码可构建只表示 external 边界成立，不提升 remote、internal 或协议受阻功能状态。

涉及位置：`src/assistant/`、`src/bridge/`、`src/buddy/`、`src/coordinator/`、`src/daemon/`、`src/environment-runner/`、`src/proactive/`、`src/remote/`、`src/self-hosted-runner/`、`src/server/`、`src/transport/`、`src/ssh/`、`src/native-ts/`、`src/memdir/`、`src/moreright/`

### 8. 添加有针对性的离线回归测试

在实现之后分别覆盖工具池、InMemoryTransport MCP、JSONL session/fork、cron fence/abort 和 LSP 配置。测试数量与覆盖陈述从文件中实际 test() 得出，真实模型和完整 LSP 生命周期另列验证，不由新增测试自动推定。

涉及位置：`tests/toolPool.test.ts`、`tests/sdkMcp.test.ts`、`tests/sdkSessions.test.ts`、`tests/sdkCron.test.ts`、`tests/lsp.test.ts`

### 9. 串接 CI 与可重复验证顺序

将 frozen install、generate、typecheck、test、build、CLI version/help 和 SDK export smoke 固化为 CI 顺序；真实模型检查不伪装成 hosted CI 步骤，workflow 文件存在也不记录为 Actions 已通过。

涉及位置：`.github/workflows/ci.yml`、`package.json`、`scripts/build.ts`

### 10. 回写架构、验证状态和发布边界

最后根据实际代码与执行记录更新 README、ARCHITECTURE、STATUS 和 RELEASE，保留未实现/未验证清单与后续顺序。发布文档明确保留 baseline、尚未创建远端仓库或 push，并把 SHA/Actions 结果留给后续记录。

涉及位置：`README.md`、`docs/ARCHITECTURE.md`、`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 批量恢复原始源码可能与快照其他模块版本不匹配，typecheck/build 不能覆盖全部 UI 和运行时行为差异。
- 生成器基于 exported-schema 文本匹配，格式变化可能漏生成；生成后类型检查和 smoke 必须作为防线。
- SDK 修改 process.env 并复用全局 bootstrap state，同进程并发 query 可能相互污染配置或凭据环境。
- external stubs 和 DCE 可能掩盖私有路径差异，绝不能由 external build 成功推断 USER_TYPE=ant 功能兼容。
- 真实模型检查没有随提交附完整脚本和日志，文档记录可追溯性弱于独立 CI 日志，复现时需要相同 provider 条件。
- LSP 测试深度有限，大量 UI 恢复也缺少交互回归；不能把 7 个测试扩大解释为全产品覆盖。
- 发布文档中的远端计划尚未执行，workflow 可能只有在实际 Actions 环境才能暴露新的依赖或权限问题。

## 验收顺序

1. 先用 rename-aware diff-tree 核对 789 个路径、173 A/616 M、零 rename，并确认所有目录组和普通文件都有设计覆盖。
2. 复跑依赖流程时按 bun install --frozen-lockfile、bun run generate:sdk-types、bun run typecheck、bun test、bun run build 顺序执行，并单独保存本次输出，不覆盖 at-commit 历史证据。
3. 核对生成结果为 125 core/59 control types，检查 dist/main.js、dist/sdk.mjs 和 declaration export，再执行 version/help 与 SDK import smoke。
4. 审阅五个测试文件的实际断言，特别注明 tool-pool 数量来自另行 smoke、LSP 没有真实 crash/timeout 测试。
5. 需要重验真实路径时，在 isolated HOME 和已配置 provider 下分别执行 CLI Read round trip、source/packaged SDK query、MCP、V2 resume 和 abort cleanup；不记录或输出凭据。
6. 检查 STATUS 中未实现、禁用和协议受阻项仍未被误标，尤其不得增加 USER_TYPE=ant 验证结论。
7. 实际 push 后再核对 GitHub Actions 日志并后续更新 RELEASE；当前 revision 只能把 hosted CI 记为未执行。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 已加入固定依赖、Bun/TypeScript 配置、双入口构建、SDK 类型生成和 declaration pipeline。
- 已批量恢复原始 TS/TSX，并补齐核心 SDK 类型、工具、消息和运行时模块。
- 已实现 external CLI/SDK 主链、in-process MCP、V2 多轮/resume、portable session mutations/fork 和 scheduled-task 接口。
- 已加入五个离线测试文件、CI workflow、架构/状态/发布文档；tests/toolPool.test.ts、tests/sdkMcp.test.ts、tests/sdkSessions.test.ts、tests/sdkCron.test.ts、tests/lsp.test.ts 覆盖工具池、MCP、会话、定时任务和 LSP 生命周期。
- 已明确 external/disabled 边界、剩余功能缺口和协议依赖，并保留父基线历史。

### 未完成或后续工作

- 远端仓库创建、push、GitHub Actions 结果和最终 release metadata 在该提交时尚未完成。
- SDK rewind、若干 controls、non-REPL stop hooks、Linux libsecret、npm marketplace 和 ultraplan refresh 仍未实现。
- connectRemoteControl、Cloud xattr 和 env-less perpetual bridge 仍等待权威协议；internal KAIROS/proactive/workflow/computer-use 继续禁用。
- changed-file partial reads 缺专门回归，LSP 真实 crash/timeout 与大面积交互 UI 未由新增测试覆盖。
- USER_TYPE=ant 未验证，同进程 SDK 的全局状态/env 隔离和跨平台安全存储仍需后续工程工作。
- 本次文档重建没有独立重跑提交内记录的安装、构建、测试或真实模型命令。
