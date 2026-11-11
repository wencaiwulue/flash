---
commit: 6b7bf48b0b4f0af740073eddbc5584f0c598c539
title: Linux 凭据存储、npm marketplace 与 SDK 控制面设计
date: 2026-11-10
retrospective: true
---

# Linux 凭据存储、npm marketplace 与 SDK 控制面设计

## 范围

该提交包含四条相互独立但都影响 SDK/CLI 可用性的实现：Linux libsecret、npm marketplace 缓存、SDK 控制接口、按消息关联的文件 checkpoint/rewind。它们共享现有运行时，不应被理解为一套新的统一协议。

## 1. Linux libsecret

`linuxSecretStorage.ts` 用 `secret-tool` 的 lookup/store/clear 实现 `SecureStorage`：

- service/account 参数复用现有 keychain 命名；label 固定为 `Claude Code Credentials`。
- 更新时把 JSON 放在 stdin，避免凭据进入命令行参数。
- 同步和异步调用都有 5 秒超时；进程异常转换为非零结果。
- 非零退出、空 stdout 或 JSON 解析失败都返回 null；update/delete 只以退出码判断成功。

现有 secure-storage 选择器继续提供明文 fallback。libsecret 不可用与“凭据不存在”在该接口上都表现为 null，因此调用者不能把 null 进一步解释为认证已失效。

## 2. npm marketplace

`marketplaceManager.ts` 将 npm 包视为数据源，而不是可信安装程序：

```text
临时 .work/install
  → npm install <package> --ignore-scripts --no-package-lock
  → 读取 node_modules/<package>
  → schema 校验与最终 cachePath 检查
  → 替换旧缓存
  → 清理 staging
```

命令行和环境同时禁用 lifecycle scripts；npm 自己管理 registry 认证与下载缓存，应用不把 token 放到命令行。每次刷新使用独立临时目录，避免复用旧包内容。最终目录必须位于 marketplace cacheDir 内，manifest 校验成功后才替换旧缓存。

## 3. SDK 控制接口

`sdkControl.ts` 把控制请求映射到已有状态与生命周期：

- `getSdkContextUsage()` 复用 `collectContextData()`，不另算 token/context。
- `applySdkFlagSettings()` 合并 flag settings，删除值为 null 的键，通知 change detector；model 变化额外更新 override 和 session metadata。
- `getSdkSettings()` 返回 settings sources，并附加当前 model/effort。
- `stopSdkTask()` 调用现有 `stopTask()`。
- `reloadSdkPlugins()` 先刷新插件，再并行加载 commands 和 cache-only plugin state，返回 commands、agents、plugins、mcpServers 与 error_count。

`hooks.ts` 的 headless hook 路径与这些控制接口配套，使非交互运行也能执行已有 prompt/agent 生命周期。

## 4. Checkpoint 与 rewind

`FileCheckpointing` 以 query 实例为边界，不使用进程级 checkpoint 配置：

- `makeSnapshot(messageId)` 在启动异步工作前把 Promise 放进 pending map；同一消息共享同一 Promise。
- `rewindFiles()` 先等待该消息的 snapshot，失败则返回 checkpoint 创建错误。
- dry run 只返回 filesChanged/insertions/deletions，不写文件。
- 真正 rewind 先检查功能开关和目标 checkpoint，再调用 `fileHistoryRewind()`，异常转换为 `canRewind:false`。

这保证“读取到用户消息”与“该消息对应快照已完成”之间存在明确的等待关系。

## 验收标准

1. secret-tool 的 store 数据只经 stdin 传递；lookup/store/clear 参数、超时、空结果和非法 JSON 行为符合上述契约。
2. npm 安装同时具有 CLI 与环境两层 ignore-scripts，staging 不被旧缓存污染，schema 或路径校验失败不会替换现有缓存。
3. flag null 删除、model metadata 通知、context 收集、stopTask 和 plugin reload 返回值均来自现有生产实现。
4. 同一消息的并发 snapshot 只执行一次；rewind 等待对应 snapshot，dry run 不写文件，缺失 checkpoint 和恢复失败都有明确错误。
5. `linuxSecretStorage.test.ts`、`npmMarketplace.test.ts`、`sdkControls.test.ts`、`sdkRewind.test.ts`、`headlessHooks.test.ts` 分别覆盖上述分支。
