---
commit: adaa8fffa7c7c536d782616f8f7e187de637a582
title: "Implement env-less perpetual continuity"
date: 2026-11-11T00:40:35+08:00
status: implemented
kind: component
---

# 实施计划：Implement env-less perpetual continuity

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要在完全不使用 Environments API register/poll/ack/heartbeat 的 env-less 路径上实现可恢复的 perpetual：按 cwd 持久化 cse_* 与 SSE 序号，恢复时跳过创建，401 或主动刷新时在同一会话和序号上重建 transport，并区分暂时退出与永久归档。Workflow 命令还需在 headless 环境使用真实权限函数而不是 allow-all。验证只能通过 mock HTTP/transport 的隔离进程证明客户端控制流；当时没有 Claude OAuth，不能把 cse_test、固定序号 42 或直接触发 close(401) 说成真实服务端恢复。

- 确认父提交的 env-less 仅用于非 perpetual，现有 createV2ReplTransport 已支持 initialSequenceNum/getLastSequenceNum。
- 确认纯 env-less 仍需 OAuth 与 /bridge，但不调用 Environments register/poll/ack/heartbeat/deregister。
- 确认普通 cleanup 不应破坏待恢复会话，永久归档需要独立显式句柄操作。
- 当时没有 Claude OAuth，验证方案必须使用无凭据 mock，并把单进程 fixture 与真实跨重启/在线验收分开。

## 复用与兼容处理

### 复用现有实现

- 复用 getProjectsDir/sanitizePath、lazySchema 和 jsonStringify 实现项目级指针。
- 复用 createCodeSession/fetchRemoteCredentials、createV2ReplTransport、SSETransport 和 FlushGate。
- 复用 createTokenRefreshScheduler、onAuth401 和现有 OAuth/orgUUID/version 检查。
- 复用 startWorkflowTask 与 hasPermissionsToUseTool，保持 Workflow DAG 和权限语义。
- 复用 perpetualBridge 的 mock 路径选择测试及独立 Bun 子进程测试模式。

### 兼容、迁移与生命周期

- 非 perpetual 的 env-less 路径继续每次创建新会话，只有 perpetual 才读取和更新指针。
- env-less gate 关闭时仍使用既有 env-based pointer/reconnect，已有用户配置不被删除。
- ReplBridgeHandle.archive 为可选字段，env-based handle 不需要立即新增实现。
- 普通 teardown 的公开方法保持，perpetual 通过内部 final 参数选择语义，显式 archive 是新增操作。
- Workflow 名称、定义发现和 startWorkflowTask 不变，只改变命令类型、返回形式和缺失权限回调时的处理。

## 文件级实施步骤

### 1. 建立 env-less 指针协议

在 envLessBridgePointer.ts 定义 sessionId/lastSequenceNum/updatedAt schema，以 cwd sanitize 定位文件。实现 0600 写入、按 mtime 的四小时过期、损坏数据回退和清除；只保存 ID 与序号，不写 OAuth/JWT，写失败仅降级并记录 debug。

涉及位置：`src/bridge/envLessBridgePointer.ts`

### 2. 开放 perpetual 路径并扩展句柄

在 replBridge.ts 增加可选 archive，在 initReplBridge.ts 移除 perpetual 的 env-based 强制回退，让 env-less gate 同时覆盖普通和 perpetual，并传 getOriginalCwd。保留 gate 关闭时的 env-based 实现及现有 OAuth、orgUUID 和版本检查。

涉及位置：`src/bridge/replBridge.ts`、`src/bridge/initReplBridge.ts`

### 3. 实现同会话、同序号创建与恢复

在 remoteBridgeCore.ts 读取 perpetual 指针，有指针则复用 sessionId/序号并跳过 createCodeSession，无指针才创建并写序号 0。对同一 ID 获取 /bridge 凭据，传 initialSequenceNum 创建 transport；在新会话、writeMessages 和暂时退出时更新高水位，初始化失败只归档新建会话。

涉及位置：`src/bridge/remoteBridgeCore.ts`

### 4. 串行化 401 重建并拆分清理语义

继续在同一 core 中用 authRecoveryInFlight 串行 401 与主动刷新，重建前排队的 FlushGate、读取旧序号，再以旧 session/序号和新 JWT/epoch 重建并 drain。实现 teardown(final)：暂时退出只关闭并保存，显式 archive 才 result/archive/清指针，处理一次 401 刷新重试。

涉及位置：`src/bridge/remoteBridgeCore.ts`

### 5. 打通 Workflow 非交互权限回退

在 createWorkflowCommand.ts 将命令改为 local，声明 supportsNonInteractive，call 返回 taskId 文本而非 onDone。删除缺少 canUseTool 的提前拒绝，改用 context.canUseTool ?? hasPermissionsToUseTool 并继续 startWorkflowTask，保证 headless 可进入且不绕过权限。

涉及位置：`src/tools/WorkflowTool/createWorkflowCommand.ts`

### 6. 补隔离过程回归和路径断言

修改 perpetualBridge.test.ts，证明 perpetual 不再注册 environment。新增外层测试启动一个 fixture 子进程；fixture 使用真实临时目录和 mock axios/transport，依次验证首次创建、暂时保留、同 ID/序号恢复、显式归档清指针及 401 后第二次 /bridge 和同序号重建，并明确这不是两个真实进程或在线 SSE。

涉及位置：`tests/perpetualBridge.test.ts`、`tests/envLessPerpetual.test.ts`、`tests/fixtures/env-less-perpetual-check.ts`

### 7. 记录离线证明与 OAuth live 边界

STATUS 将 env-less perpetual 标为 offline isolated process，记录 152/645 和后续授权 OAuth/桌面事项。RELEASE 记录客户端恢复设计、Workflow headless 改动以及会话配置 provider 的模型 sentinel，同时明确无 Claude OAuth，Cloud Files、Remote Control 和 env-less live server 未验证。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 指针损坏或过期会造成新会话；写盘失败还可能保留旧序号，必须接受降级并避免误报最新高水位已持久化。
- 401 与主动刷新并发会重复 bump epoch 或混用序号，authRecoveryInFlight 与 FlushGate 是必要同步点。
- 暂时 teardown 若沿用旧 archive 行为会永久终止待恢复会话，final 分支必须先于 result/archive。
- 显式 archive 尝试清指针不以服务端成功为条件，失败时可能失去本地恢复线索，unlink 失败则可能留下指针，需在剩余语义中明确。
- archive 没有生产调用点时，用户退出不会自动永久归档；不能把句柄能力说成已接通 UI 流程。
- 单进程 mock fixture 无法发现真实 OAuth、SSE 和跨进程问题，发布状态必须保持 offline isolated process。

## 验收顺序

1. 运行 env-less perpetual 外层测试，确认 fixture 退出码为 0 并输出 ENV_LESS_PERPETUAL_OK。
2. 检查首次 create 数为 1、普通 teardown 无 archive，第二次 init 后 create 数仍为 1 且 initialSequenceNum=42。
3. 调用显式 archive，确认出现 archive 请求且读取指针为 null；另触发 close(401)，确认 bridgeCalls=2 且序号不变。
4. 运行 perpetualBridge 路径选择测试，确认 perpetual 调 initEnvLessBridgeCore，不调 registerBridgeEnvironment/createBridgeSession。
5. 检查 Workflow 命令类型、noninteractive 标记和 hasPermissionsToUseTool 回退，再另行执行真实 headless 权限回归。
6. 依据 at-commit STATUS 引用 152/645、typecheck、build/declarations；真实 OAuth、SSE 恢复、Cloud/Remote Control 必须在授权环境另取证。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 项目级 env-less cse/SSE 指针、四小时 TTL、0600 写入和清除已经实现。
- perpetual 已可沿 env-less 路径复用同一 session 和序号，不再强制依赖 Environments API。
- 401/主动刷新同会话重建、暂时 teardown 保留与显式 archive 清指针已经形成确定控制流。
- Workflow 动态命令已改为 local/noninteractive，并接入真实权限函数回退。
- 隔离过程 fixture 和路径选择回归已经加入，at-commit 文档记录 152/645 与构建结果。

### 未完成或后续工作

- 真实 Claude OAuth、服务端 SSE 恢复、401 刷新、Cloud Files 和 Remote Control 在线往返未执行。
- 两个不同真实进程的重启恢复、TTL/损坏/写盘失败和 stale cse_* 服务端行为未覆盖。
- 显式 archive 的生产调用 UX、失败时清指针的恢复策略以及 Workflow 非交互专项回归仍需完善。
