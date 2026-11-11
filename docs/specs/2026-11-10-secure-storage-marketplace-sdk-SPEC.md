---
commit: 6b7bf48b0b4f0af740073eddbc5584f0c598c539
title: "Complete secure storage, marketplace, and SDK controls"
date: 2026-11-10T12:41:48+08:00
status: implemented
kind: component
---

# Complete secure storage, marketplace, and SDK controls

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交 9b2a352 中 Linux 只使用 plaintext storage，typed npm marketplace source 会抛出未实现错误，ultraplan polling 不检查 OAuth refresh，SDK rewindFiles 固定 canRewind=false，headless prompt/agent hooks 均返回 unsupported，五个 SDK control methods 也统一抛错。CLI 已有 inline rewind 与 fileHistory，交互式 hook/model executor 和底层插件、任务、设置实现可复用，但这些能力尚未形成各自独立的可用入口。

本提交需要完成六组边界不同的工作：为 Linux 增加 libsecret 并保留回退，为 npm marketplace 建立安全的数据包物化/刷新，为 ultraplan 在每次远端轮询前检查令牌，为 CLI/SDK 共用文件检查点 rewind，为 headless Stop/SubagentStop 接入模型 hooks，并为既有 SDK 控制接口接上 CLI 子系统。共享集成还必须处理 per-query checkpoint、异步 snapshot 等待、进程级 persistence lease 和幂等清理，不能把各组件写成互相依赖的一套单体。

## 目标与非目标

### 目标

- 在 Linux secure-storage 选择中引入 secret-tool primary 与既有 plaintext fallback，并保证 secret JSON 只经 stdin 传给 store。
- 实现 typed npm source 的全新 staging、package extraction、manifest validation、cache replacement 与 refresh，同时抑制安装 lifecycle scripts。
- 让 ultraplan 每次 poll attempt 前 await refresh check，保持原有事件扫描、重试、phase 与停止语义。
- 提取可等待异步 snapshot 的共享 rewind，并将五个控制适配器、per-query 状态和 query cleanup 接入 InternalQuery。
- 让非交互 Stop/SubagentStop 复用 prompt/agent model executors，且后续 command/function hook 路径不重复执行模型 hooks。
- 用 mock、临时文件系统和空 prompt 回归分隔各组件验证，并在文档中保留协议阻塞及未在线验证的范围。

### 非目标

- 不承诺 Linux secure-only 存储；libsecret 失败时明文回退仍是明确行为，真实桌面 secret-tool 环境不属于 mock 证据。
- 不实现 parseMarketplaceInput 的自由文本 npm shorthand，也不把 --ignore-scripts 扩展成插件代码、hooks 或依赖运行时的通用沙箱。
- 不在本提交启用外部 ULTRAPLAN，不要求每次 refresh check 都实际换新 token，也不改变远端事件协议。
- 不支持 Stop/SubagentStop 之外的 headless prompt/agent model hooks，不把所有 hook 类型都变为非交互可用。
- 不实现 enableRemoteControl/connectRemoteControl、Cloud xattr 或纯 env-less perpetual bridge，也不启用内部实验 flags。
- 不消除进程级 session persistence 约束；冲突的 persistSession 组合会被拒绝，而不是伪装为完全隔离。

## 方案架构与数据流

Linux 存储由 secureStorage/index.ts 选择 createFallbackStorage(linuxSecretStorage, plainTextStorage)，macOS 与其他平台保持原策略。linuxSecretStorage 以稳定 service/account attributes 调用 secret-tool lookup/store/clear，默认同步和异步 runner 都有五秒 timeout、reject:false 与异常结果归一化；读取只在 exit code 0 且 stdout 非空时解析 JSON。store 的 argv 仅含操作、label、service、account，jsonStringify(data) 通过 runner input 进入 stdin，避免凭据进入进程参数。fallbackStorage 负责先 primary 后 plaintext 的读取、成功 primary 写入后的明文清理，以及 primary 失败时写入 plaintext 并清理可能遮蔽新值的旧 primary。

npm marketplace 将 {source:npm, package} 作为数据包物化输入。cacheMarketplaceFromNpm 为每次下载创建带 pid、时间戳和随机数的独立 staging/work/install，调用 npm install <package> --prefix ...，并加 --ignore-scripts、--no-save、--no-package-lock、--no-audit、--no-fund、--omit=dev，同时设置 npm_config_ignore_scripts=true。成功后只把 node_modules 下目标 package（含 scoped name 两级路径）rename 到 staging，依赖和 npm metadata 随 work 在 finally 删除；既有 loader 再验证 .claude-plugin/marketplace.json、按 manifest name 先删除旧 final cache 再将 staging rename 到最终路径；该 finalization 不是原子替换，rename 失败时旧 cache 已被删除。

marketplace 读取与刷新分离：getMarketplace 优先使用有效 cache，不因普通读取访问 registry；显式 refresh 才新建 staging 下载 latest resolved version。下载或 schema 失败在 finalization 前清理，不破坏旧有效缓存；成功刷新更新 install location，并仅对严格位于 marketplace cache 内且不同于新路径的旧位置做清理。single/bulk refresh 都接入同一 npm 分支，runner 可注入以便无网络测试。lifecycle suppression 仅覆盖这次 npm 安装及其依赖，不是后续插件执行边界。

ultraplan 的 pollForApprovedExitPlanMode 新增可注入 pollEvents、refreshOAuth、sleep dependencies。循环仍先检查 shouldStop，在每次远端 try 中先 await refreshOAuth()，再 await pollEvents(sessionId,cursor)；refresh 异常进入原 transient-error 处理。默认 helper 自己判断 token/scope/expiry，boolean 返回值不控制是否 poll，因此语义是每次 attempt 前检查，而非每次强制刷新。cursor、事件扫描、重试上限、三秒 sleep、phase/teleport 结果和调用方 feature gate 均保持。

rewind 基础层给 FileHistoryState 增加可选 checkpointingEnabled，fileHistoryEnabledForState 先服从 CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING，再采用 per-query override，最后回退原交互环境判断；相同 message ID 的最新 snapshot 会去重。新 fileCheckpointing.ts 以 message-ID keyed Promise map 协调 snapshot，重复请求共享同一 Promise，rewind 可等待目标异步写入。rewindFileCheckpoint 统一 enablement、目标存在性和错误契约，dry-run 只返回 diff stats，实际恢复复用备份还原与目标时不存在文件的删除逻辑；print.ts 删除 inline 实现后复用同一 helper。

sdkQuery.ts 为每个 query 建立独立 FileCheckpointing 与 fileHistory state，在非 synthetic user message 交给 ask 前 await makeSnapshot(uuid)，随后把 rewindFiles 与五个 controls 接到 InternalQuery。session transcript persistence 仍是进程全局设置，因此 acquireSessionPersistence 记录旧值、按相同选项共享 reference-counted lease，冲突选项明确报错，最后释放者恢复旧值；checkpoint per-query 隔离不等于开启 transcript persistence。setup failure 通过 setupPromise.catch 独立释放 persistence lease；query.return() 与 close() 进入 memoized cleanup，close 先 abort 再 drain original return，cleanup 在 finally 释放 lease。

headless hooks 将 executeHooksOutsideREPL 扩展为接受 toolUseContext、conversation messages、modelStopHooksOnly 与共享 toolUseID。只有带上下文的 Stop/SubagentStop 进入既有 execPromptHook/execAgentHook，其他事件继续 unsupported；caller、cancellation、timeout signals 被组合，SubagentStop 优先使用 agentId。结果映射保留 allow、structured block、preventContinuation、stopReason、system messages、attachments，模型失败/取消转为 unsuccessful 且 nonblocking。非交互 executeStopHooks 先运行 model hooks，再以 skipModelHooks=true 走原 command/function 路径，从而保留两类行为且避免模型重复执行。

sdkControl.ts 的五个适配器均复用既有子系统：getContextUsage 把当前 messages/tools/agents/system prompts 送入共享 context collection；reloadPlugins 刷新 active plugins 后汇总 commands、agents、plugins、mcpServers 与 error_count；stopTask 保留任务存在/running/type 校验及 not_found 映射；applyFlagSettings 合并 inline flags、删除 null keys、通知变更并同步 model/AppState；getSettings 在 settings-with-sources 上增加 applied.model 与 applied.effort。enableRemoteControl 仍连接 unsupported，五个接口的实现不改变预生成 control schemas。

六组新增测试分别隔离外部边界：secret-tool 与 npm 都用 mock runner，ultraplan 注入 poll/refresh/sleep，rewind 使用临时目录和可控 snapshot，controls 用 empty prompt 避免模型调用，hooks mock 两类 model executor。11 个 hash-keyed token-count VCR fixtures 均记录 tokenCount:null，让现有 withTokenCountVCR 在离线控制测试中走估算回退；它们是共享离线支撑，不是 11 个新功能或在线 token-count 响应。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/utils/secureStorage/linuxSecretStorage.ts` | 新增 secret-tool 同步/异步 adapter、稳定属性、五秒 runner、JSON 解析与 stdin-only store。 |
| 变更 | `src/utils/secureStorage/index.ts` | 仅把 Linux 改为 libsecret primary/plaintext fallback，保留 macOS 和其他平台选择。 |
| 变更 | `src/utils/plugins/marketplaceManager.ts` | 实现 typed npm staging/install/extract/schema/cache/refresh/cleanup，并双重关闭 lifecycle scripts。 |
| 变更 | `src/utils/ultraplan/ccrSession.ts` | 注入轮询依赖并在每次 remote poll 前 await OAuth refresh check，其他循环语义不变。 |
| 变更 | `src/utils/fileHistory.ts` | 增加 per-state checkpointingEnabled、统一 enablement 优先级及同 message ID snapshot 去重。 |
| 变更 | `src/utils/fileCheckpointing.ts` | 新增共享 rewind helper 与 per-query snapshot Promise coordinator，支持等待、dry-run 和实际恢复。 |
| 变更 | `src/cli/print.ts` | 删除 CLI inline rewind 政策，复用共享 helper，同时保留用户消息 UUID 验证与输出/退出流程。 |
| 变更 | `src/utils/hooks.ts` | 实现非交互 Stop/SubagentStop model hooks、结果/取消映射和 skipModelHooks 去重阶段。 |
| 变更 | `src/utils/sdkControl.ts` | 新增 context usage、plugin reload、task stop、flag settings、settings sources 五个共享实现适配器。 |
| 变更 | `src/utils/sdkQuery.ts` | 集成 rewind/controls、per-query snapshots、persistence leases、setup-failure release、return/close 幂等清理。 |
| 变更 | `tests/linuxSecretStorage.test.ts` | 以 mocked secret-tool 验证存储操作、stdin 边界、fallback 和迁移。 |
| 变更 | `tests/npmMarketplace.test.ts` | 以 fake npm 和临时目录验证包名、flags、缓存、schema、刷新与失败清理。 |
| 变更 | `tests/ultraplanPoll.test.ts` | 以注入函数固定 refresh-before-every-poll 的调用顺序。 |
| 变更 | `tests/sdkRewind.test.ts` | 验证 checkpoint 文件效果、异步等待、query 隔离和 persistence lease。 |
| 变更 | `tests/headlessHooks.test.ts` | 验证两类 model Stop hooks 的允许、阻止、失败、取消和 unsupported 边界。 |
| 变更 | `tests/sdkControls.test.ts` | 使用 empty prompt 连接五种 controls 与 query cleanup，不调用模型。 |
| 变更 | `README.md` | 更新 rewind/controls 支持清单及 Linux/npm 安全边界，继续列出 remote control 不可用。 |
| 变更 | `docs/STATUS.md` | 记录 38/146 与分项 offline/E2E/mock 状态，保留下一批协议阻塞任务。 |
| 变更 | `docs/RELEASE.md` | 只更新父 initial release 的 pushed/CI/remotes 元数据；原 7/38 和 known-limitations 段保持历史语境。 |
| 复用 | `src/utils/secureStorage/fallbackStorage.ts`，符号 `createFallbackStorage` | 复用 primary/secondary 读取、写入回退与迁移删除政策。 |
| 复用 | `src/utils/secureStorage/plainTextStorage.ts`，符号 `plainTextStorage` | 继续作为 Linux libsecret 不可用时的明文后备，而非被安全存储替代。 |
| 复用 | `src/utils/plugins/parseMarketplaceInput.ts`，符号 `NPM packages not yet implemented` | 父解析器的自由文本 npm 限制未改，明确本提交只接 typed source。 |
| 复用 | `src/services/vcr.ts`，符号 `withTokenCountVCR` | 复用 hash-keyed VCR 查找和 null token count 的估算回退，支撑离线 controls 测试。 |
| 复用 | `src/query/stopHooks.ts` | 复用 blocking hook 到 meta user feedback 的下游转换，不在 headless adapter 重写停止协议。 |

### 大型快照分组核对

- 新增 11 个不同 input hash 的 token-count VCR JSON；每项均为 tokenCount:null，供 withTokenCountVCR 离线估算回退。：`fixtures/`，11 个文件。

## 关键决策与工程取舍

- 把 libsecret 放在既有 fallbackStorage 后面，而不是替换跨平台 SecureStorage 接口，使 OAuth 调用方不变，并显式保留失败回退与首次成功迁移。
- npm 每次物化使用全新 staging 且只提取目标 package，避免把依赖树或旧 cache 当作 marketplace 内容；manifest 通过后才替换最终目录。
- 将 refresh check 放在 poll attempt 内而非循环外，覆盖重试后的每次远端访问；不依据 boolean 结果阻止 poll，保留 helper 的按需刷新契约。
- snapshot Promise 以 message ID 注册并共享，使 rewind 能等待正在进行的持久化，而不是把尚未出现的 checkpoint 误判为无效。
- checkpoint 状态按 query 隔离，但 transcript persistence 采用显式 lease/conflict 规则，承认底层全局状态而不提供虚假并发隔离。
- 模型 Stop hooks 与普通 hooks 分两个阶段执行，并以 skipModelHooks 防止重复；只有模型类 Stop 事件进入 headless side query。
- SDK controls 放在适配层连接现有 CLI 实现，不重写 context、plugin、task 或 settings 领域逻辑，也不改变既有 runtime type/control schema。

### 备选方案与回溯分析

- 回溯性比较：把 secret JSON 拼入 secret-tool argv 虽能减少 input 处理，却会暴露进程参数；实际选择 stdin 降低 argv 泄漏面，但不能据此宣称明文 fallback 消失。
- 回溯性比较：直接在最终 marketplace cache 运行 npm install 可省去 rename，却会让失败下载和依赖内容污染可用缓存；独立 staging 增加目录管理，保证下载或 schema 失败时旧版本尚未被删除，但不消除后续 finalization 的非原子风险。
- 回溯性比较：复制 CLI rewind 到 SDK 可快速返回结果，但 snapshot 等待、dry-run 和错误语义会分叉；共享 helper 与 per-query coordinator 把公共政策和查询隔离分开。
- 回溯性比较：为每个 query 无条件切换全局 persistence 看似灵活，并发时却会互相恢复错误旧值；引用计数加冲突拒绝更明确地暴露真实约束。
- 回溯性比较：为 headless hooks 另写模型评估循环会脱离既有协议；复用 execPromptHook/execAgentHook 保留结构化判断与工具验证行为，代价是仍需完整 ToolUseContext。

## 安全与协议边界

- secret-tool store 的凭据 JSON 仅通过 stdin 传递，argv 保留非敏感定位属性；测试明确检查 secret 不出现在 argv，但不据此隐藏 plaintext fallback。
- libsecret 读取对缺失、非零退出和 malformed JSON 均回退为无 primary 数据，runner timeout 与异常归一化避免单个进程错误绕过既有 fallback 政策。
- npm 安装同时提供 --ignore-scripts 与 npm_config_ignore_scripts=true；这只抑制 marketplace 安装 lifecycle，不代表下载包或之后加载的插件代码被沙箱化。
- npm registry 配置和认证由继承环境中的 npm 管理，测试 runner 不访问 registry；目标包经过 schema validation 才会替换有效缓存。
- CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING 是 per-query enablement 之上的绝对禁用；实际 rewind 才写文件，dry-run 仅计算差异。
- headless model hooks 接收组合取消/超时信号，模型失败保持 nonblocking；block 与 preventContinuation 仍进入原停止反馈协议。

## 验收标准

- Linux lookup/store/clear 使用稳定 secret-tool attributes，store stdin 为精确 JSON；primary 成功/失败及 plaintext 迁移符合既有 fallback 规则。
- 普通与 scoped npm package 都从干净 staging 提取，install flags/env 抑制 scripts，schema 失败和部分下载不破坏旧 cache，refresh 后安全清理替换目录。
- 连续两次 remote poll 可观察到两次有序 refresh-before-poll，调用方 shouldStop、原重试与事件处理不受影响。
- SDK rewind 能等待目标 snapshot，dry-run 不改文件，实际恢复处理修改与新增文件，CLI 复用相同结果和错误契约。
- 并发 query 的 checkpoint enablement 相互独立，冲突 persistence lease 被拒绝；setup failure 单独释放 lease，return 与 close 共用幂等 cleanup。
- Stop/SubagentStop model hooks 支持 allow/block/failure/cancellation 和结果传递，普通 hooks 继续执行且模型部分不重复，其他事件仍 unsupported。
- 五个 SDK controls 返回共享实现的实际数据或领域错误，enableRemoteControl 保持 unsupported；tests/linuxSecretStorage.test.ts、tests/npmMarketplace.test.ts、tests/ultraplanPoll.test.ts、tests/sdkRewind.test.ts、tests/headlessHooks.test.ts、tests/sdkControls.test.ts 覆盖各组件行为。

## 实现状态与剩余范围

- 状态：**implemented**
- parseMarketplaceInput 的自由文本 npm shorthand 仍未实现；本提交完成的是 typed MarketplaceSource 的加载与刷新。
- Cloud xattr、connectRemoteControl/enableRemoteControl 和纯 env-less perpetual bridge 仍受协议约束，内部 KAIROS/proactive/workflow/computer-use 继续禁用。
- 真实 libsecret、registry 和 ultraplan 服务行为需要各自授权环境；offline mock 与 recorded E2E 不应互相替代。
- 进程级 persistence 仍要求并发 query 使用兼容选项，且全局 checkpoint disable 优先于单 query 开启。
- npm finalization 先删后 rename，rename 失败可能丢失旧 cache；新增测试只证明下载或 schema 阶段的失败保留。
- SDK setup failure 与 close() 没有新增专门回归；现有测试覆盖冲突 lease 的恢复和 return() 清理。
