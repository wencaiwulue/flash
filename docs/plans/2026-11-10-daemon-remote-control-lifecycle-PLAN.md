---
commit: d2fafcde7d75171be093fd40ec8d954c0f326d21
title: Daemon 与 remote-control server 的实施顺序
date: 2026-11-10
retrospective: true
---

# Daemon 与 remote-control server 的实施顺序

## 1. 先实现 remote-control server 单例

**文件：** `src/commands/remoteControlServer/server.ts`。

实现 pendingInput：next() 在 closed 时立即 done，否则等待 wake；return/close 设置 closed 并唤醒。启动时先创建 query，再 enable(true)，catch 中 close input 并 return query。

成功后保存 query、closeInput、info、done、finish 和 unregisterCleanup。重复 start 只返回 running.info。stop 先清 running，再依次 disable、close、return，finally 调用 finish；cleanup registry 的 unregister 必须在 stop 中执行。

**测试：** 用注入 createQuery 覆盖重复 start、enable 失败、stop 顺序和 waitForRemoteControlServer。

## 2. 实现可注入的 supervisor

**文件：** `src/daemon/supervisor.ts`。

`DaemonSupervisor` 只依赖 spawn 和可选 maxRestarts/baseDelayMs/maxDelayMs/wait。每次 spawn 后用 Promise 等待 error/exit；正常 0 结束，stopping 不重启，异常按 `min(maximum, base * 2 ** restarts)` 延迟。超过重启上限抛出 kind 和最后错误，finally 恢复 running/active。

**测试：** `tests/daemon.test.ts` 用 fake child 控制 error/exit，用注入 wait 记录 1000/2000/4000 等间隔，覆盖五次上限、重复 run 和 stop。

## 3. 实现 PID registry 与 daemon 命令

**文件：** `src/daemon/main.ts`。

recordPath 清理 kind 文件名；readRecord 校验正整数 pid；isAlive 用 `process.kill(pid,0)`。start 对存活记录幂等，对 stale 先 unlink；detached spawn 后 unref，registry 写失败立即 SIGTERM。stop 先删除记录，再按存活状态决定是否 SIGTERM。

`runForeground()` 用 supervisor 启动 `--daemon-worker <kind>`，注册 SIGINT/SIGTERM，并在 finally 移除 listeners。`daemonMain()` 实现 start/run/stop/status 和 usage 错误。

**测试：** 在临时 registryDir 检查 0600、stale 清理、重复 start、stop 和写失败回收。

## 4. 连接 worker kind 与 feature

**文件：** `src/daemon/workerRegistry.ts`。

assistant 和 remote-control 都执行 startRemoteControlServer → waitForRemoteControlServer；依赖可注入。undefined 和未知 kind 抛错。`scripts/build.ts` 只添加 `DAEMON`，feature fixture 同步检查 daemon/worker 入口。

运行：

```bash
bun test tests/daemon.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除 worker 注册和 daemon 命令，再回滚 supervisor 与 server。不得通过永不退出的 fake wait、吞掉 enable 错误或保留 stale PID 来制造成功状态。
