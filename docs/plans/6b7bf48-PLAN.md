---
commit: 6b7bf48b0b4f0af740073eddbc5584f0c598c539
title: "Complete secure storage, marketplace, and SDK controls"
date: 2026-11-10T12:41:48+08:00
status: implemented
kind: component
---

# 实施计划：Complete secure storage, marketplace, and SDK controls

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本提交需要完成六组边界不同的工作：为 Linux 增加 libsecret 并保留回退，为 npm marketplace 建立安全的数据包物化/刷新，为 ultraplan 在每次远端轮询前检查令牌，为 CLI/SDK 共用文件检查点 rewind，为 headless Stop/SubagentStop 接入模型 hooks，并为既有 SDK 控制接口接上 CLI 子系统。共享集成还必须处理 per-query checkpoint、异步 snapshot 等待、进程级 persistence lease 和幂等清理，不能把各组件写成互相依赖的一套单体。

- 确认六组能力在父提交分别有明确缺口，并识别可复用的 fallbackStorage、PluginMarketplaceSchema、fileHistory、model-hook executors 与 CLI 控制子系统。
- 把 Linux/npm/ultraplan 的外部进程或网络边界设计成可注入依赖，避免测试必须访问真实凭据、registry 或远端会话。
- 确认 SDK runtime types/control schemas 已声明五个方法，且 QueryEngine transcript persistence 是进程全局状态，集成时必须处理并发与清理。
- 将父 initial release 的 CI 元数据与本实现提交的验证状态分开记录，后续 CI 只能以真正后继证据引用。

## 复用与兼容处理

### 复用现有实现

- 复用 SecureStorage、createFallbackStorage、plainTextStorage 和既有 service/account 命名，保持 OAuth 存储调用不变。
- 复用 marketplace manifest schema、cache layout、refresh 单/批量入口与 execFileNoThrowWithCwd timeout。
- 复用 pollForApprovedExitPlanMode 的事件/重试状态机和 checkAndRefreshOAuthTokenIfNeeded。
- 复用 fileHistory snapshot/diff/restore、CLI rewind 结果契约、execPromptHook/execAgentHook 和原 stop feedback。
- 复用 context collection、refreshActivePlugins、stopTask、settings-with-sources、MCP/global cleanup 与 withTokenCountVCR。

### 兼容、迁移与生命周期

- SecureStorage 接口和 macOS/其他平台选择不变，Linux 调用方继续通过 getSecureStorage 读取。
- 既有 marketplace cache/manifest 名称和 refresh API 保持，普通有效 cache 读取不会新增 npm 网络访问。
- CLI --rewind-files 保留 UUID 校验、结果文本和退出方式，SDK 复用底层政策而非改变 CLI 命令契约。
- 五个 SDK 方法填入预声明 InternalQuery 接口，control schemas 不需要迁移；enableRemoteControl 仍按原 unsupported 方式失败。
- 交互式 hooks 不设置 skipModelHooks，headless command/function hooks 继续通过原路径执行。
- 相同 persistSession 的 query 可共享 lease，冲突组合显式失败；close/return 的清理幂等。

## 文件级实施步骤

### 1. 实现 Linux secret-tool 与回退选择

先写 linuxSecretStorage 的 lookup/store/clear runners、稳定 attributes、timeout 和 JSON stdout 解析，store 将 JSON 放入 input 而非 argv；再在 index.ts 只对 Linux 组合既有 fallbackStorage。最后用 mocked runners 验证缺失、错误、stdin 和迁移行为。

涉及位置：`src/utils/secureStorage/linuxSecretStorage.ts`、`src/utils/secureStorage/index.ts`、`tests/linuxSecretStorage.test.ts`

### 2. 实现 npm 数据包物化与缓存刷新

在 marketplaceManager.ts 建立唯一 staging/work/install，使用 ignore-scripts flag/env 执行 npm，按普通或 scoped package 提取目标目录并清理依赖。接入既有 schema/final cache 后扩展 single/bulk refresh 与旧路径安全清理；以 fake runner 覆盖成功、失败、离线和刷新。

涉及位置：`src/utils/plugins/marketplaceManager.ts`、`tests/npmMarketplace.test.ts`

### 3. 插入 ultraplan 轮询前刷新检查

给 pollForApprovedExitPlanMode 增加可选 poll/refresh/sleep dependencies，在每次 pollEvents 前 await refreshOAuth，同时保留 shouldStop 和原异常处理。用可控两次轮询测试固定顺序，避免把 refresh boolean 误作是否轮询的条件。

涉及位置：`src/utils/ultraplan/ccrSession.ts`、`tests/ultraplanPoll.test.ts`

### 4. 提取共享 checkpoint rewind

先扩展 fileHistory 的 per-state enablement 和 snapshot 去重，再实现 fileCheckpointing 的 message-ID Promise 注册、等待、dry-run diff 与恢复。print.ts 随后改用共享 helper，保留 CLI 参数校验；通过临时目录和异步 snapshot 测试验证文件及并发行为。

涉及位置：`src/utils/fileHistory.ts`、`src/utils/fileCheckpointing.ts`、`src/cli/print.ts`、`tests/sdkRewind.test.ts`

### 5. 接通非交互模型 Stop hooks

扩展 executeHooksOutsideREPL 的上下文和过滤参数，仅为 Stop/SubagentStop 调用既有 prompt/agent executor，映射 block、continuation、附件和失败。executeStopHooks 先跑模型阶段再以 skipModelHooks 跑普通路径；mock 两类 executor 验证结果和信号。

涉及位置：`src/utils/hooks.ts`、`tests/headlessHooks.test.ts`

### 6. 适配 SDK controls 并完成 query 生命周期

先在 sdkControl.ts 实现五个领域适配器，再在 sdkQuery.ts 组合这些适配器与已建 checkpoint coordinator。加入 user-message snapshot await、persistence lease/conflict、setup-failure release 以及 return/close cleanup；用 empty-prompt controls 测试、rewind 集成和 null token-count fixtures 验证无模型路径。

涉及位置：`src/utils/sdkControl.ts`、`src/utils/sdkQuery.ts`、`tests/sdkControls.test.ts`、`tests/sdkRewind.test.ts`、`fixtures/`

### 7. 同步支持矩阵与历史证据

README 更新支持和安全边界，STATUS 记录实际 38/146、各 mock/offline/E2E 范围与剩余协议任务；RELEASE 仅补父 initial release 的 SHA、CI 和 remotes，不重写其历史 known limitations。新增测试存在与文档记录通过分别表述。

涉及位置：`README.md`、`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- primary 旧 secret 可能遮蔽较新的 plaintext；fallback 在 primary 更新失败且有旧值时 best-effort 清理，但仍需面对真实桌面环境差异。
- npm 安装会处理未信任包及依赖；双重 lifecycle suppression、只提取目标目录和 finally 清理降低风险，却不能替代插件运行时信任政策。
- 异步 snapshot 与 rewind 竞态会读到不完整检查点；message-ID Promise map 让恢复等待同一写入并传播失败。
- 进程全局 persistence 与 per-query checkpoint 混合容易造成错误隔离假设；lease、冲突拒绝和 finally release 明确约束。
- 模型 hooks 与 command/function hooks 双阶段可能重复或遗漏；modelStopHooksOnly/skipModelHooks 过滤和共享进度 ID 维持各自边界。
- 测试 mock 不能证明真实 secret-tool、npm registry 或远端 ultraplan 行为，文档状态必须保留环境限定。

## 验证顺序

1. 检查 secret-tool argv 不含 secret，stdin 为精确 JSON，并覆盖 primary 失败、旧值遮蔽和首次迁移。
2. 检查 npm 普通/scoped 提取、全部 install flags/env、schema 失败旧缓存保留、失败刷新与部分下载清理。
3. 以调用序列断言每次 poll 前 refresh，并覆盖 refresh/poll 异常仍进入原重试区域。
4. 分别验证 rewind dry-run 无写入、实际恢复/删除、异步等待、非法 ID、并发 checkpoint 和 persistence conflicts。
5. 验证 Stop/SubagentStop 的 allow/block/failure/cancel、preventContinuation、普通 hook 保留和其他事件 unsupported。
6. 用 empty prompt 依次调用五个 controls，观察返回/error 与显式 cleanup，不发起模型请求。
7. 引用 STATUS 的 38/146、typecheck/build 及专门 E2E 记录；父 CI 与后继 e5c06bc 的本提交 CI 分开归属。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 六个独立功能入口及其共享 CLI/SDK 接线均已有实现和对应回归文件。
- secret stdin、npm lifecycle、checkpoint 等待、hook 去重和 query lease/cleanup 的边界已落入代码。
- 11 个离线 token-count fixtures 与六个新测试文件形成无模型/无 registry 的验证支撑。
- README/STATUS/RELEASE 已按各自历史对象更新，未把剩余协议能力标成完成。

### 未完成或后续工作

- 自由文本 npm parser、真实外部服务环境和协议阻塞的 remote/Cloud/bridge 能力仍未完成。
- 非 Stop headless model hooks 与冲突 persistSession 的透明并发隔离不在当前实现内。
