---
commit: 809351a35c47c5a21edb76a1b8e88b1512cfc1ff
title: "Implement UDS inbox and peer discovery"
date: 2026-11-10T19:59:18+08:00
status: implemented
kind: component
---

# 实施计划：Implement UDS inbox and peer discovery

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要让同一台机器上的独立 Claude Code 会话拥有可寻址的文本 inbox，并能发现仍然在线的对端。实现既要处理 socket 文件残留、分帧、超时和退出清理，也要让 session ID 与直接 socket 路径得到一致路由；发现结果不能仅由陈旧 JSON 文件决定。收到的文本必须进入现有 prompt queue，并唤醒没有队列订阅者的 headless 消费循环，同时保持跨会话 SendMessage 只传纯文本的边界。该提交的在线证据范围是本机真实 UDS round trip，不是远程传输或真实模型消费注入提示的证明。

- 确认父提交的 udsMessaging、udsClient 与 /peers 都是不可用桩，ListPeers 和 registry 尚不存在，不能误把预留调用点当作已工作功能。
- 确认 setup.ts 已在 UDS_INBOX 下启动服务，print.ts 已预留 headless setOnEnqueue，SendMessageTool/peerAddress 已能将纯文本 uds 目标送到客户端。
- 确认 tools.ts 与 commands.ts 已预留条件注册，构建只需开启同一 UDS_INBOX，不需要修改这些复用文件。
- 确认 getSessionId、getIsNonInteractiveSession、getClaudeConfigHomeDir、enqueue 与 registerCleanup 的现有契约足以承载身份、目录、队列和退出生命周期。
- 测试应使用临时 socket/registry 路径并 resetCommandQueue，避免污染真实用户 registry；证据计划区分真实本地传输、headless 唤醒计数和模型在线处理。

## 复用与兼容处理

### 复用现有实现

- 复用 node:net 的 createServer/createConnection 和 fs/promises 的目录、权限、原子 rename 与 unlink 能力，不引入新的网络或数据库依赖。
- 复用 setup 的默认/显式路径选择、bare 模式门控和 SessionStart 前 await 启动语义。
- 复用 SendMessageTool 的纯文本限制、parseAddress 地址空间和错误结果映射，使新 client 成为现有路由的后端。
- 复用 messageQueueManager.enqueue、print.ts 的 run 互斥/重查和 cleanupRegistry 的优雅退出机制。
- 复用 bootstrap session/kind 与 envUtils 配置目录，保证 pong、registry 和默认 socket 使用同一会话身份。
- 复用 buildTool、Zod、Command、tools.ts/commands.ts 条件注册及独立 Bun 特性夹具，不添加平行观察框架。

### 兼容、迁移与生命周期

- 保留 startUdsMessaging(socketPath,{isExplicit}) 的原调用形态，仅新增可选 registryDir，既有 setup 不需要传入测试目录。
- UdsLiveSession 从 udsRegistry 定义并由 udsClient 再导出，原客户端导入路径继续可用，同时补齐实时记录所需 socketPath/pid。
- 保留 SendMessage 的 uds: 和裸 POSIX 绝对路径解析，新增 session ID 解析只发生在 sendToUdsSocket 内，不把裸队友名称全局改成 UDS 地址。
- 跨会话仍只接受字符串 message；UDS 分支沿用 summary 非必需和结构化消息拒绝规则，不改变 bridge 或进程内队友路由。
- setOnEnqueue 保持原布尔契约，但 server 活动时由固定 false 改为可注册 true；stop 后恢复 false，符合 headless 既有调用方式。
- ListPeers 与 /peers 只增加观察入口，实时发现不改变消息内容；外部工具数从 33 增至 34 是开启 UDS_INBOX 后的预期差异。
- 本提交没有文件重命名，所有生产变更在既有桩位置或新增 ListPeers/udsRegistry 模块内完成。

## 文件级实施步骤

### 1. 建立私有 registry 与条件注销基础

先在 udsRegistry.ts 定义带 socketPath 的 UdsLiveSession 和配置目录定位，以净化 session ID 生成 JSON 文件名。随后实现 0700 目录、0600 临时文件和 rename 注册，读取时筛选必要字段；注销必须重读并比较 socketPath，为后续 server teardown 与 stale cleanup 提供不会误删替换实例的基础操作。

涉及位置：`src/utils/udsRegistry.ts`

### 2. 实现 UDS server、分帧 inbox 与生命周期

在 udsMessaging.ts 实现默认每用户每会话地址、活动单例和显式路径校验，启动前区分活动与陈旧 socket。listen 后落实 0600、registry 登记、失败回滚和 cleanup 注册；连接处理器依次完成有界缓冲、换行/CR 分帧、ping/pong、message 提取、空消息错误、prompt 入队和唤醒。最后统一停止连接、server、回调、registry 与 socket 文件。

涉及位置：`src/utils/udsMessaging.ts`

### 3. 实现实时发现与双形式客户端路由

在 udsClient.ts 先实现带 settled 收口、超时、64 KiB 响应限制和首行 JSON 解析的 requestUds，再构造 pingUdsSession。listAllLiveSessions 并行验证 registry 项并清理不匹配或离线记录，合并 pid 后排序；sendToUdsSocket 最后接入直接路径与 session ID 解析、2 秒发送超时及 ok/error 检查，形成供既有 SendMessage 使用的完整客户端。

涉及位置：`src/utils/udsClient.ts`

### 4. 接通模型与用户的 peer 观察面

新增 ListPeersTool，以严格空输入、结构化输出、只读和并发安全属性调用统一发现函数，同时给出 uds:<sessionId> 与绝对路径的 SendMessage 提示。随后把 /peers 从禁用占位改为 enabled、支持非交互的文本列表，两个入口共享空结果、kind 回退和实时排序语义。

涉及位置：`src/tools/ListPeersTool/ListPeersTool.ts`、`src/commands/peers/index.ts`

### 5. 启用外部特性并固定编译注册契约

在正式 build.ts 和独立 verify-enabled-features.ts 夹具同时加入 UDS_INBOX，使预留 setup、SendMessage、tools 和 commands 分支进入相同构建。夹具导出 hasPeersCommand，组合特性测试把 toolCount 更新为 34、保持 nullCount=0，并加入 ListPeers 与 peers 注册断言，防止只实现源码却未进入产物。

涉及位置：`scripts/build.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 6. 以真实本地 socket 覆盖投递、发现和清理

新增 udsMessaging.test.ts，在每个用例建立临时 socket/registry 并重置队列。主用例启动真实 server，检查 0600 和活动路径，注册 wakeups 后分别按路径与 session ID 发送，核对两个 prompt、实时记录及 pid；stop 后检查回调失效、registry/socket 删除和发送失败。第二用例制造缺失 socket 的有效记录，验证列表清理与未知 peer 拒绝，全程不使用网络或模型 mock 来替代 socket。

涉及位置：`tests/udsMessaging.test.ts`

### 7. 记录历史执行结果与未覆盖边界

最后更新 STATUS 的全量 85 tests/368 assertions、34 非空工具和 UDS real-local-socket 能力行，并从后续实现顺序中移除已完成的 UDS 项；RELEASE 新增 UDS inbox and peer sessions，记录同一测试总数、真实本地 round trips、typecheck、build、declarations 和 34-tool profile。文档只覆盖实际执行范围，不补写独立进程、Windows 或真实模型消费结果。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 直接 unlink 已存在 socket 可能破坏活跃 peer；启动前的 ping 和活动路径拒绝降低该风险，但客户端超时仍意味着失败而非假定离线。
- 旧实例 teardown 可能删除同 session ID 的新 registry；注销前重读并比较 socketPath，同时 pong ID 必须与记录一致。
- chunk 分片、多帧粘连和 CR 可能破坏解析；每连接缓冲循环逐行提取，空帧跳过，累积超限则销毁连接。
- 慢 peer 或永不换行的响应会占用调用方；ping 300 ms、send 2000 ms、客户端 64 KiB 上限和 settled destroy 提供确定失败出口。
- 仅按 registry 返回会暴露离线或错身份 peer；列表必须实时握手并清理失败项，session ID 发送也复用该列表而非直接读文件。
- 模块级单例与连接集合若清理不完整会污染后续启动或测试；stop 先重置活动状态，再关闭资源并反注册 cleanup，测试 afterEach 再调用 stop 保持幂等。
- 收到文本即成为 prompt 具有本机注入敏感性；0600/0700 权限限制 POSIX 访问面，ok 只表示入队，不能解释为内容可信或模型已执行。

## 验收顺序

1. 运行真实 UDS 主回归，核对 stat mode&0777 为 0600，路径和 session ID 两次发送产生按序队列值及两次 wakeups。
2. 检查 listAllLiveSessions 返回当前 sessionId、socketPath 和 process.pid，并确认 pong 的 kind 来自交互状态。
3. 执行 stop 后核对活动路径为空、setOnEnqueue=false、registry 为空、socket stat 失败以及 after-stop 发送拒绝。
4. 用随机 stale ID 和缺失 socket 构造有效 registry 项，确认发现返回空、文件被清理且发送错误包含 Unknown or offline UDS peer。
5. 构建独立特性夹具并读取真实输出，验证 UDS_INBOX、34 个非空工具、ListPeers 和 hasPeersCommand；同时运行类型检查与完整构建。
6. 引用 at-commit STATUS/RELEASE 的 85 tests、368 assertions、零类型错误、CLI/SDK/declarations build 与 real local socket round trips，不把本次静态记录校验改写成历史命令结果。
7. 若扩大验收范围，分别在独立进程和 Windows named pipe 环境重跑发现/投递，并增加分片、超限、malformed、超时及真实模型消费测试；这些不属于本提交已记录结果。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 私有 registry 的 0700/0600、原子写入、结构读取与 socketPath 条件注销已经实现。
- UDS server 的默认/显式地址、活动冲突检测、陈旧 socket 替换、0600 与启动失败回滚已经实现。
- 有界换行分帧、ping/pong、普通文本/message 信封、空消息错误和 prompt queue 唤醒已经接通。
- 客户端超时与响应上限、实时身份核对、stale cleanup、排序发现及路径/session ID 投递已经实现。
- 连接、server、cleanup、回调、registry 与 POSIX socket 的统一 teardown 已经形成闭环。
- ListPeers 和 /peers 已提供一致实时视图，UDS_INBOX 已进入正式与测试外部构建。
- 真实本地 socket 和 stale registry 回归已加入，特性档固定为 34 个非空工具；at-commit 文档记录 85/368 及构建结果。

### 未完成或后续工作

- 独立进程并发、Windows named pipe 与真实模型消费没有 at-commit 执行证据。
- oversize、分片/合帧、 malformed 响应和超时分支尚无对应的专项测试记录。
- 字符串 length 与严格字节上限存在非 ASCII 计量差异，本提交未调整该实现。
- 格式损坏的 registry 文件只被忽略，不会像可解析的离线记录一样被 listAllLiveSessions 删除。
