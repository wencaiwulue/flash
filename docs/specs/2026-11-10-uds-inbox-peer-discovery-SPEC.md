---
commit: 809351a35c47c5a21edb76a1b8e88b1512cfc1ff
title: 本机 UDS 消息与 peer 发现设计
date: 2026-11-10
retrospective: true
---

# 本机 UDS 消息与 peer 发现设计

## 协议与生命周期

UDS server 以换行分帧，单连接缓冲超过 1 MiB 即断开。frame 优先尝试 JSON：

- `type:'ping'` 返回 pong、sessionId 和 interactive/headless kind；
- `type:'message'` 且 message 为字符串时投递该字符串；
- 其他内容按普通文本 prompt 处理。

空消息返回 `{ok:false}`；有效 prompt 进入现有 message queue 后返回 `{ok:true}`，再调用 onEnqueue 唤醒消费者。

默认地址由 uid 和 sessionId 前八位组成。POSIX 使用 tmpdir 下 `.sock`，目录 0700、socket 0600，路径必须小于 100 bytes；Windows 使用 named pipe。

启动时若 socket 已存在，先 ping：仍有活动 peer 就拒绝覆盖，无响应才 unlink。listen 成功后注册 session；注册失败必须停止 server。stop 先清空全局状态，再销毁连接、关闭 server、按 socketPath 条件删除 registry，最后删除 socket 文件。

## Registry 与发现

`udsRegistry.ts` 在 config home 的 `uds/` 下以清理后的 sessionId 命名 JSON。写入采用同目录临时文件加 rename，文件 0600；unregister 只有读到相同 socketPath 才删除，避免旧进程删除新注册。

`listAllLiveSessions()` 并发 ping registry 中的地址，只有 pong 的 sessionId 与记录一致才保留；离线或身份不符的记录被清理。结果按 sessionId 排序，并保留 pid/kind。

`sendToUdsSocket()` 接受绝对 socket 路径或 sessionId。sessionId 先从 live peers 解析，找不到则报 Unknown/offline。client 只读取首个换行前的 JSON 响应，限制 64 KiB，并有独立超时和“对端无响应关闭”错误。

## 验收标准

1. 分帧、CRLF、连续多帧、空消息、1 MiB 上限和 ping/pong 均正确。
2. 活跃 socket 不被覆盖，stale socket 可清理，注册失败与 stop 都完整释放连接、registry 和文件。
3. registry 原子写入、身份条件删除、离线清理和排序正确。
4. client 能解析 sessionId 与直接路径，检查 ok、超时、畸形 JSON、64 KiB 上限和无响应关闭。
5. `udsMessaging.test.ts` 使用本机临时 socket 覆盖真实入队、唤醒、寻址和 teardown；feature-profile 覆盖 UDS_INBOX 与 ListPeers 注册。
