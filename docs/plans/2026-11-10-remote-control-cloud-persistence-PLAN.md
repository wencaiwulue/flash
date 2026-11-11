---
commit: 02bc3c2efcd3f3d7978da33b2683e9d392f3220c
title: Remote control 与 Cloud 持久化的实施顺序
date: 2026-11-10
retrospective: true
---

# Remote control 与 Cloud 持久化的实施顺序

## 1. 先实现 daemon 队列与传输所有权

**文件：** `src/assistant/daemonBridge.ts`、`src/bridge/remoteBridgeCore.ts`。

实现泛型 `AsyncQueue<T>`：`items.shift()` 保证 FIFO；空队列注册 waiter；close 设置 closed 并唤醒所有 waiter。为 prompt/control/permission 各建一个队列，再向 `initEnvLessBridgeCore()` 传入回调：

```ts
onControlRequest: request => {
  if (request.request.subtype === 'initialize') return false
  controlRequestQueue.push(request)
  return true
},
onPermissionResponse: response => permissionResponseQueue.push(response),
onInboundMessage: message => {
  if (message.type === 'user') inboundPromptQueue.push(/* content/uuid */)
},
```

`onAuth401` 先调用 OAuth refresh。handle.teardown 缓存 Promise，并在 core teardown 后关闭三个队列。

**验收：** `tests/daemonBridge.test.ts` 用 fake core 验证 FIFO、initialize 所有权、401 refresh 和迭代器退出：

```bash
bun test tests/daemonBridge.test.ts
```

## 2. 实现 SDK controller 的四任务模型

**文件：** `src/utils/sdkRemoteControl.ts`、`src/utils/sdkQuery.ts`、`src/entrypoints/agentSdkTypes.ts`。

分别启动 output/inbound/control/permission 四个 async task。控制请求按 subtype 调 query 方法，并始终按 request_id 返回 success 或 error。

权限处理顺序必须是：生成 UUID → pending.set → sendControlRequest → await result → finally delete。成功响应先校验 `control_response` 和 allow/deny payload；deny 转换 message、hook reason、可选 interrupt/toolUseID。

停止逻辑保留两个关键点：

```ts
void query.return(undefined) // 不 await，避免 output cleanup 再次等待 stop
await Promise.allSettled([handle.teardown(), query.interrupt()])
await Promise.allSettled([outputTask, inboundTask, controlTask, permissionTask])
```

缓存 stopPromise，最后拒绝并清空 pending。

**验收：** `tests/sdkRemoteControl.test.ts` 和 `tests/perpetualBridge.test.ts` 覆盖控制应答、权限错误、未知 ID、stop 重入与队列收尾：

```bash
bun test tests/sdkRemoteControl.test.ts tests/perpetualBridge.test.ts
```

## 3. 让 Files API 分页成为完整前置条件

**文件：** `src/services/api/filesApi.ts`。

在 `listFilesCreatedAfter()` 中维护 `afterId` 与 `seenCursors`。每页处理完 metadata 后：

```ts
if (!page.has_more) break
const lastFile = files.at(-1)
if (!lastFile?.id) throw new Error('pagination interrupted: no next cursor')
if (seenCursors.has(lastFile.id)) throw new Error('pagination interrupted: repeated cursor')
seenCursors.add(lastFile.id)
afterId = lastFile.id
```

retryWithBackoff 同时接收 signal；axios 请求和 sleep 也接收 signal。401/403 不重试。

**验收：** 在 `tests/cloudPersistence.test.ts` 用分页 fake 覆盖两页拼接、空页 has_more、重复游标和取消，不调用真实 API。

## 4. 实现 Cloud path↔fileId 关联

**文件：** `src/utils/filePersistence/filePersistence.ts`。

按以下顺序实现，避免边扫描边发布部分结果：

1. `normalizeCloudRelativePath()` 与本地 outputs relative path 校验；
2. lstat 排除非普通文件和 symlink；
3. 建立 pending；
4. 每轮完整读取 Files API 分页，建立 `metadataByPath` 与 `pathsById`；
5. 先判多 ID/跨 path 冲突，再检查 size，最后写入 files 并删除 pending；
6. 未命中最多三轮，失败列表带具体原因；
7. 任一 abort 检查命中时返回空结果。

**关键测试数据：**

- 同 path 同 ID 两条记录：允许；
- 同 path 两个 ID：Ambiguous；
- 同 ID 对应两个 path：Ambiguous；
- remote size 不同：size mismatch；
- remote size 缺失：可匹配；
- 第三轮前取消：不得返回前两轮已匹配项。

运行：

```bash
bun test tests/cloudPersistence.test.ts
```

## 5. 集成与回归

将 `connectRemoteControl()` 从显式 unavailable 接到 daemon bridge，并确保 `initReplBridge.ts` 不再重复接管 SDK 已拥有的控制请求。最后执行：

```bash
bun test tests/daemonBridge.test.ts tests/sdkRemoteControl.test.ts tests/perpetualBridge.test.ts tests/cloudPersistence.test.ts
bun run typecheck
bun test
```

回滚顺序为先恢复 SDK remote-control 边界，再回滚 Cloud 关联与 Files 分页，最后移除 daemon 队列。不得用空 handle、跳过权限应答或接受漏页结果来通过集成检查。
