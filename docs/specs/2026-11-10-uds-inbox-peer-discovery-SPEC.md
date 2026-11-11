---
commit: 809351a35c47c5a21edb76a1b8e88b1512cfc1ff
title: "Implement UDS inbox and peer discovery"
date: 2026-11-10T19:59:18+08:00
status: implemented
kind: component
---

# Implement UDS inbox and peer discovery

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交中的 UDS 边界仍是禁用桩：startUdsMessaging 与 sendToUdsSocket 直接抛出 unavailable，getDefaultUdsSocketPath 不能生成地址，listAllLiveSessions 固定返回空数组，/peers 被禁用且没有 ListPeers 工具或注册表实现。setup、headless print 循环、SendMessage、tools.ts 与 commands.ts 已经预留 UDS_INBOX 分支，但外部构建未开启该标志，特性档仍只有 33 个工具。因此本提交需要补齐真正的本地 socket 生命周期、发现与投递链，而不是只把一个命令改成可见。

需要让同一台机器上的独立 Claude Code 会话拥有可寻址的文本 inbox，并能发现仍然在线的对端。实现既要处理 socket 文件残留、分帧、超时和退出清理，也要让 session ID 与直接 socket 路径得到一致路由；发现结果不能仅由陈旧 JSON 文件决定。收到的文本必须进入现有 prompt queue，并唤醒没有队列订阅者的 headless 消费循环，同时保持跨会话 SendMessage 只传纯文本的边界。该提交的在线证据范围是本机真实 UDS round trip，不是远程传输或真实模型消费注入提示的证明。

## 目标与非目标

### 目标

- 在每会话默认路径或显式路径上启动单例 UDS server，处理活动 socket 冲突、陈旧文件、0600 权限及完整 teardown。
- 以换行分帧同时承载普通文本和 JSON 控制帧，提供 ping/pong、空消息错误、有界缓冲与请求超时。
- 建立私有 per-session registry，原子写入记录，并在注销时避免误删同 ID 但已更换 socket 的新记录。
- 通过实时握手列出在线 peer，核对 pong 的 session ID，清理失效记录，并支持按路径或 session ID 投递。
- 将收到的文本以 later 优先级送入既有 prompt queue，在成功入队后触发 headless 唤醒回调。
- 提供只读 ListPeers 与可非交互调用的 /peers，两者展示 session、kind、UDS 地址和 socket 路径；可用的 pid 仅由 ListPeers 的结构化 peers 数据提供，/peers 文本及 ListPeers 的紧凑文本不显示 pid。
- 在外部构建启用 UDS_INBOX，将特性档更新为 34 个非空工具，并用真实本地 socket 回归和 at-commit 文档固定证据。

### 非目标

- 不实现 TCP、跨机器发现或 Remote Control bridge 协议；本组件只处理本机 UDS 与 Windows named pipe 地址分支。
- 不允许结构化跨会话消息、广播或队友邮箱语义替代现有 SendMessage 规则，UDS 投递载荷仍是纯文本。
- 不把 registry 当作持久在线状态数据库；列表必须经过 ping/pong，离线记录应被移除而非返回。
- 不新增 headless 查询循环、队列存储或模型调用逻辑，唤醒仍复用 print.ts 中既有 run 的互斥与重查机制。
- 不宣称测试中的 wakeups 计数或队列快照证明真实模型已经处理消息，也不把这些本地测试扩展解释为 Windows 或多进程实测。
- 不重构既有 setup、SendMessage、工具注册和清理框架；它们作为已存在且由特性开关控制的复用边界。

## 方案架构与数据流

服务生命周期由 udsMessaging.ts 的模块级 activeServer、activePath、activeRegistryDir、connections 和 onEnqueue 共同维护。默认 POSIX 地址位于 tmpdir，名称包含 userInfo().uid 与 session ID 前八位；Windows 使用对应 named pipe 名称，显式路径仍由 setup 原样传入。同一地址重复启动是幂等操作，不同地址在已有 server 时明确报错，非 Windows 路径还按 UTF-8 字节数限制在 100 字节以内。启动前创建 0700 父目录，已有路径先做 ping：仍有响应则拒绝抢占，无响应才 unlink 陈旧 socket。

net.createServer 为每条连接维护独立字符串缓冲区，从 data chunk 中循环提取换行前的帧并去掉末尾 CR，因此一个 chunk 中的多帧和跨 chunk 的单帧共用同一路径；空帧被略过。累积字符串长度超过设定上限时销毁连接，名义帧上限为 1 MiB；等于该值本身不会触发限制。JSON 对象 {type:"ping"} 返回含当前 sessionId 及 headless/interactive kind 的 pong，不进入 prompt queue；{type:"message",message:string} 提取其 message，其他帧包括无法解析为 JSON 的文本都按原文处理。空消息得到 {ok:false,error:"Empty message"}，有效文本则 enqueue({mode:"prompt",priority:"later"})，先写 {ok:true} 再调用 onEnqueue。

listen 成功后先把 server、路径和 registryDir 写入活动状态，再在非 Windows 平台 chmod(socketPath,0600)，最后登记 sessionId、kind、socketPath 与 pid。chmod 或注册失败会立即进入 stopUdsMessaging，避免留下半初始化服务。正常路径执行 server.unref 并向 cleanupRegistry 注册停止函数。停止时先清空活动引用和回调、注销 cleanup，再销毁全部连接并等待 server.close；随后按 session ID 与 socket 路径条件注销 registry，非 Windows 还尽力删除 socket 文件，因此显式 stop 与优雅退出共享同一收口。

udsRegistry.ts 将记录放在 getClaudeConfigHomeDir()/uds，目录以 0700 创建。文件名只保留字母、数字、下划线与连字符，其他 session 字符替换为下划线；写入采用同目录 <file>.<pid>.tmp 加 rename，记录文件模式为 0600，避免读取者看到部分 JSON。读取仅接受 sessionId 与 socketPath 都是字符串的 .json 记录，缺失目录、无效 JSON 和结构不合格项被忽略。注销先重读当前记录，只有 current.socketPath 与调用者路径一致才 unlink，从实现上降低旧实例停止时删除新实例记录的风险。

客户端 requestUds 对每次请求建立独立连接，连接后写入 payload 加换行，只解析首个换行前的 JSON 响应，并以 settled 统一超时、error、close 和成功后的 destroy。ping 默认超时 300 ms，send 超时 2000 ms，响应累积字符串超过 64 KiB、 malformed JSON 或无响应关闭都会失败。pingUdsSession 只接受 type=pong 且 sessionId 为字符串的响应，并附加实际 socketPath；listAllLiveSessions 并行探测所有记录，pong ID 与记录 ID 不一致或探测失败时按原路径注销，成功项合并 registry 中的 pid，最后按 session ID 排序。

sendToUdsSocket 将以 / 或两个前导反斜杠（\\）开头的目标直接视作 socket 地址，其他目标视作 session ID，先经过实时发现解析为路径；不存在或离线时抛出 Unknown or offline UDS peer，发送后还要求响应 ok===true，并优先透传对端 error。既有 peerAddress 与 SendMessageTool 支持 uds:<target> 和裸 POSIX / 开头路径；裸 Windows named pipe 不会被 parseAddress 识别为 UDS，经 SendMessageTool 投递时必须保留 uds: 前缀。ListPeers 提示同时给出 uds:<sessionId> 和 POSIX 绝对路径形式。由此 registry 只承担发现索引，最终投递仍由目标 server 的实时响应确认。

观察面共享 listAllLiveSessions：ListPeersTool 用严格空输入和结构化 peers 输出声明只读、并发安全语义，为模型提供地址提示及紧凑文本结果；/peers 改为 enabled 且 supportsNonInteractive=true，以相同数据生成人类可读列表，空结果显示 No live UDS peer sessions。build.ts 与独立特性夹具加入 UDS_INBOX 后，既有 tools.ts/commands.ts 分支才加载这些入口。headless print.ts 的既有 setOnEnqueue 回调在 input 未关闭时调用 run()，其 run 互斥和结束重查负责活跃 turn 与空闲等待两种情形，本提交不另建消费者。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/RELEASE.md`，符号 `## UDS inbox and peer sessions` | 记录真实本地 socket round trip、85/368、类型检查、构建、声明与 34 工具特性档的历史结果。 |
| 变更 | `docs/STATUS.md`，符号 `\| UDS inbox and peers \| Verified (real local socket) \|` | 将 UDS 能力按实际测试范围列为本机 socket 已验证，并更新全量测试及工具池计数。 |
| 变更 | `scripts/build.ts`，符号 `'UDS_INBOX'` | 在外部 Bun 构建特性列表中启用预留的 UDS server、SendMessage、工具与命令分支。 |
| 变更 | `src/commands/peers/index.ts`，符号 `const peers` | 把禁用占位命令改为可非交互调用的实时 peer 列表，并提供 UDS session 地址和 socket 路径。 |
| 变更 | `src/tools/ListPeersTool/ListPeersTool.ts`，符号 `export const ListPeersTool` | 新增严格空输入、只读且并发安全的 ListPeers，输出结构化实时 peer 并提示两种发送地址。 |
| 变更 | `src/utils/udsClient.ts`，符号 `export async function listAllLiveSessions` | 实现有界单响应请求、ping、pong 身份核对、stale 清理、排序发现和路径/session ID 投递。 |
| 变更 | `src/utils/udsMessaging.ts`，符号 `export async function startUdsMessaging` | 实现默认路径、单例 UDS server、0600、换行帧、ping/pong、prompt 入队唤醒和幂等 teardown。 |
| 变更 | `src/utils/udsRegistry.ts`，符号 `export async function registerUdsSession` | 新增配置目录下的私有 per-session JSON 注册表、原子写入、结构筛选和路径条件注销。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.toolCount` | 把外部特性档固定为 34 个非空工具，并增加 ListPeers 与 peers 命令注册断言。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `hasPeersCommand` | 在独立编译夹具中启用 UDS_INBOX，并导出 peers 命令是否进入真实构建产物。 |
| 变更 | `tests/udsMessaging.test.ts`，符号 `test('serves real UDS prompts, peer discovery, and teardown'` | 新增临时目录中的真实 socket 双向 round trip、0600、双路由、队列唤醒、发现、stale 与 teardown 回归。 |
| 复用 | `src/setup.ts`，符号 `startUdsMessaging` | 复用既有启动门控、bare 模式逃逸口和显式 messagingSocketPath 传递，不在本提交修改启动流程。 |
| 复用 | `src/cli/print.ts`，符号 `setOnEnqueue` | 复用 headless 既有回调，将 UDS 入队事件转为 run()，依靠原互斥和末尾重查处理排队项。 |
| 复用 | `src/tools/SendMessageTool/SendMessageTool.ts`，符号 `addr.scheme === 'uds'` | 复用既有纯文本跨会话校验、uds 路由与成功/失败结果映射，不添加结构化 UDS 消息。 |
| 复用 | `src/utils/peerAddress.ts`，符号 `export function parseAddress` | 复用 uds: 与裸 POSIX 绝对路径解析，保持队友和 bridge 地址空间不变。 |
| 复用 | `src/utils/messageQueueManager.ts`，符号 `export function enqueue` | 复用现有命令队列、later 优先级和订阅通知，测试也复用其快照与重置接口。 |
| 复用 | `src/utils/cleanupRegistry.ts`，符号 `export function registerCleanup` | 复用优雅退出清理注册及反注册句柄，使显式停止不会留下重复 cleanup。 |
| 复用 | `src/bootstrap/state.ts`，符号 `export function getSessionId` | 复用当前会话 ID 和交互模式状态，生成地址、pong 身份、kind 与 registry 记录。 |
| 复用 | `src/utils/envUtils.ts`，符号 `getClaudeConfigHomeDir` | 复用用户配置目录定位，把 UDS registry 放在其 uds 子目录。 |
| 复用 | `src/tools.ts`，符号 `const ListPeersTool` | 复用已有 UDS_INBOX 条件加载及工具池展开位置，构建标志开启后纳入 ListPeers。 |
| 复用 | `src/commands.ts`，符号 `const peersCmd` | 复用已有 UDS_INBOX 条件命令加载，使命令实现与外部特性档保持一致。 |

## 关键决策与工程取舍

- 以文件系统 registry 作为跨进程发现索引，再以实时 pong 决定可见性，而不是直接相信 JSON 或扫描所有 socket；这样既提供 session ID 路由，也能在列表时清理失效项。
- 普通提示与 JSON 控制消息共用换行帧，而不是要求所有发送方构造信封；这匹配既有 SendMessage 的纯文本分支，同时保留 ping/pong 和可选 message 信封。
- 每个客户端请求使用短连接且只读取一个响应，不在本提交维护长连接复用或订阅协议；settled、超时和 destroy 因而成为统一的请求生命周期。
- 先 enqueue 再回复 ok 并触发唤醒，使发送成功表示文本已经进入本地队列，而不表示模型已完成处理；这一区分也限定了测试和发布证据的含义。
- 将 0600 socket、0600 registry 文件和 0700 目录放在生命周期实现中，而非依赖调用者预设权限；Windows 分支不伪造 POSIX chmod 结果。
- ListPeers 与 /peers 复用同一实时查询，不分别维护缓存或过滤规则，确保模型和用户的空列表、排序及 stale cleanup 一致。
- 通过现有 UDS_INBOX 构建开关接通预留集成，不改变 setup、SendMessage 或 headless run 的公共控制流；新增生产文件集中在协议、registry 和只读观察工具。

### 备选方案与回溯分析

- 回溯性比较：可以只扫描 tmpdir 中的 socket 或永久信任 registry，但前者无法稳定提供会话元数据，后者会把崩溃残留显示成在线。实际采用配置目录私有记录加实时握手，增加文件 I/O 与最多 300 ms 的单 peer 探测成本，换取可验证的 live view。
- 回溯性比较：可以把所有流量限定为严格 JSON RPC，从而获得更规整的协议；实际允许普通文本帧并仅识别 ping/message 控制对象，保留现有纯文本 SendMessage 调用方式，但也意味着其他 JSON 对象会按原文入队。
- 回溯性比较：可以为 UDS 另设持久长连接和消息订阅循环，减少每次建连开销；实际选择一次请求一次响应的短连接，并用现有 prompt queue 解耦发送与消费，协议更简单但没有服务端推送或连接复用。
- 回溯性比较：可以让 registry 路径直接决定删除目标，简化注销；实际在 unlink 前比较当前 socketPath，并核对 pong sessionId，付出额外读取与握手以避免陈旧实例或伪装响应污染发现结果。
- 回溯性比较：可以在 headless 中轮询 socket 数据或新增独立消息循环；实际复用 enqueue 与 setOnEnqueue 对既有 run 的触发，保持队列优先级、互斥和退出行为一致，但测试只能直接证明入队及回调发生。

## 安全与协议边界

- 非 Windows socket 在 listen 后显式设为 0600，registry 目录和文件分别以 0700/0600 创建；这些权限是本机访问边界，不被描述为远程认证机制。
- 默认地址包含 UID 与会话前缀，显式路径受长度检查；启动遇到现有路径时先探测活动 peer，避免为绑定新 server 直接删除仍在使用的 socket。
- registry 文件名净化 session ID，临时文件与目标位于同目录并原子 rename；条件注销比较 socketPath，降低跨实例清理误删。
- 服务端累积帧和客户端响应都有上限，ping/send 有独立超时，请求完成或失败会 destroy socket，减少慢连接与无界缓冲占用。实现使用 JavaScript 字符串 length 计数，不能将其解释为严格 UTF-8 字节计量。
- 只有 ping 被特殊处理，普通文本及非控制 JSON 都可能成为 prompt；因此信任边界仍是本机 socket 权限与调用者授权，不能仅凭消息外形把内容当作可信系统指令。
- Windows named pipe 路径没有在本提交中施加或验证 POSIX 权限，格式损坏的 registry 项也只被忽略；这些边界不由 0600 测试外推。

## 验收标准

- 默认或显式地址可启动一个真实 server；同址重复启动幂等，异址冲突与活动 socket 占用被拒绝，无响应的残留 socket 可被替换。
- POSIX socket 权限为 0600，非 Windows socket 路径按字节检查小于 100，registry 使用 0700 目录、0600 文件和原子替换。
- 连接缓冲能连续处理换行帧，去除 CR，超过帧上限会断开；ping 返回正确 sessionId/kind，空消息返回错误，普通文本和 message 信封进入相同 prompt 路径。
- 每次有效投递先产生 later 优先级的 prompt queue 项，再返回 ok 并调用已注册的唤醒回调；server 未活动时 setOnEnqueue 返回 false。
- 发现只返回 pong 有效且 session ID 匹配的记录，结果带 socketPath、可选 kind/pid 并稳定排序；离线或不匹配记录被注销，session ID 发送不会解析到它们。
- 直接路径发送与 session ID 发送都要求对端 ok=true；超时、超大或 malformed 响应、连接异常和对端拒绝均表现为失败，而非虚假成功。
- 停止后活动路径和回调被清空，连接与 server 关闭，匹配 registry 记录和 POSIX socket 文件被删除，之后发送失败。
- ListPeers 与 /peers 使用同一份实时结果并正确处理空列表；外部特性构建包含 UDS_INBOX、peers 命令和 ListPeers，非空工具总数为 34。
- 历史命令证据只用于说明本机 socket、离线回归和构建结果；真实模型处理、Windows named pipe 与独立进程场景没有据此标记为已验证。

## 实现状态与剩余范围

- 状态：**implemented**
- Windows named pipe 仅保留地址生成与跳过 POSIX chmod/unlink 的代码路径，本提交没有 Windows 权限或连接实测证据。
- 真实 socket 测试在同一进程启动 server/client，验证到队列快照和 wakeups 为止；多进程并发发现以及真实模型查询循环处理仍需独立验收。
- 帧上限、分片/合帧处理、响应 malformed/超限和 300/2000 ms 超时有实现，但新增两项 UDS 测试没有逐一覆盖这些分支。
- 缓冲上限使用 JavaScript 字符串 length 而非 UTF-8 byteLength，非 ASCII 内容的 1 MiB/64 KiB 名义限制不等于严格字节上限。
- 无法解析或缺少必要字段的 registry JSON 会在读取时忽略，却不会进入有效记录后的 stale 注销流程；清理保证针对可解析但离线的记录。
