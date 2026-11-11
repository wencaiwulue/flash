---
commit: 6b7bf48b0b4f0af740073eddbc5584f0c598c539
title: 凭据、marketplace 与 SDK 控制面的实施顺序
date: 2026-11-10
retrospective: true
---

# 凭据、marketplace 与 SDK 控制面的实施顺序

## 1. 先实现可注入的 Linux secret-tool 适配器

**文件：** `src/utils/secureStorage/linuxSecretStorage.ts`。

定义同步/异步 `SecretToolRunner`，默认实现以 `reject:false`、`timeout:5000` 调用 `execaSync/execa`。lookup/store/clear 只生成 service/account 参数；store 调用必须采用：

```ts
run(storeArgs(), jsonStringify(data))
```

`parseResult()` 在非零退出、空输出和 JSON 异常时返回 null。保留 `createLinuxSecretStorage(options)` 注入点，再在 secure-storage selector 中接入 libsecret 与既有 fallback。

**验收：** `tests/linuxSecretStorage.test.ts` 覆盖参数、stdin、同步/异步读取、非法 JSON、进程异常和 update/delete 返回值：

```bash
bun test tests/linuxSecretStorage.test.ts
```

## 2. 实现 npm 包的隔离物化

**文件：** `src/utils/plugins/marketplaceManager.ts`。

提供可替换 `npmRunner`，默认使用 `execFileNoThrowWithCwd`。安装参数包含：

```text
install <packageName> --prefix <installPath> --ignore-scripts --no-package-lock
```

环境同时设置 `npm_config_ignore_scripts:'true'`。实现顺序：

1. 创建独立 `${cachePath}.work/install`；
2. 调用 npm，失败则带 stderr 退出；
3. 只移动 `node_modules/<packageName>` 到临时 cachePath；
4. 解析并校验 marketplace schema；
5. 用 `resolve()` 验证最终 cachePath 严格位于 cacheDir 内；
6. 校验成功后替换旧缓存，最后清理 staging。

**验收：** `tests/npmMarketplace.test.ts` 覆盖 scoped package、两层 ignore-scripts、下载失败、旧目录不复用、路径逃逸、非法 manifest 和清理：

```bash
bun test tests/npmMarketplace.test.ts
```

## 3. 建立消息级 checkpoint 等待关系

**文件：** `src/utils/fileCheckpointing.ts`、`src/utils/fileHistory.ts`、`src/utils/sdkQuery.ts`。

先在 pending map 注册 Promise，再启动 `fileHistoryMakeSnapshot()`；同一 messageId 直接复用已有 Promise。`rewindFiles()` 必须等待该 Promise，然后调用共享 `rewindFileCheckpoint()`：

- disabled → `File rewinding is not enabled.`；
- 无 checkpoint → `No file checkpoint found for this message.`；
- dryRun → 只计算 diff stats；
- 正式恢复 → 调用 `fileHistoryRewind()` 并捕获错误。

SDK query 每条 user message 创建对应 checkpoint，控制请求 rewind 时传入同一 ID，不能建立进程级全局开关。

**验收：** `tests/sdkRewind.test.ts` 覆盖并发去重、等待顺序、snapshot 失败、dry run 不写文件和正式恢复：

```bash
bun test tests/sdkRewind.test.ts
```

## 4. 连接 SDK 控制请求与生产状态

**文件：** `src/utils/sdkControl.ts`、`src/utils/sdkQuery.ts`。

实现五个独立适配器：context usage 调 `collectContextData`；flag settings 合并/null 删除/model 通知；settings 返回 sources+applied；stopTask 复用任务模块；plugin reload 聚合并发结果。不要把控制响应字段在 sdkQuery 中另写一套推导逻辑。

随后恢复 `src/utils/hooks.ts` 的 headless prompt/agent hook 执行路径，并移除 `src/cli/print.ts` 对该能力的占位限制。

**验收：**

```bash
bun test tests/sdkControls.test.ts
bun test tests/headlessHooks.test.ts
```

控制测试重点检查 null 删除、model metadata、reload 返回字段；hook 测试按 prompt/agent 生命周期断言调用顺序、输入和错误传播。

## 5. 收尾检查

`src/utils/ultraplan/ccrSession.ts` 的轮询边界由 `tests/ultraplanPoll.test.ts` 独立约束，不与 npm 或 SDK 控制测试混合。最后按依赖顺序运行：

```bash
bun test tests/linuxSecretStorage.test.ts tests/npmMarketplace.test.ts tests/sdkRewind.test.ts tests/sdkControls.test.ts tests/headlessHooks.test.ts tests/ultraplanPoll.test.ts
bun run typecheck
bun test
```

回滚时先移除 SDK 控制入口，再回滚 checkpoint、npm 和 secure storage。任一层失败都不能通过写入真实凭据、启用 lifecycle scripts 或跳过 snapshot 等待来制造通过。
