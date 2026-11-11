---
commit: 02bc3c2efcd3f3d7978da33b2683e9d392f3220c
title: "Unblock remote control and Cloud persistence"
date: 2026-11-10T15:53:19+08:00
status: implemented
kind: component
---

# 实施计划：Unblock remote control and Cloud persistence

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把已有 env-less 传输变成可供 SDK 使用的真实远程控制句柄，使用户消息、SDK 输出、控制请求和权限决策能双向流动并在关闭时完整收口；同时，Cloud 输出目录中本地修改的文件需要获得可报告的 file_id，但不能猜测尚未确定的 xattr 属性。方案还要避免为支持新句柄而破坏 perpetual 的既有重连能力，并用离线传输与文件元数据测试界定已验证行为，不把 fake transport 当作真实 OAuth、Cloud 或远程会话证据。

- 确认 RemoteControlHandle、ConnectRemoteControlOptions 和 InternalQuery.enableRemoteControl 的既有形状必须保持，不可用 stub 是要替换的实现点。
- 确认 initEnvLessBridgeCore 已提供认证、会话、消息映射和控制传输，新增工作只处理 SDK 所有权与生命周期。
- 确认 anthropic_cloud 的文件字节由既有同步层处理，Files API 列表能提供 filename、id、size_bytes 和分页游标。
- 确认 perpetual 的 bridge-pointer.json 重连仍依赖 env-based 路径，不能为了统一传输而静默移除。
- 将所有在线 OAuth/Cloud/remote 验证与离线 fake 测试分开，测试数据不依赖真实令牌或外部会话。

## 复用与兼容处理

### 复用现有实现

- 复用 initEnvLessBridgeCore、ReplBridgeHandle、toSDKMessages 和 getRemoteSessionUrl 组成公开远程句柄。
- 复用 checkAndRefreshOAuthTokenIfNeeded、getClaudeAIOAuthTokens、getOrganizationUUID 与 getOauthConfig，不保存新凭据副本。
- 复用 UserMessageChannel、InternalQuery 控制方法和现有 PermissionDecision/PermissionResult 类型。
- 复用 retryWithBackoff、findModifiedFiles、getSessionIngressAuthToken、sleep 和 FILE_COUNT_LIMIT，保持 Files/BYOC 行为一致。
- 复用 env-based bridge pointer 创建、重连、清理和 teardown 逻辑，perpetual 只明确路径选择边界。

### 兼容、迁移与生命周期

- RemoteControlHandle 和 connectRemoteControl 的签名不变，env-less 句柄以 environmentId 空字符串表达无环境，而不是伪造环境 ID。
- remoteBridgeCore 未传 onControlRequest 的既有调用者仍走默认处理，initialize 在 SDK 模式下也继续由 core 应答。
- 首次 enable 完成后的顺序重复 enable 返回当前会话，disable 和 query cleanup 共用控制器 stop；未启用远程控制时 options.canUseTool 与普通权限路径保持原样，并发 enable/disable 未被串行化保证。
- BYOC 上传分支及 FilesPersistedEventData 结构保持，Cloud 新逻辑只替换此前空结果分支。
- perpetual 用户继续使用 env-based pointer/reconnect，teardown 保留指针；非 perpetual 的 env-less 路径不受影响。

## 文件级实施步骤

### 1. 建立 env-less 句柄、FIFO 与控制所有权

先在 remoteBridgeCore.ts 增加 onControlRequest 布尔回调，true 跳过默认响应、false 保留原处理。随后在 daemonBridge.ts 实现可关闭 AsyncQueue，为用户 prompt、非 initialize 控制请求和权限响应各建一队；把 core 回调接入队列并映射 RemoteControlHandle。最后以缓存 Promise 包装 core.teardown，在 finally 关闭队列，处理 initCore=null 和重复清理。

涉及位置：`src/bridge/remoteBridgeCore.ts`、`src/assistant/daemonBridge.ts`

### 2. 连接 SDK 控制循环、权限关联和公开入口

在 sdkRemoteControl.ts 建立输出、入站、控制、权限四个任务，以 randomUUID/pending Map 关联 can_use_tool 响应，并实现 success/error 控制回复和防自等待 stop。再把控制器挂到 sdkQuery.ts 的 enable/disable/cleanup 与 canUseTool 优先级，接入 org、令牌和模型初始化。agentSdkTypes.ts 最后将公开 connectRemoteControl 委托给已完成的桥接工厂。

涉及位置：`src/utils/sdkRemoteControl.ts`、`src/utils/sdkQuery.ts`、`src/entrypoints/agentSdkTypes.ts`

### 3. 扩展 Files API 的完整分页列表能力

扩展既有 FileMetadata 和 listFilesCreatedAfter；保留 after_created_at/after_id 请求及 filename/fileId/size 转换，复用现有重试和 OAuth 请求头，新增 signal 传递、缺失或重复游标失败，避免返回部分元数据视图。

涉及位置：`src/services/api/filesApi.ts`

### 4. 实现 Cloud 规范路径匹配与有限轮询

在 filePersistence.ts 保留 BYOC 分支，替换 Cloud 空实现：先扫描和限制修改文件，再规范本地/API 相对路径并用 lstat 排除符号链接。建立 path→ID 与 ID→path 双向索引，依次处理重复、歧义、大小和唯一匹配；以三轮、250ms 起始退避等待索引，保留逐文件成功/失败，列表异常覆盖剩余 pending，任何 abort 都不发布本轮部分结果。

涉及位置：`src/utils/filePersistence/filePersistence.ts`

### 5. 固定 perpetual 的 env-based 回退边界

检查 initReplBridge.ts 的选择条件仍为 env-less 且非 perpetual，并在该处写明跨重启连续性由 env-based bridge-pointer.json 提供。不要把 perpetual 改为纯 env-less，也不要在 teardown 清除其指针；将 pure env-less perpetual 保留为独立协议工作，使后续测试能明确区分传输选择与连续性语义。

涉及位置：`src/bridge/initReplBridge.ts`

### 6. 补充分层离线回归和发布证据

分别添加 daemonBridge、sdkRemoteControl、cloudPersistence、perpetualBridge 测试：前两组使用 fake core/handle/query，Cloud 组使用临时目录和 mock 列表，perpetual 组检查路径选择和指针生命周期。README 与 STATUS/RELEASE 只记录实际离线覆盖、61/247 和验证命令范围，不预写尚未取得的 CI 结果，同时保留真实授权往返未执行、pure env-less perpetual 未实现的边界。

涉及位置：`tests/daemonBridge.test.ts`、`tests/sdkRemoteControl.test.ts`、`tests/cloudPersistence.test.ts`、`tests/perpetualBridge.test.ts`、`README.md`、`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 队列关闭若遗漏会悬挂消费者，底层 teardown 若抛错也可能跳过清理；通过缓存 Promise 和 finally 同关三队处理。
- 输出生成器清理会再次调用 stop，直接 await query.return 可能自等待；实现显式不等待该调用，再以 allSettled 收口其余任务。
- 控制请求若同时被 core 和 SDK 处理会重复响应；布尔所有权回调及 initialize 例外将责任固定到单一处理者。
- Cloud 列表漏页或游标循环会制造错误缺失判断；客户端拒绝不完整分页，匹配层再限制轮询轮数。
- 路径同名、重复 ID 或索引延迟可能造成误关联；规范相对路径、双向歧义检查和辅助大小验证优先于列表顺序。
- 取消发生在部分匹配之后时结果可能不完整；实现选择不发布任何本轮部分结果，调用方不能把取消当作完成事件。
- 离线 fake 不能暴露真实服务端认证、协议和时序问题；发布状态仅标 offline，在线往返仍为独立验收。

## 验收顺序

1. 先运行 daemonBridge 定向测试，验证三类入站流可读、initialize 交还默认处理、null 初始化和重复 teardown；FIFO 多项预缓冲、顺序与关闭后排空另从实现核对，不归为这些测试的直接断言。
2. 再运行 sdkRemoteControl 测试，检查 prompt 入队、四类控制响应、权限 request_id 配对、enable/disable 和 stop 清理。
3. 运行 Cloud 路径与元数据测试，分别观察嵌套路径、重复副本、同路径多 ID、同 ID 多路径及大小不符。
4. 用可控列表响应验证完整分页、缺游标/重复游标失败、索引延迟恢复、最终缺失的部分成功和列表异常。
5. 分别在扫描前、列表途中和匹配期间触发 abort，确认不调用不必要的 API、取消在途请求且不发布部分结果；另查无修改、1000 文件上限和符号链接。
6. 运行 perpetual 测试，确认 env-less+perpetual 选择 env-based，非 perpetual 选择 env-less，指针复用/失效/保留符合生命周期。
7. 依据 at-commit STATUS 引用 61/247 全量测试、typecheck 和 build/declarations；CI 42778573907 只能作为后续 ea80851 的 RELEASE 所记录的 later evidence 引用，真实 OAuth、Cloud 与远程会话必须在授权环境另行验证。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- env-less core 已适配为 RemoteControlHandle，三条 FIFO、控制所有权、认证回调和幂等 teardown 已接通。
- SDK 输出、远程输入、控制请求、权限配对、启停与查询清理已形成闭环，公开 stub 已替换。
- Files API 已在既有按创建时间列表客户端上补齐取消、缺失游标失败和重复游标检测，并保留网络重试。
- Cloud outputs 已能按规范相对路径关联 file_id，并处理歧义、大小、延迟、部分失败和 abort。
- perpetual 的 env-based 有意回退及指针生命周期已被明确保留。
- 四组离线测试和 README/STATUS/RELEASE 证据已加入；tests/daemonBridge.test.ts、tests/sdkRemoteControl.test.ts、tests/cloudPersistence.test.ts、tests/perpetualBridge.test.ts 覆盖各组件行为。

### 未完成或后续工作

- 真实 OAuth、Cloud Files 和远程控制会话的在线端到端验证未在该提交执行。
- 纯 env-less perpetual 仍是独立协议任务，当前实现没有消除 Environments API 依赖。
- Cloud 索引超过三轮仍不可见时会失败，不会提供无限等待或自动猜测文件身份。
