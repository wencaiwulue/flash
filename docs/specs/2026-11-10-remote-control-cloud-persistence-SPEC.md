---
commit: 02bc3c2efcd3f3d7978da33b2683e9d392f3220c
title: env-less remote control 与 Cloud Files 持久化设计
date: 2026-11-10
retrospective: true
---

# env-less remote control 与 Cloud Files 持久化设计

## 1. Remote-control 分层

该提交把远程控制拆成两层：daemon bridge 负责传输与队列，SDK controller 负责 query 控制、权限请求和停止语义。

### daemonBridge

`connectDaemonBridge()` 为 inbound prompt、control request、permission response 各建一个 `AsyncQueue`。队列按 push 顺序交付；空队列等待 waiter，close 唤醒全部 waiter并结束迭代。

`initEnvLessBridgeCore()` 的回调直接写入这些队列。`initialize` 控制请求留给核心处理并返回 false，其他控制请求进入 SDK 队列并返回 true，避免核心与 SDK 同时应答。401 回调先刷新 OAuth，再允许核心重建。

teardown 通过缓存 Promise 保证只执行一次：先 teardown core，再在 finally 关闭三个队列，使所有 async generator 都能退出。

### sdkRemoteControl

`startSdkRemoteControl()` 启动四条独立任务：

- output：把 SDK query 消息写入 handle，结束后 sendResult；
- inbound：把远端 prompt 转为 SDKUserMessage 并 push 到本地 channel；
- control：处理 interrupt、set_model、set_max_thinking_tokens、set_permission_mode，并按 request_id 返回 success/error；
- permission：按 request_id 匹配 pending 权限 Promise，校验 allow/deny 结果并转换为本机 PermissionDecision。

权限请求先注册 pending，再发送 `can_use_tool`；响应错误会 reject，未知 request_id 或非法 payload 被忽略。停止时不 await 会反向调用自身 stop 的 `query.return()`，随后并行 teardown/interrupt，再等待四条任务收尾并拒绝全部 pending，避免自等待死锁。

## 2. Files API 分页

`listFilesCreatedAfter()` 使用 `after_created_at`，当 `has_more` 为真时以本页最后一个 id 作为 `after_id`：

- 本页没有下一游标时抛错；
- 游标重复时抛错；
- 每次重试和 sleep 都传递 AbortSignal；
- 401/403 立即失败，网络与 5xx 进入既有指数退避。

只有遍历完所有页才返回 metadata，防止调用者把漏页误判为上传缺失。

## 3. Cloud 文件关联

Cloud 模式不由本地上传文件 ID，而是把本地 outputs 与 Files API metadata 关联：

1. 将本地路径转为 POSIX relative path，拒绝绝对路径、drive path、NUL、目录和 `..` 逃逸。
2. 用 lstat 排除目录与 symlink，记录本地 size。
3. 每轮列出全部远端文件，只索引 pending 中的规范路径。
4. `metadataByPath` 保存 path→fileId→sizes，`pathsById` 检查同一 ID 是否跨多个输出路径。
5. 同 path 多 ID 或同 ID 多 path 都标记 Ambiguous；重复的同 path/ID 副本可接受。
6. 有有限 remote size 时，至少要有一个等于本地 size；没有 size 时不据此否决。
7. 唯一匹配后写入 files 并移出 pending；最多三轮索引轮询，未匹配项进入 failed。

列表失败使剩余 pending 全部失败；任一取消检查命中时返回空 files/failed，不发布取消前的部分关联结果。

## 验收标准

1. 三类远端事件分别进入 FIFO 队列，initialize 不被 SDK 重复处理，teardown 能唤醒并结束所有迭代器。
2. 控制请求按 request_id 应答，权限 allow/deny/error 映射正确；stop 幂等且无自等待，pending 全部 reject。
3. 缺游标、重复游标、401/403、重试和 abort 都符合 Files API 契约，漏页结果不可返回。
4. 路径规范化、symlink 排除、重复/冲突 metadata、size mismatch、索引重试和取消行为均由 `cloudPersistence.test.ts` 覆盖。
5. fake transport 测试覆盖 SDK controller 与 daemon bridge，不把类型或队列存在等同于真实远端协议可用。
