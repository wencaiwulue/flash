---
commit: 809351a35c47c5a21edb76a1b8e88b1512cfc1ff
title: UDS inbox 与 peer 发现的实施顺序
date: 2026-11-10
retrospective: true
---

# UDS inbox 与 peer 发现的实施顺序

## 1. 实现原子 registry

**文件：** `src/utils/udsRegistry.ts`。

registry 目录使用 0700，session 文件名只保留字母数字、下划线和连字符。注册先写 `${path}.${pid}.tmp`（0600），再 rename。读取时过滤非 JSON、缺 sessionId/socketPath 的记录；注销只有当前记录的 socketPath 与调用者相同才 unlink。

**验收：** 在临时 config dir 检查原子替换、畸形文件、身份不匹配不删除和目录权限。

## 2. 实现 server 分帧与生命周期

**文件：** `src/utils/udsMessaging.ts`。

每连接独立维护 buffer，按换行提取 frame，超过 1 MiB 立即 destroy。handleFrame 依次处理 ping、JSON message、普通文本和空消息；有效消息进入 `enqueue({mode:'prompt',priority:'later'})` 后才写 ok 并调用 onEnqueue。

启动流程：路径长度检查 → mkdir 0700 → 旧 socket ping/清理 → listen → chmod 0600 → register → server.unref/registerCleanup。任一步失败都进入 stop。stop 幂等清理 activeServer/activePath/registryDir、connections、registry 和 socket 文件。

## 3. 实现 client 与 peer 发现

**文件：** `src/utils/udsClient.ts`。

`requestUds()` 用统一 settled 防止 timeout/data/error/close 重复完成；只解析首个换行前的 JSON，响应超过 64 KiB 或无响应关闭都报错。

`listAllLiveSessions()` 并发 ping，校验 pong.sessionId 与 registry 一致，清理 stale 并排序。`sendToUdsSocket()` 先区分直接路径和 sessionId，再发送消息并要求 `ok===true`。

## 4. 接入 ListPeers 与构建

`ListPeersTool` 只调用 listAllLiveSessions 并格式化 sessionId/kind/pid/socketPath；`/peers` 复用同一来源。`scripts/build.ts` 只添加 `UDS_INBOX`，feature fixture 同步检查命令和工具注册。

**端到端验收：** `tests/udsMessaging.test.ts` 使用临时 socket 和 registry，覆盖：

- ping/pong 与 interactive/headless kind；
- 普通文本入队、唤醒和 ok 响应；
- 空消息、连续 frame、超限连接；
- stale socket 清理与活跃 socket 拒绝；
- sessionId 寻址、离线 peer、teardown 清理。

```bash
bun test tests/udsMessaging.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

不要用公网监听替代本机 UDS，也不要仅依据 registry JSON 就宣称 peer 在线；必须通过 ping 身份核对。
