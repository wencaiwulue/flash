import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'adaa8fffa7c7c536d782616f8f7e187de637a582',
  slug: 'env-less-perpetual-continuity',
  title: 'Implement env-less perpetual continuity',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交虽已支持非 perpetual 的 env-less Remote Control，但 initReplBridge 在 env-less gate 与 perpetual 同时开启时有意回退 env-based，以 bridge-pointer.json 和 Environments API 保持连续性。env-less core 每次启动都创建新 cse_*，没有保存会话 ID 或 SSE 高水位，teardown 总是发送 result 并 archive。ReplBridgeHandle 也没有显式 archive 操作。动态 Workflow 命令仍是 local-jsx，缺少 canUseTool 时直接拒绝，不能进入 local/noninteractive 命令路径。',
  problem:
    '需要在完全不使用 Environments API register/poll/ack/heartbeat 的 env-less 路径上实现可恢复的 perpetual：按 cwd 持久化 cse_* 与 SSE 序号，恢复时跳过创建，401 或主动刷新时在同一会话和序号上重建 transport，并区分暂时退出与永久归档。Workflow 命令还需在 headless 环境使用真实权限函数而不是 allow-all。验证只能通过 mock HTTP/transport 的隔离进程证明客户端控制流；当时没有 Claude OAuth，不能把 cse_test、固定序号 42 或直接触发 close(401) 说成真实服务端恢复。',
  goals: [
    '建立按项目目录隔离的 env-less 指针，保存 sessionId、lastSequenceNum、updatedAt，并提供 TTL、0600 写入和清除。',
    '让 env-less perpetual 有指针时复用同一 cse_* 和 SSE 高水位，无指针时才创建会话。',
    '在 401 与主动 JWT refresh 时串行重建 transport，保留 session ID、序号和写消息顺序。',
    '让普通 teardown 保留会话和指针，显式 archive 才发送 result、调用归档并清指针。',
    '把 Workflow 动态命令改为 local 且支持非交互，缺少上下文回调时使用 hasPermissionsToUseTool。',
    '用隔离子进程、真实临时指针文件和 mock transport 固定恢复、401、保留与归档，并保留 OAuth live 边界。',
  ],
  nonGoals: [
    '不把 env-less 解释为无服务器或无 OAuth；/v1/code/sessions、/bridge 和兼容 archive 仍需要服务端及凭据。',
    '不宣称 fixture 已完成真实跨进程服务端恢复；外层只启动一个 fixture 子进程，两次 init 都在其内部完成。',
    '不把固定 fake transport 的 getLastSequenceNum=42 或直接 close(401) 当作真实 SSE 帧和真实 OAuth 刷新。',
    '不承诺指针无限期存在；文件按 mtime 计算四小时 TTL，且写盘是 best-effort。',
    '不为 Workflow 提供绕过 deny/ask 的权限通道，也不在该提交新增其非交互专项单元测试。',
  ],
  architecture: [
    'envLessBridgePointer.ts 以 getProjectsDir、sanitizePath(cwd) 和 env-less-bridge-pointer.json 定位项目级指针，Zod 要求非空 sessionId、非负整数 lastSequenceNum 和数字 updatedAt。写入创建父目录并以 0600 作为新文件创建 mode，只保存会话 ID、序号和更新时间，不保存 OAuth token 或 worker JWT；既有文件权限不会被 chmod 重置。读取按文件 mtime 判断四小时 TTL，过期尝试删除，JSON/schema/IO 错误返回 null。写失败只记 debug：之后读不到有效指针时才新建会话，已有指针的写失败也不保证最新序号已保存；清除同样忽略 unlink 错误。',
    'initReplBridge.ts 删除 perpetual 的 env-based 强制回退，env-less gate 开启时普通与 perpetual 都进入 initEnvLessBridgeCore，并传 perpetual 和 getOriginalCwd。orgUUID、OAuth、最低版本和现有 REPL-only 边界仍在；gate 关闭时 env-based 实现保留。replBridge.ts 的公共句柄增加可选 archive，暂时 teardown 与永久归档由调用者显式选择。',
    'remoteBridgeCore.ts 启动时以 cwd ?? process.cwd() 定位指针。perpetual 且有有效指针时直接采用其 sessionId 和 lastSequenceNum，完全跳过 createCodeSession；perpetual 无有效指针才创建 cse_* 并在 /bridge 前写序号 0，非 perpetual 仍每次创建且不写指针。随后无论恢复或新建，都对同一 session 调 /bridge 获取 worker_jwt、epoch 和 api_base_url，再以 initialSequenceNum 创建 V2 transport。凭据/transport 初始化失败时仅对本次新建的会话发起 best-effort archive，不归档恢复来的旧会话，但也不会清除新建后已写的序号 0 指针。',
    '既有 createV2ReplTransport/SSETransport 负责把 initialSequenceNum 转成恢复游标并维护高水位，core 在新会话、writeMessages 和临时 teardown 时保存当前值。写指针不是每个 inbound frame 同步落盘，而是这些客户端事件点的 best-effort 快照。实例内 recentInboundUUIDs/recentPostedUUIDs 与 FlushGate 继续处理重放去重及历史 flush 顺序，持久游标与消息去重承担不同职责。',
    'SSE close(401) 进入 recoverFromAuthFailure，普通 transient 断线仍由 SSETransport 自己重连。authRecoveryInFlight 让 401 与主动 JWT refresh 互斥，竞争路径跳过本次恢复而不是排队等待，避免并发 /bridge 造成 epoch 竞争。两条路径都会先调用可用的 onAuth401 尝试刷新 OAuth，再取新 /bridge 凭据；rebuildTransport 启动 FlushGate 排队写消息，在关闭旧 transport 前读取序号，以旧 session ID、旧序号和新 JWT/epoch 重建，重接回调并 drain。401 恢复会复位 initialFlushDone，使被打断的 initial flush 能重新执行。',
    'teardown(final=false) 在 perpetual 暂时退出时取消刷新与连接 deadline、丢弃 flush gate、上报 idle、关闭 transport，并保存 sessionId/最后序号；它不写 result、不 archive、不清指针。返回句柄的 archive() 调 teardown(true)，发送 result、通过兼容 session ID 调 /v1/sessions/{id}/archive，401 时最多刷新重试一次，关闭 transport 后尝试清指针。清指针发生在 archive 尝试之后而不以 HTTP 成功为条件，unlink 失败也会被忽略；且该提交 src 中没有其他生产 archive 调用点，不能宣称 /exit 已自动永久归档。',
    'createWorkflowCommand.ts 将 type 从 local-jsx 改为 local，call 改为返回 text 结果并声明 supportsNonInteractive=true。它删除没有 context.canUseTool 就拒绝的门槛，改为 context.canUseTool ?? hasPermissionsToUseTool，再调用同一 startWorkflowTask。headless 过滤因此能保留命令，权限仍经过真实 deny/ask、工具 checkPermissions 和权限模式，而非自动允许；返回值只表示任务已启动，不等待 DAG 完成。',
    '测试由 envLessPerpetual.test.ts 启动一个独立 Bun fixture 子进程，fixture 用真实临时配置目录和指针文件、mock axios 与 transport 验证：首次创建一个 cse_test，普通 teardown 不归档，第二次 init 复用同 ID 且 create 数仍为一、initialSequenceNum=42；显式 archive 后指针为空。另一 cwd 中直接 close(401)，观察到第二次 /bridge 和同序号重建。perpetualBridge.test.ts 同步把路径选择断言改为 perpetual 也选 env-less。',
  ],
  decisions: [
    '持久化只保存 cse_* 和 SSE 序号，不保存 worker JWT/OAuth；恢复时重新通过 /bridge 获取短期凭据。',
    '指针按原始 cwd 隔离并设四小时 TTL，避免不同项目串用游标，同时明确 perpetual 不是无限期本地保留。',
    '有指针即跳过创建，而不是先创建再尝试 reconnect，保证同会话语义和 create 调用次数可验证。',
    '401 与主动刷新共用串行恢复和 FlushGate，避免并发 epoch bump 以及重建期间写消息越过历史顺序。',
    '把暂时 teardown 与显式 archive 分成两个句柄操作，防止进程清理意外终止仍需恢复的远端会话。',
    'Workflow 使用既有权限函数作为回退，不用无回调即允许的策略换取 headless 可执行性。',
  ],
  alternatives: [
    '回溯性比较：可以继续让 perpetual 回退 env-based，但无法消除 Environments API 依赖；实际为 env-less 增加独立指针和同会话恢复协议。',
    '回溯性比较：可以把 worker JWT 一并写入指针以减少 /bridge 调用，但会扩大磁盘凭据暴露并遇到 epoch 过期；实际只存 ID/序号并重新取短期凭据。',
    '回溯性比较：可以让普通 teardown 总是 archive 以简化生命周期，但会破坏 perpetual；实际新增显式 archive，将进程退出与永久结束分开。',
    '回溯性比较：可以用两个真实进程和真实 OAuth 服务做端到端测试，证据更强但当时无凭据；实际选择隔离 fixture，并清楚保留其单进程 mock 边界。',
  ],
  security: [
    'env-less 仍要求 OAuth token 和 orgUUID，/bridge 换取的 worker JWT 保存在 transport 闭包，不写入指针或进程级共享会话令牌。',
    '指针不含凭据，按 cwd sanitize 隔离，新文件创建 mode 指定为 0600，但重写不会修正既有文件权限；过期或损坏数据不会直接用于恢复。',
    '恢复来的会话在初始化凭据/transport 失败时不被自动 archive，避免客户端故障破坏既有远端工作。',
    '401/refresh 串行化防止并发 epoch 更新，恢复期间 FlushGate 控制写消息顺序，sendControl 在恢复中显式丢弃而非错发。',
    '显式 archive 的 401 最多刷新重试一次；清指针不等于服务端归档成功，忽略 unlink 错误也意味着本地指针可能仍存在，调用方仍需观察 archive 状态。',
    'Workflow 回退到 hasPermissionsToUseTool，继续执行实际权限规则，不为 noninteractive 建立 allow-all 旁路。',
    '离线 fixture 不包含真实凭据或服务端，不能证明 OAuth 授权、服务端游标语义、Cloud 或 Remote Control 在线行为。',
  ],
  acceptance: [
    '无指针的 perpetual 创建一次 cse_* 并写序号 0，有效指针存在时不再次调用 createCodeSession。',
    '第二次 init 使用相同 sessionId，并将保存的 lastSequenceNum 作为新 transport 的 initialSequenceNum。',
    '普通 teardown 关闭 transport、保存高水位且不发送 result、不归档、不清指针。',
    '显式 archive 发送 result、调用兼容 archive、关闭 transport 并尝试清除指针，归档 401 有一次刷新重试路径；正常删除路径下读取指针为 null。',
    '401 恢复只增加 /bridge 凭据获取，不创建新 cse_*，新旧 transport 使用相同会话和 SSE 序号。',
    'env-less gate 开启时 perpetual 不再调用 registerBridgeEnvironment/createBridgeSession，env-based gate 关闭路径保持。',
    'Workflow 命令为 local、supportsNoninteractive，并在缺少 callback 时使用真实权限函数，返回已启动 taskId 文本。',
    'at-commit 文档记录 152/645 和模型 sentinel，同时明确 Claude OAuth、Cloud Files、Remote Control、env-less live server 未验证。',
  ],  remaining: [
    '真实 OAuth /v1/code/sessions、/bridge、SSE Last-Event-ID 恢复、401 刷新和服务端 archive 仍需授权环境逐项验证。',
    'fixture 只在同一子进程内执行两次 init，未证明两个不同进程的真实重启恢复，也未覆盖 TTL、损坏指针、写盘失败或 stale cse_*。',
    '显式 archive 后无论 HTTP 是否成功都会尝试清指针，但 unlink 错误被忽略，且该提交没有其他生产 archive 调用点；永久归档的调用 UX 和失败恢复仍需明确。',
    '指针写盘为 best-effort，四小时后会失效；perpetual 不是无限期或保证成功的本地持久化。',
    '新会话写入序号 0 后，若 /bridge 或 transport 初始化失败，实现仅发起新会话 archive 而保留该指针；下次可能尝试恢复已归档的 cse_*，这条失败路径没有回归覆盖。',
    'Workflow 的 local/noninteractive 类型与权限回退没有新增专项测试，真实 headless DAG 和 ask 行为需另行验证。',
  ],
  references: [
    {
      path: 'docs/RELEASE.md',
      role: 'changed',
      symbol: '## Env-less perpetual and live model validation',
      note: '记录 cse/SSE 恢复、401 重建、teardown/archive、Workflow 和 OAuth 未验证边界。',
    },
    {
      path: 'docs/STATUS.md',
      role: 'changed',
      symbol: 'env-less perpetual bridge',
      note: '将能力限定为 offline isolated process，并记录 152/645 与授权 OAuth/桌面后续事项。',
    },
    {
      path: 'src/bridge/envLessBridgePointer.ts',
      role: 'changed',
      symbol: 'writeEnvLessBridgePointer',
      note: '实现项目级 cse/SSE 指针、四小时 TTL、0600 写入和清除。',
    },
    {
      path: 'src/bridge/initReplBridge.ts',
      role: 'changed',
      symbol: 'if (isEnvLessBridgeEnabled())',
      note: '取消 perpetual 的 env-based 强制回退，并向 core 传递 perpetual 与原始 cwd。',
    },
    {
      path: 'src/bridge/remoteBridgeCore.ts',
      role: 'changed',
      symbol: 'initEnvLessBridgeCore',
      note: '实现创建/恢复、游标注入、401 同会话重建及临时 teardown/显式 archive。',
    },
    {
      path: 'src/bridge/replBridge.ts',
      role: 'changed',
      symbol: 'archive?:',
      note: '在公共桥接句柄上增加可选永久归档操作，与普通 teardown 区分。',
    },
    {
      path: 'src/tools/WorkflowTool/createWorkflowCommand.ts',
      role: 'changed',
      symbol: 'hasPermissionsToUseTool',
      note: '将动态命令改为 local/noninteractive，并接入真实权限函数回退。',
    },
    {
      path: 'tests/envLessPerpetual.test.ts',
      role: 'changed',
      symbol: 'env-less perpetual resume, recovery, and archive pass in an isolated process',
      note: '启动独立 fixture 子进程并检查退出码与离线 sentinel。',
    },
    {
      path: 'tests/fixtures/env-less-perpetual-check.ts',
      role: 'changed',
      symbol: 'ENV_LESS_PERPETUAL_OK',
      note: '以真实指针文件和 mock HTTP/transport 固定同 ID、序号、401、保留与归档。',
    },
    {
      path: 'tests/perpetualBridge.test.ts',
      role: 'changed',
      symbol: 'env-less gate plus perpetual selects env-less with persistent continuity',
      note: '把 perpetual 路径断言改为 env-less，并保留既有 env-based 指针生命周期测试。',
    },
    {
      path: 'src/bridge/replBridgeTransport.ts',
      role: 'reused',
      symbol: 'createV2ReplTransport',
      note: '复用 V2 SSE/CCR transport、initialSequenceNum 和 getLastSequenceNum 接口。',
    },
    {
      path: 'src/cli/transports/SSETransport.ts',
      role: 'reused',
      symbol: 'initialSequenceNum',
      note: '复用 SSE 恢复游标、frame 高水位和实例内重复序号处理。',
    },
    {
      path: 'src/utils/sessionStoragePortable.ts',
      role: 'reused',
      symbol: 'getProjectsDir',
      note: '复用项目存储根目录和 cwd sanitize 规则定位指针。',
    },
    {
      path: 'src/utils/permissions/permissions.ts',
      role: 'reused',
      symbol: 'hasPermissionsToUseTool',
      note: '复用实际 deny/ask、工具权限检查和权限模式处理作为 headless 回退。',
    },
    {
      path: 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts',
      role: 'reused',
      symbol: 'startWorkflowTask',
      note: '复用现有 Workflow 任务创建、DAG runner 和任务状态，不在命令层重写执行。',
    },
  ],
  plan: {
    preconditions: [
      '确认父提交的 env-less 仅用于非 perpetual，现有 createV2ReplTransport 已支持 initialSequenceNum/getLastSequenceNum。',
      '确认纯 env-less 仍需 OAuth 与 /bridge，但不调用 Environments register/poll/ack/heartbeat/deregister。',
      '确认普通 cleanup 不应破坏待恢复会话，永久归档需要独立显式句柄操作。',
      '当时没有 Claude OAuth，验证方案必须使用无凭据 mock，并把单进程 fixture 与真实跨重启/在线验收分开。',
    ],
    reuse: [
      '复用 getProjectsDir/sanitizePath、lazySchema 和 jsonStringify 实现项目级指针。',
      '复用 createCodeSession/fetchRemoteCredentials、createV2ReplTransport、SSETransport 和 FlushGate。',
      '复用 createTokenRefreshScheduler、onAuth401 和现有 OAuth/orgUUID/version 检查。',
      '复用 startWorkflowTask 与 hasPermissionsToUseTool，保持 Workflow DAG 和权限语义。',
      '复用 perpetualBridge 的 mock 路径选择测试及独立 Bun 子进程测试模式。',
    ],
    steps: [
      {
        title: '建立 env-less 指针协议',
        detail:
          '在 envLessBridgePointer.ts 定义 sessionId/lastSequenceNum/updatedAt schema，以 cwd sanitize 定位文件。实现 0600 写入、按 mtime 的四小时过期、损坏数据回退和清除；只保存 ID 与序号，不写 OAuth/JWT，写失败仅降级并记录 debug。',
        paths: ['src/bridge/envLessBridgePointer.ts'],
      },
      {
        title: '开放 perpetual 路径并扩展句柄',
        detail:
          '在 replBridge.ts 增加可选 archive，在 initReplBridge.ts 移除 perpetual 的 env-based 强制回退，让 env-less gate 同时覆盖普通和 perpetual，并传 getOriginalCwd。保留 gate 关闭时的 env-based 实现及现有 OAuth、orgUUID 和版本检查。',
        paths: [
          'src/bridge/replBridge.ts',
          'src/bridge/initReplBridge.ts',
        ],
      },
      {
        title: '实现同会话、同序号创建与恢复',
        detail:
          '在 remoteBridgeCore.ts 读取 perpetual 指针，有指针则复用 sessionId/序号并跳过 createCodeSession，无指针才创建并写序号 0。对同一 ID 获取 /bridge 凭据，传 initialSequenceNum 创建 transport；在新会话、writeMessages 和暂时退出时更新高水位，初始化失败只归档新建会话。',
        paths: ['src/bridge/remoteBridgeCore.ts'],
      },
      {
        title: '串行化 401 重建并拆分清理语义',
        detail:
          '继续在同一 core 中用 authRecoveryInFlight 串行 401 与主动刷新，重建前排队的 FlushGate、读取旧序号，再以旧 session/序号和新 JWT/epoch 重建并 drain。实现 teardown(final)：暂时退出只关闭并保存，显式 archive 才 result/archive/清指针，处理一次 401 刷新重试。',
        paths: ['src/bridge/remoteBridgeCore.ts'],
      },
      {
        title: '打通 Workflow 非交互权限回退',
        detail:
          '在 createWorkflowCommand.ts 将命令改为 local，声明 supportsNonInteractive，call 返回 taskId 文本而非 onDone。删除缺少 canUseTool 的提前拒绝，改用 context.canUseTool ?? hasPermissionsToUseTool 并继续 startWorkflowTask，保证 headless 可进入且不绕过权限。',
        paths: ['src/tools/WorkflowTool/createWorkflowCommand.ts'],
      },
      {
        title: '补隔离过程回归和路径断言',
        detail:
          '修改 perpetualBridge.test.ts，证明 perpetual 不再注册 environment。新增外层测试启动一个 fixture 子进程；fixture 使用真实临时目录和 mock axios/transport，依次验证首次创建、暂时保留、同 ID/序号恢复、显式归档清指针及 401 后第二次 /bridge 和同序号重建，并明确这不是两个真实进程或在线 SSE。',
        paths: [
          'tests/perpetualBridge.test.ts',
          'tests/envLessPerpetual.test.ts',
          'tests/fixtures/env-less-perpetual-check.ts',
        ],
      },
      {
        title: '记录离线证明与 OAuth live 边界',
        detail:
          'STATUS 将 env-less perpetual 标为 offline isolated process，记录 152/645 和后续授权 OAuth/桌面事项。RELEASE 记录客户端恢复设计、Workflow headless 改动以及会话配置 provider 的模型 sentinel，同时明确无 Claude OAuth，Cloud Files、Remote Control 和 env-less live server 未验证。',
        paths: [
          'docs/STATUS.md',
          'docs/RELEASE.md',
        ],
      },
    ],
    compatibility: [
      '非 perpetual 的 env-less 路径继续每次创建新会话，只有 perpetual 才读取和更新指针。',
      'env-less gate 关闭时仍使用既有 env-based pointer/reconnect，已有用户配置不被删除。',
      'ReplBridgeHandle.archive 为可选字段，env-based handle 不需要立即新增实现。',
      '普通 teardown 的公开方法保持，perpetual 通过内部 final 参数选择语义，显式 archive 是新增操作。',
      'Workflow 名称、定义发现和 startWorkflowTask 不变，只改变命令类型、返回形式和缺失权限回调时的处理。',
    ],
    risks: [
      '指针损坏或过期会造成新会话；写盘失败还可能保留旧序号，必须接受降级并避免误报最新高水位已持久化。',
      '401 与主动刷新并发会重复 bump epoch 或混用序号，authRecoveryInFlight 与 FlushGate 是必要同步点。',
      '暂时 teardown 若沿用旧 archive 行为会永久终止待恢复会话，final 分支必须先于 result/archive。',
      '显式 archive 尝试清指针不以服务端成功为条件，失败时可能失去本地恢复线索，unlink 失败则可能留下指针，需在剩余语义中明确。',
      'archive 没有生产调用点时，用户退出不会自动永久归档；不能把句柄能力说成已接通 UI 流程。',
      '单进程 mock fixture 无法发现真实 OAuth、SSE 和跨进程问题，发布状态必须保持 offline isolated process。',
    ],
    acceptanceSequence: [
      '运行 env-less perpetual 外层测试，确认 fixture 退出码为 0 并输出 ENV_LESS_PERPETUAL_OK。',
      '检查首次 create 数为 1、普通 teardown 无 archive，第二次 init 后 create 数仍为 1 且 initialSequenceNum=42。',
      '调用显式 archive，确认出现 archive 请求且读取指针为 null；另触发 close(401)，确认 bridgeCalls=2 且序号不变。',
      '运行 perpetualBridge 路径选择测试，确认 perpetual 调 initEnvLessBridgeCore，不调 registerBridgeEnvironment/createBridgeSession。',
      '检查 Workflow 命令类型、noninteractive 标记和 hasPermissionsToUseTool 回退，再另行执行真实 headless 权限回归。',
      '依据 at-commit STATUS 引用 152/645、typecheck、build/declarations；真实 OAuth、SSE 恢复、Cloud/Remote Control 必须在授权环境另取证。',
    ],
    completed: [
      '项目级 env-less cse/SSE 指针、四小时 TTL、0600 写入和清除已经实现。',
      'perpetual 已可沿 env-less 路径复用同一 session 和序号，不再强制依赖 Environments API。',
      '401/主动刷新同会话重建、暂时 teardown 保留与显式 archive 清指针已经形成确定控制流。',
      'Workflow 动态命令已改为 local/noninteractive，并接入真实权限函数回退。',
      '隔离过程 fixture 和路径选择回归已经加入，at-commit 文档记录 152/645 与构建结果。',
    ],
    incomplete: [
      '真实 Claude OAuth、服务端 SSE 恢复、401 刷新、Cloud Files 和 Remote Control 在线往返未执行。',
      '两个不同真实进程的重启恢复、TTL/损坏/写盘失败和 stale cse_* 服务端行为未覆盖。',
      '显式 archive 的生产调用 UX、失败时清指针的恢复策略以及 Workflow 非交互专项回归仍需完善。',
    ],
  },
})
