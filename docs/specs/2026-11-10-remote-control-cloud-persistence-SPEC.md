---
commit: 02bc3c2efcd3f3d7978da33b2683e9d392f3220c
title: "Unblock remote control and Cloud persistence"
date: 2026-11-10T15:53:19+08:00
status: implemented
kind: component
---

# Unblock remote control and Cloud persistence

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交已经定义 RemoteControlHandle 和 SDK enableRemoteControl 的外形，也已有 initEnvLessBridgeCore 传输核心，但公开 connectRemoteControl 只会抛出 unavailable，SDK 查询的 enableRemoteControl 仍是 unsupported。传输核心缺少让 SDK 接管控制请求的所有权回调，若直接复用会与默认 REPL 响应处理器重复应答。Cloud 持久化已有 BYOC 上传路径，anthropic_cloud 分支却只是返回空结果的 xattr 占位。Files API 已有 listFilesCreatedAfter/FileMetadata，并已使用 after_created_at、after_id 和既有重试，但缺少 AbortSignal 与重复游标防护；has_more 页没有下一游标时会停止遍历并返回危险的部分结果。perpetual 的跨重启连续性仍由 env-based bridge-pointer.json 提供，纯 env-less perpetual 并没有可依赖的协议。

需要把已有 env-less 传输变成可供 SDK 使用的真实远程控制句柄，使用户消息、SDK 输出、控制请求和权限决策能双向流动并在关闭时完整收口；同时，Cloud 输出目录中本地修改的文件需要获得可报告的 file_id，但不能猜测尚未确定的 xattr 属性。方案还要避免为支持新句柄而破坏 perpetual 的既有重连能力，并用离线传输与文件元数据测试界定已验证行为，不把 fake transport 当作真实 OAuth、Cloud 或远程会话证据。

## 目标与非目标

### 目标

- 在 env-less core 之上实现 RemoteControlHandle，提供可缓冲的 FIFO 用户输入、控制请求和权限响应流，以及幂等 teardown。
- 让 SDK query 输出、远程用户输入、控制操作和 canUseTool 权限请求形成闭环，以 request_id 精确关联响应并传播控制错误。
- 接通 connectRemoteControl 与 createSdkQuery.enableRemoteControl 的初始化、完成后的顺序重复启用、禁用和查询清理生命周期。
- 通过 Files API 的 after_created_at/after_id 列表能力取得完整元数据，拒绝中断或循环分页造成的危险部分视图。
- 以规范化的 outputs 相对路径匹配 Cloud file ID，处理索引延迟、重复及歧义元数据、大小不符、部分失败和 AbortSignal。
- 明确保留 env-less+perpetual 到 env-based pointer/reconnect 的有意回退，并用离线测试固定该边界。

### 非目标

- 不宣称已完成真实 OAuth、远程控制服务或 Cloud Files API 的在线往返，提交证据仅覆盖离线 fake transport 和本地文件系统。
- 不实现纯 env-less perpetual 协议；现有 Environments API、bridge-pointer.json 和重连路径继续承担跨重启连续性。
- 不在 anthropic_cloud 分支重新上传文件字节，既有 Cloud 同步负责内容，本组件只关联本地输出与 Files API 元数据。
- 不猜测 xattr 名称、编码或输出根，也不在元数据歧义时按列表顺序或文件大小任选一个 file_id。
- 不改变 RemoteControlHandle 的既有公开形状或引入另一套 SDK 权限 API。

## 方案架构与数据流

daemonBridge.ts 内部 AsyncQueue 以 items 数组保存 FIFO 数据，以 waiters 集合唤醒空队列消费者；iterate 每次 shift 一项，关闭后先排空已缓冲数据再结束，push 在 closed 后不再接收。connectDaemonBridge 分别建立 inboundPromptQueue、controlRequestQueue、permissionResponseQueue，把 core 的用户消息、非 initialize 控制请求和权限响应推入对应队列。initialHistoryCap 设为 0，用户输入只接受 user 消息，toSDKMessages、baseUrl、orgUUID、getAccessToken 沿用传入配置；401 回调先执行注入或默认 OAuth 刷新，再允许 core 重试。

桥接句柄是 core 能力的窄适配而非伪造传输：sessionUrl 由 bridgeSessionId 和 sessionIngressUrl 生成，environmentId 固定为空字符串以表达 env-less，write 将单条 SDKMessage 包装成 core.writeSdkMessages 的数组，结果和控制发送函数直接转发，三个只读异步迭代器暴露队列。onStateChange 广播给已注册监听器。initCore 返回 null 时整个连接返回 null；teardown 以缓存 Promise 保证幂等，先等待 core.teardown，并在 finally 关闭三个队列，即使底层清理失败也能唤醒消费者退出。

remoteBridgeCore.ts 新增可选 onControlRequest 所有权回调：返回 true 表示调用者将自行响应，core 不再调用 handleServerControlRequest；返回 false 或没有回调则走既有默认处理。daemonBridge 对 initialize 返回 false，让 core 保留初始化应答，对其他请求入队并返回 true。这个路由决定与 FIFO 队列共同防止 SDK 和 REPL 默认处理器对同一 request_id 重复响应，同时不改变既有 REPL 使用者的行为。

sdkRemoteControl.ts 启动四个协作任务。outputTask 将 query 的每条消息写入 handle，迭代正常结束后 sendResult；inboundTask 把远程 prompt 转成带 session_id、parent_tool_use_id 和 UUID 的 SDKUserMessage 并 push 到原 UserMessageChannel；controlTask 对 interrupt、set_model、set_max_thinking_tokens、set_permission_mode 调用同一 InternalQuery，再以原 request_id 返回 success 或 error；permissionTask 只消费权限响应队列，按 request_id resolve/reject pending 项，并将远端 allow/deny 转成 PermissionDecision。

权限关联由 startSdkRemoteControl 内部的 pending Map 承担，而不是依赖响应到达顺序。requestPermission 为每次调用生成 randomUUID，先登记 resolve/reject，再发送 subtype=can_use_tool、含 tool_name/input/tool_use_id 的 control_request；成功响应还必须通过运行时形状检查，deny 会附带 hook 类型 decisionReason，错误响应拒绝对应 Promise，未知或无主的响应被忽略。stop 使用缓存 Promise，先不等待地调用 query.return 以避免输出清理再次调用 stop 形成自等待，再 allSettled 桥接 teardown 与 query.interrupt，等待四个任务退出，最后以 Remote control stopped 拒绝并清空全部 pending。

createSdkQuery 保存当前 remoteController。enableRemoteControl(true) 在已有控制器时返回同一 session/connect/environment 信息，否则先完成查询初始化，取得显式或 OAuth 账户的 organizationUUID，再提供目录、SDK worker 名称、访问令牌提供者、API base URL 和模型给 remoteControlFactory；空 org 或空 handle 都是明确错误。控制器存在时 canUseTool 优先走远程 requestPermission，未启用时仍走 options.canUseTool 或普通权限路径。禁用先摘除引用再 stop，查询 cleanup 也执行相同收口。agentSdkTypes.ts 的 connectRemoteControl 仅保留公开入口并委托 connectDaemonBridge。

Files API 客户端 listFilesCreatedAfter 以 ISO after_created_at 请求 GET /v1/files，并把每项转换为 {filename,fileId,size}。has_more 时用本页最后一个 id 作为 after_id；若 has_more 却没有游标，或游标重复，直接抛出 pagination interrupted，避免把漏页结果误判为未上传。每页复用 retryWithBackoff 的最多三次尝试（首次失败后最多再重试两次）和 500ms 起始指数退避，401/403 立即抛出；AbortSignal 同时传给 axios 与 sleep，已取消错误不会被包装成普通网络重试。只有完整遍历所有页才返回元数据数组。

Cloud 匹配先复用 findModifiedFiles 扫描 session outputs，空集合不调用 API，超过既有 FILE_COUNT_LIMIT=1000 直接报告目录级失败。normalizeCloudRelativePath 对 API 路径统一反斜杠，对本地路径只把平台 sep 转为 /，避免 POSIX 文件名中的反斜杠被误作目录；两侧都拒绝空值、NUL、末尾斜杠、POSIX/驱动器绝对路径、归一化后为 `.` 的路径和上级穿越；`./nested/result.txt` 这类可安全归一化的点段会被接受并规范化。lstat 再确认普通文件并跳过符号链接，读取错误进入 failed，合法项进入 relativePath 键控的 pending Map。

每轮列表只索引仍 pending 的规范路径：metadataByPath 记录 path→fileId→sizes，pathsById 记录 fileId→paths。同一路径和 ID 的重复副本可去重接受；同一路径出现多个 ID，或同一 ID 声称多个待匹配路径，都报告 Ambiguous 并停止匹配该项。唯一匹配后才把有限 size 作为辅助完整性检查；若存在有限 size 且没有一个等于本地大小，则进入 failed。没有有限 size 时不以大小否决，同 path/ID 的重复副本中任一有限 size 匹配即可通过。成功项保留在 files 并移出 pending，未出现项最多进行三轮索引轮询，间隔从 250ms 指数增长；最终未匹配项单独失败，已匹配项仍保留。列表异常使所有剩余 pending 失败，而任一取消检查命中时返回空 files/failed，不发布取消前的部分关联结果。

perpetual 不是新传输协议的一部分。initReplBridge 保持 isEnvLessBridgeEnabled() && !perpetual 的选择条件：env-less 且非 perpetual 才进入 env-less core；一旦 perpetual 为真，即使 env-less 特性开启，也走已有 env-based 路径以保存并重连 bridge-pointer.json。该提交用注释和 perpetualBridge 测试固定这个有意边界，并验证有效指针复用、无效指针清理后新建，以及 perpetual teardown 保留指针且不 archive/sendResult，而不是把 pure env-less perpetual 虚报为完成。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/assistant/daemonBridge.ts`，符号 `connectDaemonBridge` | 新增 env-less RemoteControlHandle 适配器，承载三条可关闭 FIFO、认证刷新、状态监听和幂等清理。 |
| 变更 | `src/bridge/remoteBridgeCore.ts`，符号 `onControlRequest` | 为 env-less core 增加控制请求所有权回调，使 SDK 接管请求时跳过默认 REPL 应答并保持 initialize 默认处理。 |
| 变更 | `src/utils/sdkRemoteControl.ts`，符号 `startSdkRemoteControl` | 实现 SDK 输出/输入/控制/权限四个任务、request_id 关联、PermissionDecision 转换和无自等待 stop。 |
| 变更 | `src/utils/sdkQuery.ts`，符号 `enableRemoteControl` | 把远程控制器接入查询初始化、canUseTool 优先级、重复 enable、disable 与统一 cleanup。 |
| 变更 | `src/entrypoints/agentSdkTypes.ts`，符号 `connectRemoteControl` | 保持既有公开类型和函数签名，将固定 unavailable 抛错替换为 connectDaemonBridge 委托。 |
| 变更 | `src/services/api/filesApi.ts`，符号 `listFilesCreatedAfter` | 强化既有按创建时间列出 Files 元数据的客户端；保留 OAuth 请求与网络重试，新增 AbortSignal、缺失游标报错及重复游标检测。 |
| 变更 | `src/utils/filePersistence/filePersistence.ts`，符号 `executeCloudPersistence` | 用本地修改扫描、规范路径、双向歧义索引、有限延迟轮询和取消语义替代空 xattr 占位。 |
| 变更 | `src/bridge/initReplBridge.ts`，符号 `isEnvLessBridgeEnabled() && !perpetual` | 在既有选择条件处明确 perpetual 的 env-based pointer/reconnect 回退是有意保留的协议边界，而非遗漏。 |
| 变更 | `tests/daemonBridge.test.ts`，符号 `maps the handle and buffers inbound streams before teardown` | 通过 fake core 固定三类入站流可读、控制所有权、initCore=null 与队列关闭行为；多项预缓冲和 FIFO 顺序仅由实现观察支持。 |
| 变更 | `tests/sdkRemoteControl.test.ts`，符号 `SDK remote control query integration` | 通过 fake handle/query 固定控制路由、权限配对和 SDK 启停生命周期。 |
| 变更 | `tests/cloudPersistence.test.ts`，符号 `Cloud file persistence` | 通过临时输出目录和 mock API 固定路径映射、缺游标分页中断、延迟、歧义、部分失败及预先/列表在途取消边界。 |
| 变更 | `tests/perpetualBridge.test.ts`，符号 `perpetual bridge path selection` | 固定 env-less/perpetual 的路径选择和 env-based 指针复用、失效重建、teardown 保留语义。 |
| 变更 | `README.md`，符号 `connectRemoteControl` | 更新公开能力说明，强调 env-less 实现、离线覆盖、Files API 路径映射以及真实远程往返仍需授权环境。 |
| 变更 | `docs/STATUS.md`，符号 `Cloud file persistence` | 记录 61/247 离线结果、remote control/Cloud 的 offline 验证级别及 env-based perpetual 后续边界。 |
| 变更 | `docs/RELEASE.md`，符号 `## Remote control and Cloud unblocking` | 记录发布设计、验证与发布元数据待后续补充的约定，并明确 pure env-less perpetual 是独立工作；CI 结果由后续 revision 补记。 |
| 复用 | `src/bridge/replBridge.ts`，符号 `ReplBridgeHandle` | 复用底层 core 句柄的会话标识、发送和 teardown 契约，不在 daemonBridge 重建传输。 |
| 复用 | `src/utils/auth.ts`，符号 `checkAndRefreshOAuthTokenIfNeeded` | 复用既有 OAuth 令牌读取及 401 刷新流程，测试可注入刷新函数而不接触真实凭据。 |
| 复用 | `src/utils/filePersistence/outputsScanner.ts`，符号 `findModifiedFiles` | 复用 turnStartTime 后的 outputs 修改扫描和环境类型判定，BYOC 与 Cloud 共用候选来源。 |
| 复用 | `src/utils/filePersistence/types.ts`，符号 `FILE_COUNT_LIMIT` | 复用持久化事件结构、输出子目录、上传并发和 1000 文件限制，保持现有调用方结果格式。 |

## 关键决策与工程取舍

- 远程控制复用 initEnvLessBridgeCore，而不是继续保留 daemon stub 或另写网络协议；新增代码集中在句柄适配、流所有权和 SDK 生命周期。
- 控制请求用显式布尔所有权决定默认处理器是否运行，initialize 仍由 core 默认应答；相比全部劫持，这减少 SDK 对既有初始化协议的重复实现。
- 三条入站流分别使用可关闭 FIFO 队列，允许消息在消费者等待前到达；关闭后排空再结束，兼顾不丢已接收事件与最终退出。
- 权限以随机 request_id 和 pending Map 关联，绝不按 FIFO 响应顺序猜测属于哪个工具调用；传输队列有序并不等于权限完成顺序可假设。
- Cloud 文件身份以规范化相对路径为主、大小为辅，冲突即失败；这样相同 basename 不会串联，列表顺序和大小也不会掩盖一对多歧义。
- 索引缺失采用有限轮询而非无限等待，成功与失败按文件保留；取消则丢弃本轮部分结果，避免调用者把中断快照当作完整持久化事件。
- perpetual 继续使用 env-based pointer/reconnect 是功能保留决策，不是把 env-less handle 临时改名；纯 env-less perpetual 被明确留作独立协议工作。

### 备选方案与回溯分析

- 回溯性比较：可以为 SDK 远程控制再造 daemon 专用传输，但会重复认证、消息映射和控制协议；实际复用 env-less core，并用 onControlRequest 解决所有权冲突。
- 回溯性比较：可以只用单个混合事件队列，但消费者需要再次分拣且关闭语义耦合；实际将 prompt、控制请求和权限响应拆成三条 FIFO，再由 SDK 各任务消费。
- 回溯性比较：可以继续等待 xattr 协议或按 basename/size 猜 file_id；实际使用 Files API 的公开列表字段和完整相对路径，付出索引延迟轮询成本，避免未定义属性与错误关联。
- 回溯性比较：可以为 perpetual 立即设计纯 env-less 持久化指针；实际保留已存在的 env-based 连续性，以显式条件回退降低跨重启回归，代价是仍依赖 Environments API。

## 安全与协议边界

- 访问令牌通过 getAccessToken 回调和既有 OAuth 刷新逻辑提供，句柄不保存或记录令牌；缺少 organizationUUID 或 core 初始化失败不会伪造成功 session。
- 权限响应必须匹配 pending request_id 并通过 allow/deny 形状检查；stop 会拒绝所有未决请求，防止工具授权 Promise 永久悬挂。
- onControlRequest 防止默认 REPL 与 SDK 对同一控制请求重复响应，控制异常以原 request_id 返回错误而非静默成功。
- Cloud 匹配限制在 session outputs 的规范相对路径，拒绝绝对路径和穿越，lstat 跳过符号链接及非普通文件，并沿用 1000 文件上限。
- 分页缺游标或重复游标会被视为失败，不能在漏页视图上把文件误判为缺失；同路径多 ID 和同 ID 多路径均不自动选择。
- AbortSignal 贯穿列表请求、重试睡眠和匹配轮询；真实 OAuth 权限、服务端授权和 Cloud 内容同步不在离线测试的证明范围内。

## 验收标准

- connectDaemonBridge 返回的句柄映射真实 core 标识与发送函数，三类入站事件按各自 FIFO 顺序可读，initialize 由默认处理器应答且其他控制请求不重复处理。
- initCore 返回 null 时连接返回 null，initCore 抛错则向上传播；teardown 可重复调用，且无论 core 清理是否成功都会关闭三条队列并使迭代器最终退出。
- SDK 输出能写入 handle，远程 prompt 能进入原消息 channel，四类控制操作调用同一 query 并以对应 request_id 返回成功或错误。
- can_use_tool 请求包含工具名、输入和 tool_use_id，allow/deny/error 只结算对应 pending 项；stop 和 query cleanup 都会结束任务并拒绝未决权限。
- 首次 enable 完成后，顺序重复 enable 返回当前控制器信息而不创建第二个控制器；disable 后恢复正常权限路径，公开 connectRemoteControl 不再抛固定 unavailable。并发 enable 没有 in-flight Promise 或互斥锁，不属于已保证范围。
- Files 列表遍历全部 after_id 页面，网络错误按既有策略重试，认证/授权错误直接失败，缺游标或重复游标不会返回部分数组。
- Cloud 匹配区分嵌套路径与相同 basename，接受无害重复，拒绝路径/ID 歧义；若存在有限 size 且无一匹配本地大小则失败，跳过符号链接并限制文件数量。
- 索引延迟能在至多三次、250ms 起始的轮询后恢复；最终缺失和列表异常按文件报告，已确定成功可与失败并存，取消不发布部分结果。
- env-less+perpetual 明确选择 env-based，非 perpetual 才选择 env-less；有效指针复用、无效指针重建和 teardown 保留指针均有回归覆盖。

## 实现状态与剩余范围

- 状态：**implemented**
- 真实 OAuth 授权、远程 bridge 会话和 Cloud Files API 往返仍需在授权环境验证，fake transport 不能证明服务端协议、权限或时序。
- 纯 env-less perpetual 尚未实现；当前跨重启连续性有意依赖 env-based Environments API 和 bridge-pointer.json。
- Cloud 索引在三轮后仍缺少元数据会报告失败，调用方需依据下一轮或上游同步状态处理，不会无限等待。
- anthropic_cloud 只关联 file_id，字节同步是否成功由既有 Cloud 同步层负责，不在本组件验证范围内。
- remoteController 只在首次 enable 完成后防止顺序重复创建；并发 enable/disable 未串行化，可能发生重复初始化，现有测试也未覆盖该交错。
