---
commit: d2fafcde7d75171be093fd40ec8d954c0f326d21
title: Daemon supervisor 与 remote-control server 生命周期
date: 2026-11-10
retrospective: true
---

# Daemon supervisor 与 remote-control server 生命周期

## 进程模型

该提交把 daemon 分为三层：

1. `daemonMain()` 提供 start/run/stop/status；
2. `DaemonSupervisor` 在前台守护 worker，处理异常退出与退避重启；
3. `runDaemonWorker()` 启动 remote-control server 并等待其结束。

start 使用当前 Bun executable 和 CLI script 启动 detached、stdio ignored 的子进程，再 unref。registry 记录 kind/pid/startedAt，目录 0700、文件 0600。写记录失败必须 kill 子进程，避免无登记 daemon。

status 和 stop 都先检查 pid 是否存活；stale record 被删除。start 遇到存活记录直接复用，防止同 kind 重复启动。

## Supervisor 重启规则

`DaemonSupervisor.run()` 同时只允许一个运行实例，并在每次运行时重置 restarts：

- 每次 spawn 后等待 error 或 exit；
- stopping 时返回当前退出码，不再重启；
- 正常 code 0 直接结束；
- 非零或 error 按 1s、2s、4s…指数退避，默认上限 30s；
- 默认最多重启 5 次，超过后抛出最后错误；
- finally 清理 running/active。

stop 只设置 stopping 并向 active worker 发 SIGTERM，不伪造退出结果。

## Remote-control server

`startRemoteControlServer()` 用 pending async input 创建 SDK query，再调用 `enableRemoteControl(true)`。启动失败会关闭 input 并 `query.return()`；成功时缓存 running server、done Promise 和 cleanup unregister。重复 start 返回已有 info。

`stopRemoteControlServer()` 先摘除 running，随后 disable、close input、return query，并在 finally resolve done。`waitForRemoteControlServer()` 只等待这个 done，不依赖 worker 进程是否仍有其他活动。

assistant 与 remote-control 两种 worker kind 共用 start/wait；未知 kind 和缺失 kind 明确报错。构建新增 `DAEMON`。

## 验收标准

1. start/status/stop 正确处理存活、stale、重复 start 和 registry 写失败。
2. supervisor 验证正常退出、异常退避、重启上限、重复 run 和 stop 后不再重启。
3. server 重复 start 幂等，enable 失败清理 query，stop 顺序与 done/wait 一致。
4. `daemon.test.ts` 使用 fake child/server query 覆盖 PID 记录、restart、enable/disable、stop 和未知 worker kind。
