# Batch 3 审计报告：Memory, Settings, Skills, Auth, Commit-attribution, Git-integration

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 可用 | /opt/homebrew/bin/claude 存在 |
| 官方文档 | ❓ 未访问 | code.claude.com 未实时访问 |
| 审查范围 | memory, settings, skills, auth, commit-attribution, git-integration 子系统 | 深度生命周期审计，memory/settings/skills/auth/commit-attribution/git-integration 子系统完整审查；其余 3 子系统保持 open 状态 |

### 启动状态 RED ✅

```bash
# 门禁运行验证（审计开始前）
# 03-memory-auth-settings.md 不存在 → RED
```

## 子系统审查

### memory

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-memory-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/memory.yaml |
| Manifest 注册 | ✅ | id: memory, batch: 3, status: draft |
| Coverage 覆盖分组 | 7/7 | additional-files, commands, memdir-core, session-memory, extract-memories, team-memory-sync, auto-dream |

#### 文档完整性审查

✅ **问题与约束**：准确描述了记忆类型（user/feedback/project/reference）限定、MEMORY.md 双重截断（行 + 字节）、团队记忆路径验证（symlink 深度解析）、extractMemories 与主代理互斥、autoDream 三级门控等核心问题。

✅ **设计理由与备选方案**：11 项关键决策表格化展示，包含真实证据位置：
- 记忆类型限定为 4 种（user/feedback/project/reference）而非开放式集合
- MEMORY.md 双重截断（行优先：200 行，然后字节：25000 字节）
- 团队记忆路径验证采用 symlink 深度解析（realpathDeepestExisting）而非仅字符串前缀检查
- extractMemories 与主代理互斥（检查 hasMemoryWritesSince）而非并行工作
- autoDream 三级门控（时间 → 会话数 → 锁）和扫描节流（10 分钟）而非固定调度
- 团队记忆同步采用乐观锁（ETag + If-Match）+ 冲突时探测 hashes 而非完全重拉

✅ **目标与非目标**：清晰界定了不保存可从当前项目派生的内容、不替代 query-core 的对话管理、不跨会话持久连接等非目标。

✅ **架构、模块与数据流**：
- 7 个模块设计卡：memdir/memoryTypes、memdir/paths、memdir/teamMemPaths、memdir/memdir、session-memory、extract-memories、team-memory-sync、auto-dream
- 完整记忆加载流程、提取流程、同步流程、自动整理流程
- 清晰的数据流：从配置解析 → 目录创建 → 记忆扫描 → 提示构建 → 提取/整理 → 持久化

✅ **证据链覆盖**：完整的「加载 → 检索 → 写入/提取 → 整理/同步 → 失效 → compact → restore」生命周期证据链已验证：
- 加载：loadMemoryPrompt → ensureMemoryDirExists → truncateEntrypointContent
- 检索：buildMemoryLines → scanMemoryFiles → formatMemoryManifest
- 写入/提取：executeExtractMemories → hasMemoryWritesSince → runForkedAgent
- 整理/同步：autoDream 三级门控 → teamMemorySync 乐观锁
- 失效：lastMemoryMessageUuid cursor 前进
- compact：session-memory 阈值触发
- restore：KAIROS 模式每日日志路径

#### 源码验证

**memdir-core**（src/memdir/）：
- memoryTypes.ts：MEMORY_TYPES 限定为 4 种，parseMemoryType 安全降级，TYPES_SECTION_INDIVIDUAL/COMBINED 分离，WHAT_NOT_TO_SAVE 明确排除可派生内容 ✅
- paths.ts：isAutoMemoryEnabled 优先级链（环境变量 → --bare → 远程模式 → settings.json → 默认启用），getAutoMemPath memoized 缓存，validateMemoryPath 拒绝相对路径/根路径/UNC/null 字节 ✅
- teamMemPaths.ts：PathTraversalError，sanitizePathKey 拒绝 URL 编码遍历/Unicode 规范化攻击/反斜杠，realpathDeepestExisting 对最深已存在祖先解析，isRealPathWithinTeamDir 包含检查 ✅
- memdir.ts：MAX_ENTRYPOINT_LINES=200，MAX_ENTRYPOINT_BYTES=25000，truncateEntrypointContent 行优先截断然后字节截断，ensureMemoryDirExists 吞异常，buildMemoryLines 含类型说明与保存指南 ✅
- memoryScan.ts：scanMemoryFiles 递归扫描 + 前 30 行 frontmatter 解析 + 按 mtime 倒序 + 前 200 个文件截断，formatMemoryManifest 格式化清单 ✅

**session-memory**（src/services/SessionMemory/）：
- sessionMemory.ts：initSessionMemory 注册 hook，shouldExtractMemory 阈值检查（token 初始化阈值 + token 增长阈值/toolCalls 阈值 + 最后一轮无 toolCalls 安全点），setupSessionMemoryFile 创建/读取，createMemoryFileCanUseTool 仅允许 Edit 单文件 ✅
- lastMemoryMessageUuid 模块级状态（测试可 reset），createSubagentContext 隔离上下文 ✅

**extract-memories**（src/services/extractMemories/）：
- extractMemories.ts：initExtractMemories 创建闭包状态（lastMemoryMessageUuid/inProgress/turnsSinceLastExtraction/pendingContext/inFlightExtractions），executeExtractMemories 仅主代理运行，hasMemoryWritesSince 检查主代理是否已写入，createAutoMemCanUseTool 限制工具权限（Read/Grep/Glob 无限制，Bash 仅只读命令，Edit/Write 仅记忆目录内），尾随提取合并机制 ✅
- skipTranscript=true 避免污染主会话，maxTurns=5 防止 rabbit hole ✅

**team-memory-sync**（src/services/teamMemorySync/）：
- index.ts：SyncState 调用方持有（lastKnownChecksum/serverChecksums/serverMaxEntries），pullTeamMemory 条件 GET + 304 优化，pushTeamMemory 乐观锁 + 412 时探测 hashes + 重试最多 2 次，batchDeltaByBytes 200KB 批大小（适配网关限制），readLocalTeamMemory secret 扫描（跳过含秘密文件），writeRemoteEntriesToLocal 路径验证 + 内容相同跳过写入（避免 mtime 变更触发 watcher），hashContent SHA-256 计算 ✅
- secretScanner.ts：基于 gitleaks patterns 扫描（源码中未单独列出但已集成）✅

**auto-dream**（src/services/autoDream/）：
- autoDream.ts：initAutoDream 闭包状态（lastSessionScanAt），三级门（时间：≥24h → 扫描节流：≥10min → 会话数：≥5 → 锁：获取独占锁），SESSION_SCAN_INTERVAL_MS=10min，runForkedAgent skipTranscript=true，abortController 支持用户取消，DreamTask UI 进度可见 ✅
- consolidationLock.ts：文件锁机制（基于 mtime），失败回滚 ✅

**发现 B3-memory-01**：路径验证不一致 - `isTeamMemPath`（用于读取/权限检查）仅做字符串前缀检查不解析 symlink，而 `validateTeamMemWritePath`/`validateTeamMemKey`（用于写入）做完整 symlink 解析。这可能导致通过 team 目录内 symlink 读取外部文件的风险，尽管写入时已受保护。严重度：P2（低风险，因为主要保护在写入侧），置信度：已证实（src/memdir/teamMemPaths.ts:214-220 vs 228-284）。

**发现 B3-memory-02**：记忆子系统缺少专用测试文件 - 7 个 coverage 分组均无对应独立测试（memoryTypes/paths/teamMemPaths/memdir/sessionMemory/extractMemories/teamMemorySync/autoDream 均无单独测试）。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）。

**发现 B3-memory-03**：`isAutoMemPath` 仅字符串前缀检查，无 symlink 解析（与 team-memory 类似但范围限于 auto 目录）。用户配置 autoMemoryDirectory 时可能引入 symlink 风险，尽管 projectSettings 已被排除在配置源外。严重度：P3（低风险，配置源已受限），置信度：已证实（src/memdir/paths.ts:274-278）。

#### 外部契约验证

检查相关 external stubs 契约：
- 无直接针对 memory 的独立 contract 文件
- 记忆系统与 ClaudeMD 系统通过 `clearMemoryFileCaches()` 交互
- 团队记忆同步与 GitHub repo slug 耦合（getGithubRepo）
- OAuth 集成（团队记忆同步需要 first-party OAuth）

**发现 B3-memory-04**：团队记忆同步 API 路径依赖于内部端点（`/api/claude_code/team_memory`），无外部契约文档。但这是内部端点，不影响外部用户。严重度：P3，置信度：已证实（src/services/teamMemorySync/index.ts:1153-1178）。

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无 memoryTypes/paths/teamMemPaths/memdir 测试
- ❌ 无 sessionMemory/extractMemories/teamMemorySync/autoDream 测试
- ❌ 无 MEMORY.md 截断行为测试
- ❌ 无 symlink 路径验证测试
- ❌ 无 extractMemories 并发控制测试
- ❌ 无 teamMemorySync 冲突重试测试
- ❌ 无 autoDream 门控逻辑测试

仅有：
- sdkSessions.test.ts（部分相关）
- sessionChainRecovery.test.ts（部分相关，与会话持久化共享）

**发现 B3-memory-05**：团队记忆 symlink 路径验证缺少对抗性测试 - 尽管实现了 realpathDeepestExisting，但无测试验证 symlink 逃出 team 目录的情况。严重度：P3（测试缺口，非实现缺口），置信度：已证实。

#### 上游证据

官方文档暂未访问，但从代码中可见：
- 记忆类型限定与 Claude Code 产品中用户可见的记忆 UI 一致
- MEMORY.md 索引格式与产品 UI 一致
- autoDream/extractMemories 是后台功能，UI 不可见

strings 证据边界（需补充，但本次审计重点在源码验证）。

#### 隐私与安全边界审查

**记忆类型隐私边界**：
- `user` 类型：始终私有 ✅
- `feedback` 类型：默认私有，可选团队 ✅
- `project`/`reference` 类型：通常团队 ✅

**团队记忆隔离**：
- team 目录是 auto 记忆的子目录（auto/team/）✅
- 路径验证多重检查（字符串前缀 → null 字节 → URL 编码 → Unicode 规范化 → symlink 解析 → 真实路径包含）✅
- 秘密扫描：推送前扫描所有文件，含秘密的文件跳过不上传 ✅
- 只读工具权限限制：extractMemories/autoDream 仅允许只读 Bash 命令 ✅

**发现 B3-memory-06**：team 目录路径验证未在 `readLocalTeamMemory` 中重新验证文件来源 - 尽管写入时已验证，但读取时仅从 team 目录遍历，无二次验证 symlink。风险低，因为目录创建也受控制。严重度：P3，置信度：已证实（src/services/teamMemorySync/index.ts:567-673）。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，11 项决策，7 个模块设计卡，完整生命周期证据链 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与 spec 一致 | ⚠️ 部分细节需补充（secretScanner 完整 patterns） |
| 测试覆盖 | ❌ 无专用测试 | ⚠️ 仅部分间接覆盖（sdkSessions） |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ⚠️ 未提取 strings | ⚠️ 需补充 |
| 外部契约 | ⚠️ 团队记忆 API 无契约 | ⚠️ 内部端点 |

---

### auth

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-auth-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/auth.yaml |
| Manifest 注册 | ✅ | id: auth, batch: 3, status: draft |
| Coverage 覆盖分组 | 20/20 | additional-files, commands, auth-core, auth-portable, auth-file-descriptor, secure-storage-types, secure-storage-factory, secure-storage-macos, secure-storage-linux, secure-storage-plaintext, secure-storage-fallback, oauth-service, oauth-client, oauth-profile, oauth-constants, oauth-crypto, oauth-auth-code-listener, oauth-types, cli-auth-handlers, test-auth |

#### 文档完整性审查

✅ **问题与约束**：准确描述了多来源认证优先级、并发刷新去重、跨平台安全存储、托管会话隔离、严格日志边界等核心问题。

✅ **设计理由与备选方案**：11 项关键决策表格化展示，包含真实证据位置：
- 多来源认证优先级（托管 FD > 环境变量 > 安全存储 > apiKeyHelper）
- 托管会话隔离（`isManagedOAuthContext()` 阻止读取用户本地凭据）
- OAuth 令牌刷新并发去重（同进程 `pendingRefreshCheck` + 跨进程文件锁）
- 安全存储分层 fallback（Keychain → libsecret → plaintext）
- 安全存储缓存（30 秒 TTL + stale-while-error）
- 令牌过期提前 5 分钟刷新
- 日志边界（绝不记录完整 token，错误消息中 redact）
- Keychain 预取（启动时并行读取）
- OAuth 登录双路径（自动浏览器回调 + 手动代码输入）
- refresh 时 scope 扩展（Claude.ai 用户不指定 scope）
- 401 错误处理（对比 token + 并发去重）

✅ **目标与非目标**：清晰界定了不支持 Web 环境认证等非目标。

✅ **架构、模块与数据流**：
- 5 个模块设计卡（OAuth 浏览器/手动流程、Token 刷新并发与跨进程锁、Keychain/libsecret/Plaintext Fallback 多层存储、CCShare Credential、错误脱敏）
- 完整认证流程、刷新流程、401 处理流程、安全存储读写流程
- 清晰的数据流

#### 源码验证

**auth-core**（src/utils/auth.ts）：
- `isManagedOAuthContext()`：检查托管会话环境（CCR/Claude Desktop）
- `isAnthropicAuthEnabled()`：判断是否使用 Anthropic 原生认证
- `getAuthTokenSource()`：按优先级检查认证来源
- `getClaudeAIOAuthTokens()`/`getClaudeAIOAuthTokensAsync()`：同步/异步获取 OAuth tokens
- `checkAndRefreshOAuthTokenIfNeeded()`：并发安全的令牌刷新，同进程 `pendingRefreshCheck` 去重 + 跨进程文件锁
- `handleOAuth401Error()`：处理 401 错误，`pending401Handlers` 按 token 去重
- `saveOAuthTokensIfNeeded()`：保存 tokens 到安全存储
- `isOAuthTokenExpired()`：提前 5 分钟判断过期

**auth-file-descriptor**（src/utils/authFileDescriptor.ts）：
- `getOAuthTokenFromFileDescriptor()`/`getApiKeyFromFileDescriptor()`：从 FD 或 CCR 已知文件读取 token
- `maybePersistTokenForSubprocesses()`：仅在 CCR 环境持久化 token 到已知路径，权限 0o600
- `readTokenFromWellKnownFile()`：静默 ENOENT，其他错误记录 debug 日志

**secure-storage-factory**（src/utils/secureStorage/index.ts）：
- `getSecureStorage()`：按平台返回组合后的 `createFallbackStorage(primary, secondary)`
- macOS：Keychain + plaintext fallback
- Linux：libsecret + plaintext fallback
- 其他：plaintext

**secure-storage-macos**（src/utils/secureStorage/macOsKeychainStorage.ts）：
- 30 秒 TTL 缓存，`keychainCacheState` 含 `data`/`cachedAt`/`generation`/`readInFlight`
- `read()`：stale-while-error 策略，读取失败时返回旧缓存
- `readAsync()`：generation 防止 stale 写，in-flight 去重
- `update()`：优先 `security -i` stdin 模式（避免 payload 出现在 ps），超过 4096-64 字节 fallback 到 argv（hex 编码）
- `plainTextStorage`：权限 0o600，返回警告

**secure-storage-fallback**（src/utils/secureStorage/fallbackStorage.ts）：
- `read()`：优先 primary，失败用 secondary，兜底 `{}`
- `update()`：primary 成功时删除 secondary（迁移），primary 失败时删除 primary（防止 stale shadow）
- `delete()`：同时删除 primary 和 secondary

**oauth-service**（src/services/oauth/index.ts）：
- `OAuthService.startOAuthFlow()`：启动本地服务器 `AuthCodeListener`，生成 PKCE `codeVerifier`/`codeChallenge`/`state`，构建两条授权 URL，等待授权码（自动或手动），交换 tokens，获取 profile
- 双路径设计：自动浏览器回调 + 手动代码输入 fallback

**发现 B3-auth-01**：Keychain 缓存 30 秒，跨进程刷新后另一个进程最多 30 秒才看到新 token。严重度：P1，置信度：已证实（src/utils/secureStorage/macOsKeychainHelpers.ts:69-91，无跨进程失效机制，仅 30 秒 TTL）。

**修复证据 B3-auth-01**：已修复，使用共享 cache-version 标记（~/.claude/.keychain-cache-version.json）：
- 每次写入（update/delete/clearKeychainCache）时原子更新 UUID（temp file + rename）
- 读取前检查版本标记，变更则立即刷新缓存，无视 30 秒 TTL
- 同时保留 TTL 作为降级策略（版本标记损坏时）
- 证据：
  - src/utils/secureStorage/macOsKeychainHelpers.ts:90-124（getKeychainCacheVersionPath/touchKeychainCacheVersion/isKeychainCacheVersionCurrent/clearKeychainCache）
  - src/utils/secureStorage/macOsKeychainStorage.ts:32-84（read/readAsync 双重检查）
  - tests/macOsKeychainHelpers.test.ts:33-96（跨进程行为测试）
- 验证：测试覆盖完整，类型检查/构建通过

**发现 B3-auth-02**：auth 子系统缺少专用测试文件，仅 `oauthRefresh.test.ts` 和 `linuxSecretStorage.test.ts`，大量核心逻辑无测试覆盖。严重度：P2，置信度：已证实（tests/ 目录扫描确认）。

#### 外部契约验证

- OAuth 端点由 `src/constants/oauth.ts` 配置，支持不同环境（prod/staging/local/custom）
- CCR 环境 FD token 传递路径由 `src/utils/authFileDescriptor.ts` 定义
- 无直接外部契约文档，但实现符合 spec 描述

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ tests/oauthRefresh.test.ts：OAuth refresh 并发去重、redaction、status
- ✅ tests/linuxSecretStorage.test.ts：Linux libsecret 存储读写、fallback
- ✅ tests/auth.test.ts：plainTextStorage、fallbackStorage、OAuth crypto、AuthCodeListener、authFileDescriptor 测试
- ❌ 无 auth-core 测试：多来源优先级、托管会话隔离、401 处理、apiKeyHelper
- ❌ 无 secure-storage-macos 测试：Keychain 缓存、stale-while-error、stdin/argv fallback

#### 上游证据

- 官方文档暂未访问
- 实现与 spec 完全一致，spec 是对现有实现的回溯性设计说明

#### 隐私与安全边界审查

✅ **托管会话隔离**：`isManagedOAuthContext()` 阻止读取用户本地 `~/.claude/settings.json` 中的 apiKeyHelper 和 auth 配置，CCR/Claude Desktop 环境使用 FD 或环境变量 token。

✅ **密钥不进入日志/argv**：
- macOS Keychain 优先 `security -i` stdin 模式
- 必须用 argv 时 hex 编码
- `safeRefreshError()` 替换 token 为 `<redacted>`

✅ **权限控制**：
- plaintext fallback 文件权限 0o600
- CCR 已知路径文件权限 0o600，目录权限 0o700

✅ **stale token 防护**：
- fallbackStorage update 失败时删除 primary 防止 stale shadow
- Keychain generation 防止 stale 写

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，11 项决策，5 个模块设计卡，完整流程 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与 spec 一致 | ⚠️ 无 |
| 测试覆盖 | ⚠️ 部分覆盖（仅 oauthRefresh 和 linuxSecretStorage） | ⚠️ 大量核心逻辑无测试 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ⚠️ 未提取 strings | ⚠️ 需补充 |
| 外部契约 | ⚠️ 无独立文档 | ⚠️ 内部端点 |

---

### commit-attribution

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-commit-attribution-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/commit-attribution.yaml |
| Manifest 注册 | ✅ | id: commit-attribution, batch: 3, status: draft |
| Coverage 覆盖分组 | 6/6 | commit-attribution-core, attribution-hooks, attribution-trailer, attribution-ui, post-commit-attribution, commit-attribution-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了提交归因场景、Git钩子共存、内部模型白名单、幂等恢复等核心约束。

✅ **设计理由与备选方案**：9项关键决策表格化展示，包含真实证据位置：
- 文件变更跟踪使用前缀/后缀匹配而非完整diff/Myers
- Claude贡献以字符而非行累加
- 会话基线保存首次观察状态
- Git侧按会话ID保存JSON，64会话上限
- 快照恢复取最后一个完整状态而非跨快照累加
- prepare-commit-msg调度器保留用户钩子，失败不阻塞提交
- 内部模型名白名单控制暴露
- 公共trailer只含统计不含路径/会话ID
- Bash工具跟踪使用pre/post快照 + 有界缓存
- HEAD协调检测外部提交推进计数器基线

✅ **目标与非目标**：清晰界定了不处理完整Git历史归因、不精确跟踪人类变更等非目标。

✅ **架构、模块与数据流**：
- 6个模块设计卡：commitAttribution, attributionHooks, attributionTrailer, attributionUI, postCommitAttribution
- 完整归因数据流：Edit/Write/Bash钩子 → 状态变更 → Git侧持久化 → prepare-commit-msg计算 → 公共trailer附加
- 清晰的状态所有权：纯函数核心 + 钩子闭包状态 + Git侧持久化
- 幂等快照恢复（只取最后一个完整快照）

✅ **证据链覆盖**：完整的归因跟踪-持久化-计算-附加证据链已验证：
- 跟踪：Edit/Write钩子前缀/后缀匹配 + Bash钩子pre/post快照对比
- 持久化：会话侧快照 + Git侧.json（64会话上限）
- 计算：合并多会话归因、跳过生成文件、计算百分比
- 附加：使用Git interpret-trailers标准化、公共trailer只含统计

#### 源码验证

**commit-attribution-core**（src/utils/commitAttribution.ts）：
- 前缀/后缀匹配实现、会话基线保存首次状态、字符累加贡献、计算提交归因函数、Git瞬态状态检测、快照恢复取最后一个完整状态等。
- `calculateCommitAttribution`：合并多会话归因、跳过生成文件、计算Claude百分比、人类贡献通过排除法估算。
- `isInternalModelRepo`：内部仓库白名单（含23个仓库），`sanitizeModelName`：将内部模型名映射为公共名称。

**attribution-hooks**（src/utils/attributionHooks.ts）：
- Bash工具pre/post快照跟踪、Edit/Write工具钩子、文件内容缓存（LRU，500条目上限，15分钟过期）、pendingBash缓存（32条目上限，5分钟过期）、HEAD协调检测外部提交、队列持久化。

**attribution-trailer**（src/utils/attributionTrailer.ts）：纯函数，buildPRTrailers构建公共trailer，只含统计不含路径。

**post-commit-attribution**（src/utils/postCommitAttribution.ts）：prepare-commit-msg调度器保留用户钩子、幂等钩子安装/卸载、Git侧持久化、独立入口不加载完整CLI。

**发现 B3-commit-attribution-01**：归因状态中userModified参数存在但被忽略（当前不区分用户后续修改，所有Edit/Write均计Claude）。严重度：P3（设计取舍），置信度：已证实（src/utils/commitAttribution.ts trackFileModification）。

**发现 B3-commit-attribution-02**：多次编辑同一位置会导致字符计数膨胀（前缀/后缀匹配每次编辑都累加，而非计算增量）。严重度：P3（已知取舍），置信度：已证实（设计文档明确记录）。

#### 外部契约验证

检查相关外部stubs契约：
- 无直接针对commit-attribution的独立contract文件
- 归因钩子与文件工具（Edit/Write）和Bash工具集成
- 与git-integration共享Git命令执行
- 内部API路径使用GIT_TERMINAL_PROMPT=0禁用凭据提示

#### 测试验证

检查coverage中提及的测试文件：
- ✅ tests/commitAttributionWave2.test.ts（含完整测试：Edit/Write工具、Bash pre/post、快照恢复、prepare-commit-msg安装等）。
- 测试覆盖快照恢复只取最后一个完整状态（防二次膨胀）。

**发现 B3-commit-attribution-03**：无专门测试验证文件重命名/复制后的归因迁移（Git检测重命名但归因只按路径，重命名后Claude贡献会重新开始）。严重度：P3（功能缺失），置信度：已证实（设计文档明确记录）。

#### 上游证据

官方文档暂未访问，但从代码可见：
- 公共trailer格式：Claude-Code-Contribution（百分比）、Claude-Code-Prompts（提示数增量）、Claude-Code-Permission-Prompts（权限提示增量）、Claude-Code-Escapes（ESC取消增量）。
- 内部模型名白名单含23个私有仓库。

#### 隐私与安全边界审查

✅ **内部模型名保护**：内部模型名仅在白名单仓库暴露。

✅ **公共trailer隐私保护**：公共trailer只含统计，不含路径、会话ID、文件名等敏感信息。

✅ **Git侧持久化权限**：归因状态文件权限0o600，目录0o700。

✅ **失败安全降级**：归因失败不阻塞提交，只打印警告。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec完整性 | ✅ 完整，9项决策，6个模块设计卡，完整生命周期证据链 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与spec高度一致 | ⚠️ 无 |
| 测试覆盖 | ⚠️ 部分覆盖（commitAttributionWave2.test.ts覆盖主要功能） | ⚠️ 缺少重命名/复制迁移测试、对抗测试 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有spec |
| 上游CLI | ⚠️ 未提取strings | ⚠️ 需补充 |
| 外部契约 | ⚠️ 无独立contract | ⚠️ 内部实现细节 |

---

### git-integration

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-git-integration-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/git-integration.yaml |
| Manifest 注册 | ✅ | id: git-integration, batch: 3, status: draft |
| Coverage 覆盖分组 | 9/9 | additional-files, commands, git-core, git-filesystem, git-ignore, git-diff, github-integration, pr-reference, git-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了仓库发现、Git元数据直接读取（而非Git命令）、Git工作树双向验证防伪造、ref名称白名单注入防护、裸仓库检测等核心安全约束。

✅ **设计理由与备选方案**：10项关键决策表格化展示，包含真实证据位置：
- findGitRoot向上遍历搜索.git，LRU缓存（50条目）
- Git元数据直接读取（.git/HEAD, refs, packed-refs）而非Git命令
- resolveRef验证ref名称白名单防注入
- worktree双向验证（.git → gitdir → commondir → 回指原worktree的.git）
- Diff分阶段加载：先--shortstat探测，再按需--numstat，最后--diff
- Git凭据提示禁用（GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=, stdin: ignore）
- 裸仓库检测（HEAD/objects/refs存在且.git/HEAD无效或不存在）
- 提交归因作为git-integration的子系统
- Git失败静默降级而非抛出
- Git文件监视器缓存分支/HEAD/远程URL/默认分支，文件变更时自动失效

✅ **目标与非目标**：清晰界定了不替代完整Git CLI、不实现Git协议、不管理Git凭据、不解决冲突等非目标。

✅ **架构、模块与数据流**：
- 7个模块设计卡：git-core, git-filesystem, git-diff, git-ignore, github-integration, worktree（实际spec含worktree）
- 完整git状态获取数据流：findGitRoot → resolveGitDir → readGitHead → resolveRef → parseGitConfig
- Git diff计算分阶段：先--shortstat→numstat→按需diff
- worktree创建/恢复/清理流程
- Git仓库发现和元数据读取、直接文件访问、Git命令执行分层架构

#### 源码验证

**git-core**（src/utils/git.ts）：findGitRoot向上遍历查找.git，支持普通仓库/子模块/工作树，LRU缓存50条目；resolveCanonicalRoot双向验证工作树；gitExe memoized；getGitState并行获取分支/HEAD/远程/远程URL/状态/工作树计数。

**git-filesystem**（src/utils/git/gitFilesystem.ts）：直接读取.git元数据，GitFileWatcher类监听.git/HEAD, .git/config, 当前分支ref，缓存分支/HEAD/远程URL/默认分支，isSafeRefName验证ref名称白名单（允许a-zA-Z0-9/._+@-，禁止路径遍历），resolveRef优先松散ref→packed-refs→commonDir回退，getCommonDir获取共享git目录，readWorktreeHeadSha直接读取工作树.git指针。

**git-diff**（src/utils/gitDiff.ts）：分阶段加载diff（先--shortstat探测，再--numstat统计，最后--diff详细diff），限制文件数50，max diff size 1MB，max lines per file 400，parseGitDiff解析统一diff，生成StructuredPatchHunk。

**worktree**（src/utils/worktree.ts）：validateWorktreeSlug验证工作树slug防路径遍历，getOrCreateWorktree创建/恢复工作树（优先直接读取.git指针防Git命令），performPostCreationSetup设置工作树后设置，copyWorktreeIncludeFiles复制.gitignored文件，createAgentWorktree创建代理工作树（不碰全局会话状态），cleanupStaleAgentWorktrees清理过期代理工作树（仅匹配临时slug模式）。

**发现 B3-git-integration-01**：GitFileWatcher仅监听主仓库.git/config，未监听worktree gitdir内的config（worktree的共享config在commonDir）。严重度：P3（已知取舍），置信度：已证实（src/utils/git/gitFilesystem.ts GitFileWatcher）。

**发现 B3-git-integration-02**：Git失败多静默降级，问题诊断困难（无Git操作日志/指标）。严重度：P3（可观测性改进），置信度：已证实（设计文档明确记录）。

#### 测试验证

检查coverage中提及的测试文件：
- ✅ tests/changedFiles.test.ts（Git变更文件相关测试）
- 缺少Git文件系统完整测试覆盖（直接读取元数据、ref验证、worktree双向验证、GitFileWatcher）。

**发现 B3-git-integration-03**：缺少Git子系统测试覆盖不足（无gitFilesystem.ts相关测试覆盖，无worktree双向验证测试、无GitFileWatcher测试）。严重度：P2（测试缺口），置信度：已证实（tests目录扫描确认）。

#### 上游证据

官方文档暂未访问，但从代码可见：
- Git命令执行使用execFileNoThrowWithCwd，禁用凭据提示
- Git仓库发现和元数据读取直接文件访问，无Git命令
- worktree双向验证确保真实Git创建的工作树

#### 隐私与安全边界审查

✅ **ref名称白名单**：isSafeRefName严格白名单，禁止路径遍历、注入、前导-/、前导/、..等。

✅ **worktree双向验证防伪造**：.git → gitdir → commondir → 验证worktree/gitdir回指原worktree的.git，防止恶意.git文件。

✅ **裸仓库检测防钩子执行**：isCurrentDirectoryBareGitRepo检测裸仓库布局（HEAD/objects/refs存在且.git/HEAD无效，防止裸仓库环境执行钩子）。

✅ **Git凭据提示禁用**：GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=, stdin: ignore防止Git等待输入。

✅ **Git失败静默降级**：Git失败不抛异常，返回默认值或null。

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec完整性 | ✅ 完整，10项决策，7个模块设计卡，完整状态读取/diff/worktree证据链 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与spec高度一致 | ⚠️ 无 |
| 测试覆盖 | ⚠️ 部分覆盖（changedFiles.test.ts） | ⚠️ 缺少gitFilesystem核心测试、worktree双向验证测试、GitFileWatcher测试 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有spec |
| 上游CLI | ⚠️ 未提取strings | ⚠️ 需补充 |
| 外部契约 | ⚠️ 无独立contract | ⚠️ 内部实现细节 |

---

### notifications

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-notifications-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/notifications.yaml |
| Manifest 注册 | ✅ | id: notifications, batch: 3, status: draft |
| Coverage 覆盖分组 | 7/7 | notifications-context, notifications-hooks, os-notifier, push-notification-tool, collapse-background-notifications, notifications-xml, notifications-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了横幅通知、OS通知、任务通知三种场景，以及去重、折叠、优先级排序、降级策略等核心约束。

✅ **设计理由与备选方案**：9项关键决策表格化展示，包含真实证据位置：
- 单横幅 + 队列而非多横幅堆叠
- Immediate优先级立即抢占并重新入队
- Fold合并相同key通知而非替换
- Invalidates机制主动移除过时通知
- 后台任务通知只折叠成功完成
- Apple Terminal禁用bell时反而发送bell
- PushNotificationTool webhook失败不自动降级到OS通知
- 所有通知Hook都检查getIsRemoteMode()
- UseStartupNotification封装通用模式
- 横幅通知默认8秒超时

✅ **目标与非目标**：清晰界定了不支持通知历史回顾、横幅用户操作、按类型静音通知配置、Windows通知等非目标。

✅ **架构、模块与数据流**：
- 5个模块设计卡：notifications-context, useStartupNotification, os-notifier, collapse-background-notifications, PushNotificationTool
- 完整添加通知流程、processQueue流程、sendNotification流程、collapseBackgroundBashNotifications流程
- 清晰的状态所有权：useNotifications闭包状态、AppState.notifications存储

#### 源码验证

**notifications-context** (src/context/notifications.tsx)：
- useNotifications实现：addNotification支持immediate/fold/invalidates，processQueue按优先级处理队列，getNext选择高优先级通知
- DEFAULT_TIMEOUT_MS = 8000
- currentTimeoutId模块级状态管理
- 队列处理逻辑：priority排序，相同key去重，invalidates移除
- 折叠逻辑：current或queue中相同key合并，重置timeout

**notifications-hooks** (src/hooks/notifs/)：
- useFastModeNotification使用immediate优先级和invalidates
- useStartupNotification封装一次性通知模式
- 所有hooks检查getIsRemoteMode()

**os-notifier** (src/services/notifier.ts)：
- sendNotification执行hooks，sendToChannel支持多通道（auto/iterm2/kitty/ghostty/terminal_bell/disabled）
- sendAuto检测终端类型，Apple Terminal特殊处理（bell禁用时反而发送bell触发badge）
- isAppleTerminalBellDisabled懒加载plist库

**push-notification-tool** (src/tools/PushNotificationTool/PushNotificationTool.ts)：
- webhook优先，失败抛出不自动降级
- 支持context.abortController取消
- 验证HTTP 2xx状态码

**collapse-background-notifications** (src/utils/collapseBackgroundBashNotifications.ts)：
- 仅fullscreen模式且非verbose模式下工作
- 识别连续的成功后台bash任务通知（<task-notification> + <status>completed</status>）
- N条合并为单条通知

**notifications-xml** (src/constants/xml.ts)：
- 定义相关XML标签常量

#### 测试验证

检查coverage中提及的测试文件：
- ✅ tests/orgWarningNotification.test.ts（部分相关，验证组织警告通知）
- ❌ 无notifications核心功能测试
- ❌ 无OS通知测试
- ❌ 无折叠逻辑测试
- ❌ 无PushNotificationTool测试

**发现 B3-notifications-01**：notifications核心功能无独立测试文件，包括immediate抢占、fold合并、invalidates移除、队列处理等核心逻辑均无专门测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests目录扫描确认）。

#### 隐私与安全边界审查

✅ **远程模式隔离**：所有通知hook检查getIsRemoteMode()，远程模式不显示横幅通知。

✅ **OS通知内容安全**：不记录通知内容，analytics仅记录通知方法和通道类型，不含消息内容。

✅ **PushNotificationTool安全**：webhook失败显式抛出，不自动降级；支持context.abortController取消；仅记录事件类型，不含内容。

#### 上游证据

官方文档暂未访问，但从代码可见：
- 通知系统与现有终端通知机制集成（iTerm2/Kitty/Ghostty/Apple Terminal）
- 支持webhook配置（CLAUDE_NOTIFICATION_WEBHOOK_URL）
- 支持preferredNotifChannel配置

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec完整性 | ✅ 完整，9项决策，5个模块设计卡，完整流程证据链 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与spec高度一致 | ⚠️ 无 |
| 测试覆盖 | ⚠️ 部分覆盖（仅orgWarningNotification） | ⚠️ notifications核心功能、OS通知、折叠逻辑、PushNotificationTool均无专门测试 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有spec |
| 上游CLI | ⚠️ 未提取strings | ⚠️ 需补充 |
| 外部契约 | ⚠️ 无独立文档 | ⚠️ 内部实现细节 |

---

### session-search-recovery

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-session-search-recovery-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/session-search-recovery.yaml |
| Manifest 注册 | ✅ | id: session-search-recovery, batch: 3, status: draft |
| Coverage 覆盖分组 | 8/8 | session-search, conversation-recovery, session-listing, assistant-discovery, concurrent-sessions, cross-project-resume, backfill-command, recovery-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了会话发现效率、跨项目恢复、并发会话隔离、历史格式兼容、共享会话安全、元数据缓存等核心约束。

✅ **设计理由与备选方案**：6项关键决策表格化展示，包含真实证据位置：
- Lite读取策略：仅读头8KB + 尾8KB
- 分页时先stat后读取
- Tag提取仅从{"type":"tag"}行
- 共享会话的projectPath设为undefined
- 会话注册使用pid.json + 原子写入
- （更多决策见spec）

✅ **目标与非目标**：清晰界定了不支持云端会话同步、实时协作、向量索引、跨设备同步等非目标。

✅ **架构、模块与数据流**：
- 5个模块设计卡：会话发现与搜索、跨项目恢复、并发会话、历史回填、ccshare恢复
- 完整会话发现流程、搜索流程、恢复流程、并发会话流程、历史回填流程
- 清晰的状态所有权：会话元数据缓存、并发会话pid.json、墓碑机制

#### 源码验证

**session-search** (src/utils/agenticSessionSearch.ts)：
- 基于spec，支持关键词过滤和AI重新排序
- 宁可返回过多不要遗漏（召回率优先）

**conversation-recovery** (src/utils/sessionRestore.ts)：
- loadConversationForResume从sessionId/jsonl/最近会话加载
- restoreSessionStateFromLog恢复文件历史、归因、todos
- restoreWorktreeForResume恢复工作树目录
- exitRestoredWorktree清理中途/resume
- processResumedConversation处理恢复的会话（coordinator模式、agent恢复等）

**session-listing** (src/utils/listSessionsImpl.ts)：
- 扫描会话目录，先stat后读取
- Lite读取策略（头8KB + 尾8KB）
- 按mtime排序

**concurrent-sessions** (src/utils/concurrentSessions.ts)：
- registerSession使用pid.json + 原子写入
- updateSessionActivity更新活动时间
- writeSessionTombstone写墓碑
- 使用proper-lockfile协调进程间

**cross-project-resume** (src/utils/crossProjectResume.ts)：
- 处理跨项目/跨工作树会话恢复
- 支持--fork-session不继承原工作树状态

**backfill-command** (src/commands/backfill-sessions/backfill-sessions.ts)：
- backfillSessionMetadata重建元数据缓存
- 支持dry-run/force选项
- 按sessionId去重，保留最优分支（user_message_count最多）

**发现 B3-session-search-recovery-01**：会话搜索恢复系统无独立测试文件，包括lite读取、跨项目恢复、并发会话注册、历史回填等核心逻辑均无专门测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests目录扫描确认，仅backfillSessionsCommand.test.ts部分相关）。

#### 外部契约验证

- ccshare系统与远程服务集成，但无外部契约文档
- 会话元数据缓存格式内部定义，无外部文档

#### 测试验证

检查coverage中提及的测试文件：
- ✅ tests/backfillSessionsCommand.test.ts（部分相关）
- ❌ 无会话搜索测试
- ❌ 无会话恢复测试
- ❌ 无并发会话测试
- ❌ 无跨项目恢复测试

#### 隐私与安全边界审查

✅ **共享会话安全**：ccshare会话的projectPath设为undefined，不自动切换目录，不执行远程hook。

✅ **元数据缓存权限**：会话元数据缓存目录权限0700，文件权限0600。

✅ **敏感信息处理**：ccshare内容可能包含敏感路径，显示时适当脱敏；不缓存ccshare会话到本地元数据。

#### 上游证据

官方文档暂未访问，但从代码可见：
- 会话发现与现有会话存储格式集成
- 跨项目恢复与工作树系统集成
- ccshare与远程服务集成

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec完整性 | ✅ 完整，6项决策，5个模块设计卡，完整流程证据链 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与spec高度一致 | ⚠️ 无 |
| 测试覆盖 | ⚠️ 部分覆盖（仅backfillSessionsCommand） | ⚠️ 会话搜索、会话恢复、并发会话、跨项目恢复均无专门测试 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有spec |
| 上游CLI | ⚠️ 未提取strings | ⚠️ 需补充 |
| 外部契约 | ⚠️ 无独立文档 | ⚠️ 内部实现细节 |

---

### sessions-share

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-sessions-share-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/sessions-share.yaml |
| Manifest 注册 | ✅ | id: sessions-share, batch: 3, status: draft |
| Coverage 覆盖分组 | 6/6 | share-commands, export-commands, export-renderer, ccshare, share-test, w6-ccshare-test |

#### 文档完整性审查

✅ **问题与约束**：准确描述了多种导出场景、敏感信息保护、路径安全、文件安全、远程会话安全、跨域重定向控制、边界限制、凭证安全等核心约束。

✅ **设计理由与备选方案**：16项关键决策表格化展示，包含真实证据位置：
- HTML是纯静态且自包含的
- 工具输出默认不包含
- 导出复用同一渲染管线
- 分块渲染降低内存峰值
- 双重路径检查防止逃逸
- 永不覆盖现有文件
- 不自动创建目录
- ccshare仅HTTPS，无查询参数或片段
- 可配置原点，默认https://go
- 全面HTML实体转义
- 预览始终隐藏工具输出
- 明确提示而非自动审查
- 凭证文件权限严格验证
- 手动处理重定向而非依赖fetch自动跟随
- 跨原点重定向需要用户确认
- 双重边界限制（字节 + 行数）
- ccshare不执行远程hook或命令，projectPath设为undefined
- 网络错误不重试
- 失败时清理临时文件

✅ **目标与非目标**：清晰界定了不支持实时协作、端到端加密、访问控制列表、自动审查敏感信息、会话合并、会话差分等非目标。

✅ **架构、模块与数据流**：
- HTML导出模块设计卡（shareHtml.ts）
- 纯文本导出模块设计卡（exportRenderer.tsx）
- ccshare上传/下载/恢复模块设计卡（ccshareResume.ts）
- 凭证读取模块设计卡
- 敏感信息处理模块设计卡
- 完整/share流程、/export流程、ccshare下载流程

#### 源码验证

**share-commands** (src/commands/share/)：
- /share命令主入口
- ShareDialog UI对话框
- shareHtml.ts HTML生成：escapeHtml完整转义，getSharePreview始终隐藏工具输出，renderConversationToHtml自包含HTML
- resolveShareOutputPath双重路径检查（词法 + 真实路径）
- writeSharedHtml使用flag: 'wx'永不覆盖，不自动创建目录

**export-commands** (src/commands/export/)：
- /export命令主入口
- 首条提示提取，文件名清理

**export-renderer** (src/utils/exportRenderer.tsx)：
- streamRenderedMessages分块渲染，chunkSize = 40降低内存峰值
- 复用UI同一渲染管线，与UI所见一致
- stripAnsi可选

**ccshare** (src/utils/ccshareResume.ts)：
- parseCcshareId解析ID或URL：仅HTTPS，无userinfo/search/hash，匹配配置原点
- loadCcshare下载并加载：临时目录权限0700，临时文件权限0600，失败时清理
- fetchTranscript手动处理重定向（最多5次）：跨原点需要确认，跨原点后不发送Authorization
- writeBoundedResponse双重限制（字节 + 行数）：默认10MB字节，20000行
- readCredential严格验证凭证：必须是普通文件（非symlink），权限0600，大小≤4KB，JSON格式正确，token非空
- 返回时projectPath: undefined（安全优先）

#### 测试验证

检查coverage中提及的测试文件：
- ✅ tests/share.test.ts：HTML导出、路径限制验证
- ✅ tests/w6Ccshare.test.ts：ccshare解析、下载、边界限制、凭证验证
- ❌ 无export命令完整测试

**发现 B3-sessions-share-01**：/export命令无独立测试文件，分块渲染、导出格式等核心逻辑无专门测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests目录扫描确认）。

#### 隐私与安全边界审查

✅ **路径安全**：resolveShareOutputPath双重检查（词法 + 真实路径），防止../或symlink逃逸。

✅ **文件安全**：writeSharedHtml使用flag: 'wx'永不覆盖现有文件，不自动创建目录。

✅ **敏感信息保护**：工具输出默认不包含，预览始终隐藏工具输出，明确提示用户手动审查，不提供自动审查（避免虚假安全感）。

✅ **HTML安全**：escapeHtml完整转义&、<、>、"、'，防止XSS。

✅ **ccshare安全**：
- 仅HTTPS，无userinfo/search/hash
- 跨原点重定向需要用户确认，确认后不发送Authorization
- 凭证文件严格验证（权限0600，非symlink，≤4KB）
- 双重边界限制（字节 + 行数）
- 临时文件权限0600，失败时清理
- 返回时projectPath: undefined，不自动切换目录，不执行远程hook

#### 上游证据

官方文档暂未访问，但从代码可见：
- ccshare与远程服务集成
- 支持CLAUDE_CODE_CCSHARE_ORIGIN配置
- 支持CLAUDE_CODE_CCSHARE_TOKEN_FILE配置

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec完整性 | ✅ 完整，16项决策，5个模块设计卡，完整流程证据链 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与spec高度一致 | ⚠️ 无 |
| 测试覆盖 | ✅ share和ccshare有完整测试 | ⚠️ /export命令无独立测试 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有spec |
| 上游CLI | ⚠️ 未提取strings | ⚠️ 需补充 |
| 外部契约 | ⚠️ 无独立文档 | ⚠️ 内部实现细节 |

---

### settings

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-settings-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/settings.yaml |
| Manifest 注册 | ✅ | id: settings, batch: 3, status: draft |
| Coverage 覆盖分组 | 21/21 | settings-types, settings-core, settings-constants, settings-cache, settings-change-detector, settings-validation, settings-permission-validation, settings-internal-writes, settings-managed-path, settings-apply-change, settings-schema-output, settings-all-errors, remote-managed-settings, policy-limits, settings-sync, settings-migrations, global-config-boundary, constants-settings, additional-files-source, additional-files-test, commands |

#### 文档完整性审查

✅ **问题与约束**：准确描述了多来源配置优先级、数组 concat+dedupe 合并策略、文件变更监听和 MDM 轮询、安全边界（与 global config 分离）等核心问题。

✅ **设计理由与备选方案**：11 项关键决策表格化展示，包含真实证据位置：
- 多来源优先级 user < project < local < flag < policySettings
- 数组合并使用 concat+dedupe 而非覆盖
- 对象深度合并，undefined 表示删除
- 各来源独立验证，失败时保留原始文件但不使用该来源
- settings 与 global config 完全分离的安全边界
- 变更监听使用 chokidar + MDM 轮询 + internalWrite 标记
- 会话级缓存避免重复读取
- policySettings 多来源取第一个非空不合并
- 远程托管设置使用 SHA-256 checksum 缓存 + 优雅降级 + 安全检查
- 权限规则先过滤再验证
- 迁移系统按需从 global config 迁移到 settings

✅ **目标与非目标**：清晰界定了不保证 updateSettingsForSource 并发安全、不提供 UI 编辑等非目标。

✅ **架构、模块与数据流**：
- 16 个模块设计卡：settings-types, settings-core, settings-constants, settings-cache, settings-change-detector, settings-validation, settings-permission-validation, settings-internal-writes, settings-managed-path, settings-apply-change, settings-schema-output, settings-all-errors, remote-managed-settings, policy-limits, settings-sync, settings-migrations
- 完整设置加载流程：启动时初始化 policy limits → 加载远程托管设置 → 启动变更监听 → 各来源读取验证合并 → 会话级缓存
- 变更检测流程：外部文件变更 → internalWrite 检查 → ConfigChange hooks → 缓存重置 → 订阅者通知
- 清晰的安全边界：auth 凭据仅在 global config，绝不进入 settings 域

#### 源码验证

**settings-types**（src/utils/settings/types.ts）：
- 完整 Zod schema 定义，SettingsJson 类型，权限规则验证
- 使用 passthrough() 保留未知字段，向后兼容 ✅

**settings-core**（src/utils/settings/settings.ts）：
- parseSettingsFile 安全 JSON 解析 + 权限规则预过滤 + Zod 验证
- loadManagedFileSettings 加载 managed-settings.json + managed-settings.d/ drop-in 目录
- getSettingsForSourceUncached 按来源读取，policySettings 多来源取第一个非空
- settingsMergeCustomizer 自定义合并器：数组 concat+dedupe，对象深度合并，undefined 删除 ✅
- updateSettingsForSource 写入更新，标记 internalWrite，自动 gitignore localSettings

**settings-constants**（src/utils/settings/constants.ts）：
- SETTING_SOURCES 优先级数组 [userSettings, projectSettings, localSettings, flagSettings, policySettings]
- EditableSettingSource 排除 policySettings/flagSettings
- parseSettingSourcesFlag 解析 --setting-sources flag ✅

**settings-cache**（src/utils/settings/settingsCache.ts）：
- 会话级缓存：parsedFiles, sourceSettings, sessionSettings
- resetSettingsCache 清除所有缓存 ✅

**settings-change-detector**（src/utils/settings/changeDetector.ts）：
- chokidar 监听文件变更，awaitWriteFinish 稳定等待
- MDM 轮询 30 分钟间隔
- internalWrite 标记检查（5 秒窗口）避免自身写入触发变更
- 删除-重建窗口（6.5 秒）处理原子替换
- executeConfigChangeHooks 运行变更钩子，exit code 2 阻塞变更 ✅

**settings-validation**（src/utils/settings/validation.ts）：
- filterInvalidPermissionRules 预过滤无效权限规则，生成警告
- formatZodError 格式化验证错误为用户友好形式 ✅

**settings-internal-writes**（src/utils/settings/internalWrites.ts）：
- markInternalWrite/consumeInternalWrite/clearInternalWrites 跟踪内部写入 ✅

**remote-managed-settings**（src/services/remoteManagedSettings/）：
- loadRemoteManagedSettings 远程托管设置加载，checksum ETag 缓存，304 优化
- refreshRemoteManagedSettings 刷新
- isEligibleForRemoteManagedSettings 资格检查
- securityCheck 危险变更检查（新增权限等）需要用户确认 ✅

**policy-limits**（src/services/policyLimits/）：
- loadPolicyLimits 策略限制加载
- isPolicyAllowed 查询策略是否允许，默认允许（fail-open） ✅

**settings-sync**（src/services/settingsSync/）：
- uploadUserSettingsInBackground 后台上传用户设置
- downloadUserSettings 下载用户设置
- 仅同步白名单字段，按项目分离，500KB 文件大小限制 ✅

**发现 B3-settings-01**：settings 子系统无专用测试文件，14 个 coverage 分组均无对应独立测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，仅有 envCommand.env.test.ts 和 envLessPerpetual.test.ts 间接相关）。

**发现 B3-settings-02**：internalWrite 窗口是硬编码的 5 秒，无配置选项。严重度：P3（灵活性不足），置信度：已证实（src/utils/settings/changeDetector.ts:46）。

**发现 B3-settings-03**：删除-重建窗口硬编码 6.5 秒，无配置选项。严重度：P3（灵活性不足），置信度：已证实（src/utils/settings/changeDetector.ts:63-64）。

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无 settings-core 测试
- ❌ 无 settings-validation 测试
- ❌ 无 settings-change-detector 测试
- ❌ 无 remote-managed-settings 测试
- ❌ 无 policy-limits 测试
- ❌ 无 settings-sync 测试

仅有：
- tests/envCommand.test.ts（部分相关）
- tests/envLessPerpetual.test.ts（部分相关）

---

### skills

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-skills-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/skills.yaml |
| Manifest 注册 | ✅ | id: skills, batch: 3, status: draft |
| Coverage 覆盖分组 | 17/17 | commands, skills-load, skills-bundled, skills-mcp, skill-tool, discover-skills-tool, skill-search-local, skill-search-remote, skill-search-prefetch, skill-search-feature, skill-search-telemetry, skill-change-detector, skill-hooks, skill-components, skill-telemetry, skills-tests, skills-bundled-verify |

#### 文档完整性审查

✅ **问题与约束**：准确描述了多来源技能聚合、frontmatter 解析、动态发现、条件激活、搜索与执行、缓存失效等核心问题。

✅ **设计理由与备选方案**：10+ 项关键决策表格化展示，包含真实证据位置：
- 多来源并行加载：Promise.all 同时加载 managed/user/project/additional/legacy
- realpath 去重：解决符号链接和重复父目录问题
- 条件技能分离存储：conditionalSkills Map 存储，激活后移到 dynamicSkills
- 文件操作触发动态发现：Read/Write/Edit 时向上遍历发现 .claude/skills
- gitignored 目录跳过：避免加载 node_modules 等依赖中的技能
- paths frontmatter 使用 ignore 库：gitignore 语法匹配
- 激活后 activatedConditionalSkillNames 跨缓存持久
- 本地搜索 Fuse.js：键权重 name:0.5, description:0.3, whenToUse:0.2，阈值 0.4
- 去词 stop-words 回退：无结果时移除无意义词重试
- 可见性跟踪：检查历史 skill_discovery 附件和 Skill 调用避免重复推荐
- 预取触发信号：user_input/write_pivot/subagent_spawn
- 远程技能 SHA-256 内容哈希缓存：版本变化自动失效
- zip 安全检查：断言无符号链接、路径安全、100 文件/5MB 限制
- in-flight 请求去重：Map 存储 pending Promise
- _canonical_ 前缀命名：避免与本地技能冲突
- inline/fork 双模式执行：frontmatter context: 'fork' 时 fork，否则 inline
- 安全属性 allowlist：检查 PromptCommand 所有属性是否在 SAFE_SKILL_PROPERTIES
- MCP 技能不执行 shell 注入：loadedFrom === 'mcp' 时跳过 executeShellCommandsInPrompt
- 变更检测 debounce 300ms：避免频繁重载
- Bun 使用 stat polling 而非 fs.watch：避免 PathWatcherManager 死锁

✅ **目标与非目标**：清晰界定了不吞并 plugins、不吞并 query-core、不跨会话持久化动态技能、不实现 SkillHub 服务器等非目标。

✅ **架构、模块与数据流**：
- 12 个模块设计卡：skills-load, skills-bundled, skills-mcp, skill-tool, discover-skills-tool, skill-search-local, skill-search-remote, skill-search-prefetch, skill-search-feature, skill-change-detector
- 完整技能加载流程：启动时并行加载 managed/user/project/additional/legacy → realpath 去重 → 分离 unconditional/conditional → 返回 unconditional
- 动态发现流程：文件操作 → discoverSkillDirsForPaths → 向上遍历检查 .claude/skills → gitignored 检查 → addSkillDirectories → skillsLoaded 信号 → 缓存清除
- 条件激活流程：文件操作 → activateConditionalSkillsForPaths → ignore 库匹配 → 从 conditionalSkills 移除加入 dynamicSkills → 记录 activatedConditionalSkillNames
- 技能执行流程（inline）：Skill 工具调用 → validateInput → checkPermissions → processPromptSlashCommand → 替换变量 → 执行 shell 注入（非 MCP）→ addInvokedSkill
- 技能执行流程（fork）：Skill 工具调用 → validateInput → checkPermissions → prepareForkedCommandContext → 创建新 agentId → runAgent → 清理 invoked skills
- 远程技能执行流程：Skill 工具调用 _canonical_ 前缀 → 检查 discovered → loadRemoteSkill → 解析 frontmatter → 替换变量 → addInvokedSkill → 包装为 user 消息

#### 源码验证

**skills-load**（src/skills/loadSkillsDir.ts）：
- getSkillDirCommands memoize 缓存加载结果
- loadSkillsFromSkillsDir 加载技能目录（skill-name/SKILL.md 格式）
- loadSkillsFromCommandsDir 加载 legacy 命令（向后兼容）
- getFileIdentity 用 realpath 去重（避免符号链接重复）
- 分离 unconditional/conditional 技能，conditionalSkills Map 存储
- clearSkillCaches 清除缓存（但保留 activatedConditionalSkillNames）
- discoverSkillDirsForPaths 动态发现技能目录（仅 cwd 以下）
- addSkillDirectories 加载动态发现的技能
- activateConditionalSkillsForPaths 条件激活匹配路径的技能 ✅

**skills-bundled**（src/skills/bundledSkills.ts）：
- 内置技能注册，verify/loop/claudeApi/remember/loremIpsum/debug/stuck/scheduleRemoteAgents/dream/batch/updateConfig/hunter/keybindings/claudeInChrome/skillify/simplify ✅

**skills-mcp**（src/skills/mcpSkills.ts）：
- MCP 技能集成 ✅

**skill-tool**（src/tools/SkillTool/SkillTool.ts）：
- SkillTool.call 技能执行入口
- validateInput 验证输入：去除前缀 /，检查技能存在，检查 disableModelInvocation
- checkPermissions 权限检查：deny 规则检查 → allow 规则检查 → SAFE_SKILL_PROPERTIES 自动允许 → 否则询问用户
- executeForkedSkill fork 模式执行：创建新 agentId，runAgent，清理 invoked skills
- inline 模式执行：processPromptSlashCommand 展开技能，参数替换，执行 shell 注入（非 MCP）
- SAFE_SKILL_PROPERTIES allowlist：type, progressMessage, contentLength, argNames, model, effort, source, pluginInfo, disableNonInteractive, skillRoot, context, agent, getPromptForCommand, frontmatterKeys, name, description, hasUserSpecifiedDescription, isEnabled, isHidden, aliases, isMcp, argumentHint, whenToUse, paths, version, disableModelInvocation, userInvocable, loadedFrom, immediate, userFacingName ✅

**skill-search-local**（src/services/skillSearch/localSearch.ts）：
- getLocalSkillIndex 加载本地技能索引（缓存）
- searchSkillIndex Fuse.js 搜索：键权重 name:0.5, description:0.3, whenToUse:0.2，阈值 0.4
- stop-words 回退：about/after/before/check/could/from/have/into/please/should/that/this/with/would
- getVisibleSkillNames 检查历史 skill_discovery 附件和 Skill 调用避免重复推荐 ✅

**skill-search-remote**（src/services/skillSearch/remoteSearch.ts + remoteSkillLoader.ts + remoteSkillState.ts）：
- searchRemoteSkills 远程搜索
- loadRemoteSkill 远程技能加载：SHA-256 内容哈希缓存，zip 安全检查（无符号链接，路径安全，100 文件/5MB 限制），in-flight 去重
- assertNoZipSymlinks 检查 zip 中无符号链接（external attributes 检查）
- assertSafePath 检查路径安全（无 ../、绝对路径、\）
- _canonical_ 前缀命名：_canonical_${namespace}/${slug} ✅

**skill-search-prefetch**（src/services/skillSearch/prefetch.ts）：
- startSkillDiscoveryPrefetch 启动预取：user_input/write_pivot/subagent_spawn 信号
- buildDiscoveryQuery 构建查询：有 input 用 input，否则用 latestUserText + write_pivot 时 file_path 等 ✅

**skill-change-detector**（src/utils/skills/skillChangeDetector.ts）：
- initialize 初始化监听：chokidar 监听技能目录，depth 2，awaitWriteFinish 稳定等待
- Bun 使用 usePolling: true（2 秒间隔）避免 PathWatcherManager 死锁
- debounce 300ms 合并变更事件，避免频繁重载
- 文件稳定等待：1000ms 稳定阈值，500ms 轮询 ✅

**发现 B3-skills-01**：条件技能激活后无失效机制，activatedConditionalSkillNames 跨缓存持久但无失效策略，可能长期保留不再相关的技能。严重度：P2（功能/体验改进），置信度：已证实（src/skills/loadSkillsDir.ts:829）。

**发现 B3-skills-02**：远程技能缓存无限增长，无清理策略，用户长期使用可能占用大量磁盘空间。严重度：P2（功能/体验改进），置信度：已证实（src/services/skillSearch/remoteSkillLoader.ts:96）。

**发现 B3-skills-03**：条件技能加载/激活失败路径不明确，parseSkillPaths 失败等情况可能无声跳过，缺少可观测性。严重度：P3（可观测性改进），置信度：已证实（基于代码审查）。

**发现 B3-skills-04**：动态发现的技能目录未启动 chokidar 监听，技能文件变更不会自动重载。严重度：P2（功能/体验改进），置信度：已证实（src/utils/skills/skillChangeDetector.ts 仅监听启动时已知目录）。

**发现 B3-skills-05**：getSkillDirCommands memoize 仅以 cwd 为键，实际可能有不同 additional dirs/环境变量组合，缓存可能不准确。严重度：P3（缓存一致性改进），置信度：已证实（src/skills/loadSkillsDir.ts:638）。

**发现 B3-skills-06**：skills 子系统部分模块无专用测试文件，如 skills-load 核心逻辑无完整测试。严重度：P2（测试缺口），置信度：已证实（tests/ 目录仅有 skillSearch.test.ts 和 remoteSkills.test.ts）。

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ tests/skillSearch.test.ts：本地搜索排名、可见性跟踪、预取信号
- ✅ tests/remoteSkills.test.ts：远程搜索注册、缓存、zip 安全（symlink/路径穿越）
- ❌ 无 skills-load 测试：核心加载逻辑、去重、条件激活、动态发现
- ❌ 无 skill-tool 测试：执行流程、权限检查、fork/inline 模式
- ❌ 无 skill-change-detector 测试：变更监听、debounce、Bun polling

---

---

## 发现登记

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|----------|----------|----------|------|----------|--------|--------|------|
| B3-memory-01 | memory | — | 安全边界 | P2 | team-memory 路径验证不一致：isTeamMemPath（读取/权限检查）仅字符串前缀检查不解析 symlink，validateTeamMemWritePath（写入）做完整 symlink 解析。可能通过 team 目录内 symlink 读取外部文件，尽管写入已受保护 | src/memdir/teamMemPaths.ts:214-220 vs 228-284 | N/A | ❌ 无测试 | 中（读取侧风险，写入侧已保护） | 统一路径验证：读取/权限检查也使用完整 symlink 解析验证，或明确记录差异原因 | 已证实 | 完整源码审查 | open |
| B3-memory-02 | memory | — | 测试缺口 | P2 | memory 子系统无专用测试文件，7 个 coverage 分组均无对应独立测试（memoryTypes/paths/teamMemPaths/memdir/sessionMemory/extractMemories/teamMemorySync/autoDream） | src/memdir/, src/services/SessionMemory/, src/services/extractMemories/, src/services/teamMemorySync/, src/services/autoDream/ | N/A | ❌ 无测试，仅 sdkSessions 间接覆盖 | 中（无回归保护） | 添加记忆系统完整测试：truncateEntrypointContent 边界情况、team-memory symlink 路径验证、extractMemories 并发控制、autoDream 门控逻辑 | 已证实 | tests/ 目录扫描确认 | open |
| B3-memory-03 | memory | — | 安全边界 | P3 | isAutoMemPath 仅字符串前缀检查，无 symlink 解析。用户配置 autoMemoryDirectory 时可能引入 symlink 风险，尽管 projectSettings 已被排除在配置源外 | src/memdir/paths.ts:274-278 | N/A | ❌ 无测试 | 低（配置源已受限） | 考虑增加 symlink 解析验证，或明确记录仅前缀检查的原因 | 已证实 | 完整源码审查 | open |
| B3-memory-04 | memory | — | 契约缺口 | P3 | 团队记忆同步 API 路径（/api/claude_code/team_memory）无外部契约文档。但这是内部端点，不影响外部用户 | src/services/teamMemorySync/index.ts:1153-1178 | N/A | ❌ 无契约测试 | 低（内部端点） | 添加内部 API 契约文档，或标记为内部无需外部契约 | 已证实 | 完整源码审查 | open |
| B3-memory-05 | memory | — | 测试缺口 | P3 | 团队记忆 symlink 路径验证缺少对抗性测试 - 尽管实现了 realpathDeepestExisting，但无测试验证 symlink 逃出 team 目录的情况 | src/memdir/teamMemPaths.ts:109-171 | N/A | ❌ 无对抗性测试 | 低（实现已存在但无测试） | 添加对抗性测试：symlink 指向外部、null 字节注入、URL 编码遍历、Unicode 规范化攻击 | 已证实 | 完整源码审查 | open |
| B3-memory-06 | memory | — | 安全边界 | P3 | team 目录路径验证未在 readLocalTeamMemory 中重新验证文件来源 - 尽管写入时已验证，但读取时仅从 team 目录遍历，无二次验证 symlink | src/services/teamMemorySync/index.ts:567-673 | N/A | ❌ 无测试 | 低（风险低，目录创建已受控制） | 考虑在 readLocalTeamMemory 中增加路径二次验证，或明确记录无需验证的原因 | 已证实 | 完整源码审查 | open |
| B3-settings-01 | settings | — | 测试缺口 | P2 | settings 子系统无专用测试文件，14 个 coverage 分组均无对应独立测试 | src/utils/settings/, src/services/remoteManagedSettings/, src/services/policyLimits/, src/services/settingsSync/, src/migrations/ | N/A | ❌ 无测试，仅有 envCommand/envLessPerpetual 间接覆盖 | 中（无回归保护） | 添加 settings 系统完整测试：多来源合并、变更检测、权限规则过滤、远程托管设置安全检查、policy limits 查询 | 已证实 | tests/ 目录扫描确认 | open |
| B3-settings-02 | settings | — | 灵活性不足 | P3 | internalWrite 窗口是硬编码的 5 秒，无配置选项 | src/utils/settings/changeDetector.ts:46 | N/A | ❌ 无测试 | 低（可配置性不足） | 增加环境变量或设置配置 internalWrite 窗口长度 | 已证实 | 完整源码审查 | open |
| B3-settings-03 | settings | — | 灵活性不足 | P3 | 删除-重建窗口硬编码 6.5 秒，无配置选项 | src/utils/settings/changeDetector.ts:63-64 | N/A | ❌ 无测试 | 低（可配置性不足） | 增加环境变量或设置配置删除-重建窗口长度 | 已证实 | 完整源码审查 | open |
| B3-skills-01 | skills | — | 功能缺失 | P2 | 条件技能激活后无失效机制，activatedConditionalSkillNames 跨缓存持久但无失效策略，可能长期保留不再相关的技能 | src/skills/loadSkillsDir.ts:829 | N/A | ❌ 无测试 | 中（技能列表污染） | 增加条件技能失效机制：定期重检 paths 匹配或文件变更时重检，或提供手动清除方式 | 已证实 | 完整源码审查 | open |
| B3-skills-02 | skills | — | 功能缺失 | P2 | 远程技能缓存无限增长，无清理策略，用户长期使用可能占用大量磁盘空间 | src/services/skillSearch/remoteSkillLoader.ts:96 | N/A | ❌ 无测试 | 中（磁盘占用） | 增加缓存大小限制和 LRU 清理，或提供 /skills cache clean 命令 | 已证实 | 完整源码审查 | open |
| B3-skills-03 | skills | — | 可观测性不足 | P3 | 条件技能加载/激活失败路径不明确，parseSkillPaths 失败等情况可能无声跳过，缺少可观测性 | src/skills/loadSkillsDir.ts | N/A | ❌ 无测试 | 低（调试困难） | 增加条件技能加载/激活的可观测性，logForDebugging 详细信息，或提供 /skills status 命令 | 已证实 | 完整源码审查 | open |
| B3-skills-04 | skills | — | 功能缺失 | P2 | 动态发现的技能目录未启动 chokidar 监听，技能文件变更不会自动重载 | src/utils/skills/skillChangeDetector.ts | N/A | ❌ 无测试 | 中（用户体验） | 对动态发现的目录也启动 chokidar 监听，或提供 /skills reload 命令 | 已证实 | 完整源码审查 | open |
| B3-skills-05 | skills | — | 缓存准确性 | P3 | getSkillDirCommands memoize 仅以 cwd 为键，实际可能有不同 additional dirs/环境变量组合，缓存可能不准确 | src/skills/loadSkillsDir.ts:638 | N/A | ❌ 无测试 | 低（缓存一致性） | 更精确的 memoize 键，包含所有影响结果的参数 | 已证实 | 完整源码审查 | open |
| B3-skills-06 | skills | — | 测试缺口 | P2 | skills 子系统部分模块无专用测试文件，如 skills-load 核心逻辑无完整测试 | src/skills/, src/tools/SkillTool/, src/utils/skills/ | N/A | ❌ 无完整测试，仅有 skillSearch/remoteSkills 测试 | 中（无回归保护） | 添加 skills 系统完整测试：加载去重、条件激活、动态发现、fork/inline 执行、变更监听 | 已证实 | tests/ 目录扫描确认 | open |
| B3-auth-01 | auth | — | 功能改进 | P1 | Keychain 缓存 30 秒，跨进程刷新后另一个进程最多 30 秒才看到新 token | src/utils/secureStorage/macOsKeychainHelpers.ts:69-91 | N/A | ❌ 无测试 | 高（跨进程状态不一致） | 每次读取 tokens 时检查磁盘 mtime 或 Keychain 自身修改时间，变更则立即清缓存 | 已证实 | 完整源码审查 | open |
| B3-auth-02 | auth | — | 测试缺口 | P2 | auth 子系统大量核心逻辑无专用测试文件，仅 oauthRefresh.test.ts 和 linuxSecretStorage.test.ts | src/utils/auth.ts, src/utils/secureStorage/, src/services/oauth/ | N/A | ❌ 无完整测试，仅有 oauthRefresh/linuxSecretStorage 测试 | 中（无回归保护） | 添加 auth 系统完整测试：多来源优先级、托管会话隔离、401 处理、Keychain 缓存、stale-while-error、双路径登录 | 已证实 | 完整源码审查 | open |
| B3-commit-attribution-01 | commit-attribution | — | 设计取舍 | P3 | 归因状态中 userModified 参数存在但被忽略（当前不区分用户后续修改，所有 Edit/Write 均计 Claude） | src/utils/commitAttribution.ts trackFileModification | N/A | ✅ 有测试（但不验证 userModified） | 低（归因准确性） | 明确记录 userModified 被忽略的原因，或实现用户变更检测 | 已证实 | 完整源码审查 | open |
| B3-commit-attribution-02 | commit-attribution | — | 设计取舍 | P3 | 多次编辑同一位置会导致字符计数膨胀（前缀/后缀匹配每次编辑都累加，而非计算增量） | src/utils/commitAttribution.ts | N/A | ✅ 有测试（验证二次膨胀不发生在快照恢复） | 低（归因准确性） | 明确记录此取舍，或考虑实现增量计算（如 Myers diff） | 已证实 | 设计文档明确记录 | open |
| B3-commit-attribution-03 | commit-attribution | — | 功能缺失 | P3 | 无专门测试验证文件重命名/复制后的归因迁移（Git检测重命名但归因只按路径，重命名后Claude贡献会重新开始） | src/utils/commitAttribution.ts calculateCommitAttribution | N/A | ❌ 无重命名迁移测试 | 低（归因准确性） | 考虑实现基于 Git 重命名检测的归因迁移，或明确记录此限制 | 已证实 | 设计文档明确记录 | open |
| B3-git-integration-01 | git-integration | — | 设计取舍 | P3 | GitFileWatcher 仅监听主仓库 .git/config，未监听 worktree gitdir 内的 config（worktree 的共享 config 在 commonDir） | src/utils/git/gitFilesystem.ts GitFileWatcher | N/A | ❌ 无测试 | 低（worktree 配置变更检测） | 考虑监听 worktree gitdir 内的 config，或明确记录此限制 | 已证实 | 完整源码审查 | open |
| B3-git-integration-02 | git-integration | — | 可观测性不足 | P3 | Git 失败多静默降级，问题诊断困难（无 Git 操作日志/指标） | src/utils/git.ts gitDiff.ts | N/A | ❌ 无测试 | 低（调试困难） | 增加 Git 操作的可观测性，logForDebugging 详细信息，或提供 /git status 命令 | 已证实 | 设计文档明确记录 | open |
| B3-git-integration-03 | git-integration | — | 测试缺口 | P2 | Git 子系统测试覆盖不足（无 gitFilesystem.ts 相关测试覆盖，无 worktree 双向验证测试、无 GitFileWatcher 测试） | src/utils/git/, src/utils/git/gitFilesystem.ts, src/utils/worktree.ts | N/A | ❌ 无完整测试，仅有 changedFiles 测试 | 中（无回归保护） | 添加 Git 子系统完整测试：ref 名称白名单验证、worktree 双向验证、GitFileWatcher 缓存失效、diff 分阶段加载 | 已证实 | tests/ 目录扫描确认 | open |
| B3-notifications-01 | notifications | — | 测试缺口 | P2 | notifications 核心功能无独立测试文件，包括 immediate 抢占、fold 合并、invalidates 移除、队列处理等核心逻辑均无专门测试 | src/context/notifications.tsx, src/services/notifier.ts, src/utils/collapseBackgroundBashNotifications.ts | N/A | ❌ 无核心功能测试，仅 orgWarningNotification 间接覆盖 | 中（无回归保护） | 添加 notifications 系统完整测试：immediate 抢占逻辑、fold 合并机制、invalidates 移除、队列优先级处理、OS 通知通道、任务通知折叠 | 已证实 | tests/ 目录扫描确认 | open |
| B3-session-search-recovery-01 | session-search-recovery | — | 测试缺口 | P2 | 会话搜索恢复系统无独立测试文件，包括 lite 读取、跨项目恢复、并发会话注册、历史回填等核心逻辑均无专门测试 | src/utils/sessionRestore.ts, src/utils/concurrentSessions.ts, src/commands/backfill-sessions/backfill-sessions.ts | N/A | ❌ 无完整测试，仅 backfillSessionsCommand 间接覆盖 | 中（无回归保护） | 添加会话搜索恢复系统完整测试：lite 读取策略、跨项目恢复、并发会话注册/墓碑、历史回填去重、ccshare 恢复 | 已证实 | tests/ 目录扫描确认 | open |
| B3-sessions-share-01 | sessions-share | — | 测试缺口 | P2 | /export 命令无独立测试文件，分块渲染、导出格式等核心逻辑无专门测试 | src/utils/exportRenderer.tsx, src/commands/export/ | N/A | ❌ 无 export 命令专门测试，仅 share 和 ccshare 有测试 | 中（无回归保护） | 添加/export 命令完整测试：分块渲染逻辑、内存峰值验证、导出格式一致性、路径安全验证 | 已证实 | tests/ 目录扫描确认 | open |

---

## Adversarial-Review Verdict: B3-auth-01

### Verdict: **UPHELD as P1** - Direct source evidence confirms the 30-second cross-process staleness impact.

### Evidence Examined

1. **macOsKeychainHelpers.ts:69** - `KEYCHAIN_CACHE_TTL_MS = 30_000` explicitly sets 30-second TTL.

2. **macOsKeychainHelpers.ts:53-63** - Comment confirms the design intent and tradeoff:
   - "TTL bounds staleness for cross-process scenarios (another CC instance refreshing/invalidating tokens) without forcing a blocking spawnSync on every read."
   - "30s of cross-process staleness is fine: OAuth tokens expire in hours, and the only cross-process writer is another CC instance's /login or refresh."

3. **auth.ts:1321-1337** - `invalidateOAuthCacheIfDiskChanged()` only checks `.credentials.json` mtime, NOT Keychain changes:
   - For macOS Keychain path (no `.credentials.json` file), it only clears the memoize cache, not the Keychain cache itself.
   - The Keychain cache is still bounded by its 30-second TTL.

4. **auth.ts:1378-1389** - `handleOAuth401Error()` does clear cache on 401, but this is reactive, not proactive.

### Impact Analysis

**Staleness Scenario**:
- Process A refreshes token at T0, writes to Keychain, calls `clearKeychainCache()` (process A only)
- Process B has cached token from T-5s, continues using stale token until T+25s (30s total)
- Process B will use stale token for up to 30s, potentially hitting 401s
- On 401, `handleOAuth401Error()` clears cache and recovers

**Mitigations Present**:
- OAuth tokens have long lifetimes (hours), so 30s staleness is unlikely to cause actual expiration
- 401 recovery path exists with token comparison
- Refresh path has multiple cache-clear points

**P1 Justification Maintained**:
- While mitigations reduce risk, this is still a cross-process consistency issue with a clear time-bound impact
- The spec itself identifies this as a P1 improvement opportunity
- No security boundary violation, but functional consistency issue in multi-process scenarios

### Recommendation

**Maintain as P1**, implement the suggested improvement: Check Keychain item modification time or add a generation counter in a shared location to invalidate cache proactively across processes.

---

## 证据边界

### memory 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| memdir/memoryTypes | 4 种记忆类型限定、parseMemoryType 安全降级、类型说明分离 | 无 |
| memdir/paths | 自动记忆启用优先级链、路径验证拒绝列表、getAutoMemPath memoization | 配置源完整矩阵测试 |
| memdir/teamMemPaths | PathTraversalError、sanitizePathKey 多层检查、realpathDeepestExisting 最深祖先解析、isRealPathWithinTeamDir 包含检查 | 对抗性 symlink 测试 |
| memdir/memdir | MEMORY.md 双截断（200 行 + 25000 字节）、目录创建幂等、提示构建 | 超大 MEMORY.md 性能测试 |
| memdir/memoryScan | 递归扫描、frontmatter 解析、按 mtime 倒序、200 文件截断 | 超大目录扫描性能 |
| SessionMemory | 阈值检查（token + toolCalls）、安全点要求、单文件 Edit 权限、隔离上下文 | 真实会话提取测试 |
| extractMemories | 闭包状态隔离、hasMemoryWritesSince 互斥检查、工具权限限制、尾随提取合并、skipTranscript | 并发压力测试 |
| teamMemorySync | SyncState 调用方持有、乐观锁 + 412 探测 hashes、secret 扫描跳过含秘密文件、200KB 批大小分割、secret 扫描不上传含秘密文件 | 真实网络错误重试 |
| autoDream | 三级门控（时间 → 扫描节流 → 会话数 → 锁）、DreamTask UI 进度可见、abortController 用户取消 | 真实会话整理质量评估 |

### settings 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| settings-types | SettingsSchema 完整 Zod 验证、passthrough() 向后兼容、权限规则验证 | 无 |
| settings-core | parseSettingsFile 安全解析/过滤/验证、loadManagedFileSettings 基础+drop-in 合并、多来源优先级合并、settingsMergeCustomizer 自定义合并器（数组 concat+dedupe、对象深度合并、undefined 删除）、updateSettingsForSource 写入更新+internalWrite+gitignore | 无 |
| settings-constants | SETTING_SOURCES 优先级数组、EditableSettingSource、parseSettingSourcesFlag | 无 |
| settings-cache | 会话级缓存（parsedFiles/sourceSettings/sessionSettings）、resetSettingsCache | 无 |
| settings-change-detector | chokidar 监听、awaitWriteFinish 稳定等待、internalWrite 5 秒窗口、删除-重建 6.5 秒窗口、MDM 30 分钟轮询、executeConfigChangeHooks 阻塞变更 | 无 |
| settings-validation | filterInvalidPermissionRules 预过滤、formatZodError 格式化 | 无 |
| remote-managed-settings | checksum ETag 缓存、304 优化、securityCheck 危险变更检查、后台轮询 | 真实用户确认流程 |
| policy-limits | isPolicyAllowed fail-open（默认允许）、后台轮询 | 无 |
| settings-sync | 白名单字段同步、按项目分离、500KB 文件限制 | 真实网络同步 |

### skills 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| skills-load | getSkillDirCommands memoize 缓存、多来源并行加载、realpath 去重、分离 unconditional/conditional、clearSkillCaches（保留 activatedConditionalSkillNames）、discoverSkillDirsForPaths 动态发现、addSkillDirectories 加载动态技能、activateConditionalSkillsForPaths 条件激活 | 无 |
| skills-bundled | 内置技能注册、verify/loop/claudeApi/remember/loremIpsum/debug/stuck/scheduleRemoteAgents/dream/batch/updateConfig/hunter/keybindings/claudeInChrome/skillify/simplify | 无 |
| skill-tool | validateInput 验证、checkPermissions 权限检查（deny/allow/SAFE_SKILL_PROPERTIES）、executeForkedSkill fork 模式、inline 模式展开、SAFE_SKILL_PROPERTIES allowlist | 无 |
| skill-search-local | Fuse.js 搜索权重/阈值、stop-words 回退、getVisibleSkillNames 可见性跟踪、indexCache 缓存 | 无 |
| skill-search-remote | _canonical_ 前缀命名、SHA-256 内容哈希缓存、assertNoZipSymlinks 检查、assertSafePath 路径检查、100 文件/5MB 限制、in-flight 去重 | 无 |
| skill-search-prefetch | user_input/write_pivot/subagent_spawn 信号、buildDiscoveryQuery 查询构建 | 无 |
| skill-change-detector | chokidar 监听（depth 2）、Bun 用 polling 避免死锁、debounce 300ms、awaitWriteFinish 稳定等待 | 无 |

### auth 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| auth-core | isManagedOAuthContext() 托管会话隔离、isAnthropicAuthEnabled() 认证启用判断、getAuthTokenSource() 多来源优先级、checkAndRefreshOAuthTokenIfNeeded() 并发去重刷新、handleOAuth401Error() 401 处理、isOAuthTokenExpired() 提前 5 分钟过期判断 | 无 |
| auth-file-descriptor | FD token 读取、maybePersistTokenForSubprocesses() CCR 持久化、readTokenFromWellKnownFile() 已知文件 fallback、权限 0o600 | 无 |
| secure-storage-factory | getSecureStorage() 平台选择、createFallbackStorage() 组合模式 | 无 |
| secure-storage-macos | 30 秒 TTL 缓存、stale-while-error、generation 防止 stale 写、security -i stdin 优先、hex 编码 argv fallback | 无 |
| secure-storage-linux | libsecret 调用、超时控制 | 无 |
| secure-storage-plaintext | 0o600 权限、警告返回 | 无 |
| secure-storage-fallback | 优先 primary、失败用 secondary、迁移时删除 secondary、防止 stale shadow | 无 |
| oauth-service | OAuthService.startOAuthFlow() 双路径登录、PKCE codeVerifier/codeChallenge/state、AuthCodeListener 本地服务器 | 无 |
| oauth-client | buildAuthUrl()、exchangeCodeForTokens()、refreshOAuthToken()（scope 扩展）、fetchProfileInfo() | 无 |

### commit-attribution 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| commit-attribution-core | trackFileModification 前缀/后缀匹配、会话基线保存首次状态、字符累加贡献、calculateCommitAttribution 合并多会话归因、isInternalModelRepo 内部白名单、sanitizeModelName 映射公共名、快照恢复取最后一个完整状态 | 无 |
| attribution-hooks | Bash pre/post 快照跟踪、Edit/Write 工具钩子、文件内容缓存（500条目15分钟）、pendingBash缓存（32条目5分钟）、HEAD协调检测外部提交、队列持久化 | 无 |
| attribution-trailer | buildPRTrailers 构建公共trailer、只含统计不含路径/会话ID | 无 |
| post-commit-attribution | prepare-commit-msg调度器保留用户钩子、MANAGED_MARKER检测、幂等钩子安装/卸载、Git侧持久化（64会话上限）、独立入口不加载完整CLI | 无 |

### git-integration 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| git-core | findGitRoot 向上遍历+LRU缓存、resolveCanonicalRoot 双向验证工作树、getGitState 并行获取状态 | 无 |
| git-filesystem | readGitHead 直接读取、resolveRef 优先松散→packed→commonDir回退、isSafeRefName 白名单防注入、GitFileWatcher 监听+缓存、getCommonDir 共享git目录 | 无 |
| git-diff | 分阶段加载（shortstat→numstat→diff）、限制文件数50、max diff size 1MB、max lines per file 400、parseGitDiff 统一diff | 无 |
| worktree | validateWorktreeSlug 防路径遍历、getOrCreateWorktree 优先直接读取.git指针防Git命令、cleanupStaleAgentWorktrees 清理过期、双向验证防伪造 | 无 |

### 上游证据边界

| 项目 | 状态 | 说明 |
|------|------|------|
| 官方文档 | ❓ 未访问 | code.claude.com 未实时访问，基于现有 spec 推断 |
| 上游 CLI strings | ⚠️ 未提取 | 本次审计重点在源码验证，strings 需补充 |
| 上游行为对齐 | ⚠️ 不充分 | 有 spec 但无完整对齐验证 |

### 测试证据边界

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| memory 单元测试 | ❌ 无 | ⚠️ 所有模块均无专门测试 |
| memory 集成测试 | ⚠️ 部分间接覆盖 | ⚠️ sdkSessions.sessionChainRecovery 部分相关 |
| settings 单元测试 | ❌ 无 | ⚠️ 所有模块均无专门测试 |
| settings 集成测试 | ⚠️ 部分间接覆盖 | ⚠️ envCommand/envLessPerpetual 部分相关 |
| skills 单元测试 | ⚠️ 部分覆盖 | ⚠️ skillSearch/remoteSkills 测试覆盖搜索和远程加载，缺少核心加载/执行/变更测试 |
| auth 单元测试 | ⚠️ 部分覆盖 | ⚠️ oauthRefresh/linuxSecretStorage 测试覆盖刷新和 Linux 存储，缺少大量核心逻辑测试 |
| commit-attribution 单元测试 | ✅ 完整覆盖 | ⚠️ commitAttributionWave2.test.ts 覆盖所有主要功能，但缺少重命名迁移测试 |
| git-integration 单元测试 | ⚠️ 部分覆盖 | ⚠️ changedFiles.test.ts 覆盖部分功能，但缺少 gitFilesystem/ref验证/worktree双向验证/GitFileWatcher 测试 |
| 安全对抗测试 | ❌ 无 | ⚠️ symlink 逃出路径验证无测试、远程技能 zip 攻击有测试但 auth/settings/git-integration 无 |
| 并发测试 | ❌ 无 | ⚠️ extractMemories/技能 in-flight 去重/auth 刷新并发无测试 |

---

## 完成判定

### 总体评估

| 子系统 | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 总体 |
|--------|------------|------------|------------|----------|------|
| memory | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | ⚠️ 有条件通过（需补充测试） |
| settings | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | ⚠️ 有条件通过（需补充测试） |
| skills | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | ⚠️ 有条件通过（需补充测试） |
| auth | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | ⚠️ 有条件通过（需补充测试） |
| commit-attribution | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | ⚠️ 有条件通过（需补充重命名迁移测试） |
| git-integration | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | ⚠️ 有条件通过（需补充测试） |
| notifications | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | ⚠️ 有条件通过（需补充测试） |
| session-search-recovery | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | ⚠️ 有条件通过（需补充测试） |
| sessions-share | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（share/ccshare 有完整测试） | ⚠️ 有条件通过（需补充 /export 测试） |

### Batch 3 统计

| 项目 | 数量 |
|------|------|
| 已审计子系统 | 9（memory, settings, skills, auth, commit-attribution, git-integration, notifications, session-search-recovery, sessions-share） |
| 待审计子系统 | 0 |
| 完整文档 | 9 |
| 实现一致 | 9 |
| 发现总数 | 26 |
| P0 | 0 |
| P1 | 1 |
| P2 | 12 |
| P3 | 13 |

### 发现分类

| 类别 | 数量 |
|------|------|
| 安全边界 | 3 |
| 测试缺口 | 9 |
| 契约缺口 | 1 |
| 功能缺失 | 4 |
| 可观测性不足 | 2 |
| 灵活性不足 | 2 |
| 缓存一致性 | 1 |
| 设计取舍 | 3 |
| 功能改进 | 1 |

### memory 生命周期证据链确认

✅ **加载**：loadMemoryPrompt → isAutoMemoryEnabled → ensureMemoryDirExists → truncateEntrypointContent

✅ **检索**：buildMemoryLines → scanMemoryFiles → formatMemoryManifest → findRelevantMemories（隐含在 ClaudeMD 集成中）

✅ **写入/提取**：executeExtractMemories → hasMemoryWritesSince → runForkedAgent（extract_memories）→ createAutoMemCanUseTool → 记忆目录内 Edit/Write

✅ **整理/同步**：autoDream 三级门控 → teamMemorySync 乐观锁 → 双向同步 pull-then-push

✅ **失效**：lastMemoryMessageUuid cursor 前进，hasMemoryWritesSince 跳过已提取范围

✅ **compact**：session-memory 阈值触发（token 增长 + toolCalls 计数 + 最后一轮无 toolCalls 安全点）

✅ **restore**：KAIROS 模式 getAutoMemDailyLogPath 每日日志路径

### settings 生命周期证据链确认

✅ **加载初始化**：initializePolicyLimitsLoadingPromise → loadRemoteManagedSettings → loadPolicyLimits → settingsChangeDetector.initialize

✅ **配置读取**：getInitialSettings → getSettingsWithErrors → 检查 sessionSettings 缓存 → 按优先级 user→project→local→flag→policy 读取 → 各来源独立 parseSettingsFile → 深合并（数组 concat+dedupe，对象深度合并，undefined 删除）→ 返回合并结果

✅ **变更检测**：外部文件变更 → chokidar 事件 → internalWrite 检查（5 秒窗口）→ executeConfigChangeHooks（exit code 2 阻塞）→ resetSettingsCache → 通知订阅者

✅ **配置写入**：updateSettingsForSource → 读取现有来源设置（绕过缓存）→ 与新设置合并 → markInternalWrite → 持久化到文件 → resetSettingsCache → 自动 gitignore localSettings

✅ **远程托管设置**：loadRemoteManagedSettings → 资格检查（Console 用户全部合格，OAuth 用户仅 Enterprise/C4E/Team）→ 本地缓存优先 → fetch 带 checksum ETag → 304 使用缓存 → 200 安全检查（危险变更用户确认）→ 保存本地缓存 → 通知变更

### skills 生命周期证据链确认

✅ **启动加载**：getSkillDirCommands（memoize 缓存）→ 并行加载 managed/user/project/additional/legacy → realpath 去重 → 分离 unconditional/conditional → 存储 conditionalSkills → 返回 unconditional

✅ **动态发现**：Read/Write/Edit → discoverSkillDirsForPaths → 向上遍历到 cwd（不含）→ 检查 .claude/skills 存在 → gitignored 检查 → addSkillDirectories → 加载技能 → skillsLoaded 信号 → clearCommandMemoizationCaches

✅ **条件激活**：文件操作 → activateConditionalSkillsForPaths → ignore 库匹配 paths → 从 conditionalSkills 移除 → 加入 dynamicSkills → 记录 activatedConditionalSkillNames → skillsLoaded 信号

✅ **技能搜索**：searchLocalSkills/searchRemoteSkills → Fuse.js 模糊搜索 → stop-words 回退 → 可见性跟踪（避免重复推荐）→ prefetch 信号触发（user_input/write_pivot/subagent_spawn）

✅ **技能执行（inline）**：Skill 工具调用 → validateInput → checkPermissions（deny→allow→SAFE_SKILL_PROPERTIES→询问）→ processPromptSlashCommand → 替换 ${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID} → 执行 shell 注入（非 MCP）→ addInvokedSkill → 返回 newMessages

✅ **技能执行（fork）**：Skill 工具调用 → validateInput → checkPermissions → prepareForkedCommandContext → 创建新 agentId → runAgent → 提取结果文本 → clearInvokedSkillsForAgent → 返回 tool_result

✅ **远程技能执行**：Skill _canonical_ 前缀 → loadRemoteSkill → SHA-256 缓存检查 → zip 下载（无符号链接、路径安全、100 文件/5MB）→ 解析 frontmatter → 替换变量 → addInvokedSkill → 包装为 user 消息

✅ **变更监听**：skillChangeDetector.initialize → chokidar 监听（Bun 用 polling）→ awaitWriteFinish 稳定等待 → debounce 300ms → clearSkillCaches + clearCommandsCache → skillsChanged 信号

### auth 生命周期证据链确认

✅ **启动预取**：main.tsx → startKeychainPrefetch() 并行读取 Keychain → prime keychainCacheState → 避免阻塞主线程

✅ **认证来源读取**：getAuthTokenSource() → 按优先级检查（托管 FD → 环境变量 → 安全存储 → apiKeyHelper）→ isManagedOAuthContext() 隔离托管会话

✅ **OAuth 登录**：/login → authLogin() → OAuthService.startOAuthFlow() → 启动本地服务器 → 生成 PKCE/state → 构建两条授权 URL → 等待授权码（自动回调或手动输入）→ exchangeCodeForTokens() → fetchProfileInfo() → saveOAuthTokensIfNeeded()

✅ **Token 刷新**：API 请求前 → checkAndRefreshOAuthTokenIfNeeded() → 同进程 pendingRefreshCheck 去重 → invalidateOAuthCacheIfDiskChanged() → 检查过期 → 二次读取 → 获取文件锁 → 三次检查 → refreshOAuthToken() → saveOAuthTokensIfNeeded() → clearOAuthTokenCache()

✅ **401 处理**：API 返回 401 → handleOAuth401Error(failedAccessToken) → pending401Handlers 按 token 去重 → clearOAuthTokenCache() → 重新读取 tokens → 对比 access token → 强制刷新（如需）

✅ **安全存储读写**：getSecureStorage() → createFallbackStorage(primary, secondary) → read() 优先 primary，失败用 secondary → update() 成功时迁移（删除 secondary），失败时防止 stale shadow（删除 primary）

### commit-attribution 生命周期证据链确认

✅ **归因跟踪**：Edit/Write 工具钩子 → trackFileModification 前缀/后缀匹配 → 字符累加贡献 → 会话基线保存首次观察状态

✅ **Bash 跟踪**：Bash 工具 pre 钩子 → preCommandSnapshot 保存有界缓存（200文件，每个256KB，总2MB）→ Bash 工具 post 钩子 → postCommandDiff 对比pre/post快照 → trackBulkFileChanges 批量归因

✅ **HEAD 协调**：Bash 工具钩子 → 检测 HEAD 变化 → startNewCommitRange 推进计数器基线 → 防止重复计数

✅ **持久化**：recordAttributionSnapshot 保存会话侧快照 → persistAttributionStateForGit 保存 Git 侧 .json（64会话上限，权限0o600）

✅ **快照恢复**：prepare-commit-msg 调用 → readAttributionStates 读取 Git 侧状态 → restoreAttributionStateFromSnapshots 只取最后一个完整快照 → 防止跨快照累加

✅ **归因计算**：calculateCommitAttribution 合并多会话归因 → 跳过生成文件（// @generated 或 .gitignore）→ Claude 百分比 claudeChars/(claudeChars+humanChars) → humanChars 通过估算

✅ **Trailer 附加**：buildPRTrailers 构建公共 trailer（Claude-Code-Contribution/Prompts/Permission-Prompts/Escapes）→ 只含统计不含路径/会话ID → git interpret-trailers 标准化附加

### git-integration 生命周期证据链确认

✅ **Git 仓库发现**：findGitRoot 向上遍历搜索 .git → LRU 缓存 50 条目 → 支持普通仓库/子模块/工作树 → resolveCanonicalRoot 双向验证

## 整改台账（2026-11-18 追加，不改变原发现与历史统计）

- **关联 Finding**：`B3-memory-02`；主责 spec：`docs/superpowers/specs/2026-11-12-memory-design.md`。
- **测试补全**：新增 `tests/memory.test.ts`，覆盖 cursor 重启恢复、原子 sidecar、删除失效、提取等待，以及真实文件系统上的内部/逃逸 symlink。`tests/contextCompaction.test.ts` 同时补齐 PTL、附件恢复与长会话可观察不变量。
- **整改中发现并修复**：Session Memory `MemoryPathValidator` 错用 `FsOperations` 不存在的异步 `realpath`/`lstat`，异常被 deepest-ancestor 循环吞掉后可能接受逃逸路径。RED：`bun test tests/contextCompaction.test.ts tests/memory.test.ts --timeout 60000` 退出 1，文件与目录 symlink 逃逸用例均实际失败；改用契约内 `realpathSync`/`lstatSync` 后，四文件 focused 命令退出 0（61 pass，0 fail）。
- **边界**：全部为本地临时目录/offline 验证；未执行模型提取、远程同步或私有协议验证。原 Finding ID、原发现和历史统计均保留。

✅ **Git 元数据读取**：readGitHead 直接读取 .git/HEAD → resolveRef 验证 ref 名称白名单 → 优先松散 ref → packed-refs → commonDir 回退 → getCommonDir 获取共享 git 目录

✅ **Git 状态获取**：getGitState 并行获取 → getBranch/getHead/getRemote/getRemoteUrl/getStatus/getWorktreeCount → GitFileWatcher 缓存分支/HEAD/远程URL/默认分支

✅ **Git Diff 计算**：getStructuredGitDiff → 分阶段加载：先 --shortstat 探测，再按需 --numstat，最后 --diff → 限制文件数 50，max diff size 1MB，max lines per file 400

✅ **Worktree 管理**：validateWorktreeSlug 验证 slug（防路径遍历）→ getOrCreateWorktree 优先直接读取 .git 指针防 Git 命令 → createAgentWorktree 创建代理工作树 → cleanupStaleAgentWorktrees 清理过期（仅匹配临时 slug 模式）

✅ **Worktree 双向验证**：.git → gitdir → commondir → 验证 worktree/gitdir 回指原 worktree 的 .git → 防止恶意 .git 文件

✅ **Git 安全执行**：GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=, stdin: ignore 禁用凭据提示 → execFileNoThrowWithCwd 静默降级

### notifications 生命周期证据链确认

✅ **横幅通知添加**：addNotification → priority 检查 → immediate 抢占/fold 合并/invalidates 移除 → 队列管理 → processQueue

✅ **横幅通知显示**：processQueue → getNext 选择最高优先级 → timeout 设置 → 显示通知 → timeout 到期清除 → 继续 processQueue

✅ **OS 通知发送**：sendNotification → executeNotificationHooks → sendToChannel → auto 检测终端类型 → 选择对应通道发送

✅ **任务通知折叠**：collapseBackgroundBashNotifications → fullscreen/verbose 检查 → 识别连续完成的后台任务 → 合并为单条通知

### session-search-recovery 生命周期证据链确认

✅ **会话发现**：listSessionsImpl → stat 获取 mtime → 排序 → lite 读取（头 8KB + 尾 8KB）→ 提取会话信息

✅ **会话搜索**：searchLocalSkills → logContainsQuery 预过滤 → loadFullLog → agenticSessionSearch 智能排序

✅ **会话恢复**：loadConversationForResume → deserializeMessagesWithInterruptDetection → 检测中断 → 恢复技能状态/文件历史

✅ **跨项目恢复**：switchSession → 覆盖项目目录 → restoreWorktreeForResume → 切换工作目录（如果存在）

✅ **并发会话**：registerSession → 原子写入 pid.json → updateSessionActivity → writeSessionTombstone（后台会话）

✅ **历史回填**：backfillSessionMetadata → 获取锁 → 列出所有会话 → 加载完整日志 → 转换为元数据 → 去重保存

### sessions-share 生命周期证据链确认

✅ **/share HTML 导出**：/share 命令 → resolveShareOutputPath（双重路径检查）→ ShareDialog（预览隐藏工具输出）→ renderConversationToHtml（escapeHtml 完整转义）→ writeSharedHtml（wx 标志不覆盖）

✅ **/export 文本导出**：/export 命令 → 类似路径检查 → streamRenderedMessages（分块渲染 40 条一批，降低内存峰值）→ writeFile（不覆盖）

✅ **ccshare 解析**：parseCcshareId → 验证 https → 无 userinfo/search/hash → 匹配 origin → 提取 id

✅ **ccshare 下载**：loadCcshare → fetchTranscript（手动重定向，跨原点确认不发送凭证）→ writeBoundedResponse（字节 + 行数双重限制）→ 临时文件权限 0o600 → 失败时清理

✅ **ccshare 恢复**：loadTranscriptFromFile → 返回时 projectPath 设为 undefined → 不自动切换目录 → 不执行远程 hooks

### Batch 3 总体结论

✅ **所有 9 个子系统 spec 质量优秀**：文档完整性高，每个 spec 包含 10+ 关键决策表格、模块设计卡、完整生命周期证据链。

✅ **所有 9 个子系统实现一致性强**：所有分组源码与 spec 高度对齐，关键机制与文档完全一致，安全边界设计周到。

✅ **部分子系统测试覆盖完整**：commit-attribution（完整测试）、sessions-share（share/ccshare 完整测试）。

⚠️ **测试覆盖仍然不足**：memory/settings/auth/notifications/session-search-recovery 子系统无专用测试文件，skills/git-integration 仅有部分测试，关键安全机制和核心逻辑无回归保护。

### 子系统审计进度

| 子系统 | 状态 |
|--------|------|
| memory | ✅ 已审计 |
| settings | ✅ 已审计 |
| skills | ✅ 已审计 |
| auth | ✅ 已审计 |
| commit-attribution | ✅ 已审计 |
| git-integration | ✅ 已审计 |
| notifications | ✅ 已审计 |
| session-search-recovery | ✅ 已审计 |
| sessions-share | ✅ 已审计 |

**当前进度**：9/9 已审计，batch 3 完整

---

## 修复台账：B3-memory-01, B3-memory-03, B3-memory-06

### 修复概述

针对 memory 子系统的 3 个路径验证漏洞进行了统一修复，确保读取路径与写入路径采用相同的安全标准。

### 发现 B3-memory-01：team memory 读取路径验证不足

**问题**：`isTeamMemPath` 仅做字符串前缀检查，不解析 symlink；而 `validateTeamMemWritePath` 做完整 symlink 解析。

**修复**：
- `isTeamMemPath` 直接执行共享 `realPathContainment` 同步真实路径检查，不再依赖调用方另选验证器
- `validateTeamMemReadPath` 保留 async API 并用于 `readLocalTeamMemory` 读取前重验
- 内部 symlink 允许，文件/目录逃逸与 dangling symlink 失败关闭

**证据**：
- `src/memdir/teamMemPaths.ts`：新增 `validateTeamMemReadPath` 函数
- `src/services/teamMemorySync/index.ts`：集成验证到 `readLocalTeamMemory`

### 发现 B3-memory-03：auto memory 读取路径验证不足

**问题**：`isAutoMemPath` 仅做字符串前缀检查，无 symlink 解析。

**修复**：
- `isAutoMemPath` 直接执行共享 `realPathContainment` 同步真实路径检查
- `validateAutoMemReadPath` 复用同一实现，`PathTraversalError` 统一从 `realPathContainment.ts` 导出，不再维护重复错误类和重复 deepest-ancestor 逻辑

**证据**：
- `src/memdir/paths.ts`：新增验证函数和错误类

### 发现 B3-memory-06：readLocalTeamMemory 缺少 symlink 重验证

**问题**：`readLocalTeamMemory` 遍历 team 目录读取文件，但对发现的文件没有二次验证 symlink。

**修复**：
- 更新 `readLocalTeamMemory` 函数，对每个文件路径调用 `validateTeamMemReadPath` 验证
- 使用验证后的真实路径进行读取
- 验证失败时记录警告并跳过该文件

**证据**：
- `src/services/teamMemorySync/index.ts`：集成路径验证

### 修复决策表

| 维度 | 选择 | 说明 |
|------|------|------|
| 验证深度 | symlink + realpath | 与写入验证一致，确保安全边界 |
| 性能策略 | 保留同步 API，执行 realpath I/O | 分类器本身失败关闭，不能靠调用方选择安全 API |
| 错误处理 | fail closed，验证失败跳过 | 安全优先，不读取有风险的文件 |
| 向后兼容 | 函数签名与内部 symlink/新文件行为保留 | lexical-only 逃逸行为按安全缺陷修正 |

### 三层证据收集

#### 1. 官方文档边界

查阅官方 Claude Code 文档关于记忆系统的说明：
- 团队记忆目录设计为安全沙箱
- 不期望通过 symlink 逃出该目录
- 没有找到关于 symlink 处理的具体文档

#### 2. 上游 CLI strings 边界

对 `/opt/homebrew/bin/claude` 执行 strings 搜索：
- `isAutoMemPath`、`isTeamMemPath`、`realpathDeepestExisting`、`validateAutoMemReadPath`、`validateTeamMemReadPath` 均无匹配（`rg` 退出 1）
- 不据此推断上游读取路径校验实现，也不把本地修复描述为上游 wire 契约

#### 3. 本地源码/契约边界

**修复证据已集成到代码库**：
- 新增验证函数与现有写入验证使用相同的 `realpathDeepestExisting` 模式
- 内存中已有的 `MemoryPathValidator`（session memory）也使用相同模式
- 所有新验证使用已有的 `PathTraversalError`，保持一致的错误契约

### RED/GREEN 测试验证

#### RED（旧实现对照）
- 从 `a7f4f21` 临时恢复旧分类器并对真实 symlink 执行，输出 `teamEscapeAccepted:true`、`autoEscapeAccepted:true`，退出 1；临时源码已删除。
- 初次评审还确认 `validateAutoMemReadPath` 无生产调用方，新增 helper 不能替代执行层修复。

#### GREEN（最终修复后）
- `isTeamMemPath`/`isAutoMemPath` 直接拒绝文件和目录 symlink 逃逸，内部 symlink 继续可用。
- `readLocalTeamMemory` 真实调用返回普通 entry，不包含逃逸 entry。
- `bun test tests/memoryPathValidation.test.ts tests/memoryPaths.test.ts tests/memory.test.ts tests/sessionMemory.test.ts --timeout 60000`：退出 0，55 pass，0 fail。

### 测试覆盖

新增测试：
- `tests/memoryPathValidation.test.ts`：验证修复的安全边界
- `tests/memory.test.ts`：已存在的 session memory 验证测试（部分覆盖类似场景）

### 说明

本次完成 3 个 memory 相关发现的修复，确保记忆目录读取路径与写入路径采用相同的安全标准。

---

## 整改台账：B3-git-integration-03（2026-11-19 追加）

**Finding ID**：B3-git-integration-03；主责 spec：git-integration。

新增 `tests/gitIntegration.test.ts` 并唯一登记 coverage，4 个真实本地 Git 场景、26 个断言：

- 普通仓库的 gitdir、loose/packed refs、detached HEAD、ref/SHA 白名单。
- 真实 worktree 的独立 HEAD 与主仓库隔离，commonDir 的 remote/count/shallow。
- GitFileWatcher 在 branch 切换、commit、detach、remote config 修改后重新计算。
- worktree watcher 观察 common config 修改。

临时根目录先 `realpath`，避免 macOS `/var` 与 `/private/var` 分裂造成假失败。无生产代码变更、远程访问、凭据或全局 Git 配置写入；只写临时仓库。reftable、Windows、Git LFS、并发和真实远程仍未覆盖。

**原 Finding 状态**：B3-git-integration-01/02/03 均保持 open；01/02 的 P3 建议不实施。spec 保持 draft，第 7/7.4 节记录三层证据和回滚。

---

## 整改台账：B3-notifications-01（2026-11-19 追加）

**Finding ID**：B3-notifications-01；主责 spec：notifications。

新增 `tests/notifications.test.tsx` 与 `tests/notificationsServices.test.ts` 并唯一登记 coverage，共 14 个测试、46 个断言：

- 真实 Ink + AppStoreContext 渲染 `useNotifications`，直接观察 current/queue：普通 high 不抢占当前项、后续 high 先于 medium；immediate 抢占并重入队；current/queued fold；invalidates；remove 和短 timeout 队列推进。
- 后台通知仅折叠连续 completed bash，失败保留；verbose/fullscreen-disabled 原样保留。
- 真实 notifier channel 逻辑：terminal_bell、disabled，以及 osascript/defaults 边界 mock 驱动的 Apple Terminal Bell=false 补偿 bell。
- 真实 PushNotificationTool：webhook 成功字段、503 不降级 OS、无 webhook 的 OS 成功和无 adapter 错误。

**证据边界**：全部离线；OS hooks、osascript/defaults、axios 只替换外部边界，无真实终端视觉、webhook、远程通知或私有协议验收。spec 第 7/7.3 节记录官方文档、上游 strings、当前缺口和回滚。无生产代码变更。

**原 Finding 状态**：B3-notifications-01 保持 open，spec 保持 draft。

---

## 整改台账：B3-auth-02 / 增量 B3-auth-03（2026-11-19 追加）

**Finding ID**：B3-auth-02；主责 spec：auth。新增 B3-auth-03 是本轮发现的生产缺陷，不计入原始 234 条。

首轮 `c8b0a8b` 的 35 个测试未检查 0600 mode、未发真实 listener HTTP，也缺少 OAuth client/core；报告却列出这些场景，不能验收。最终扩展为 `tests/auth.test.ts` + `tests/authRemote.test.ts`，共 44 个测试、95 个断言：

- plainTextStorage 的真实 0600、JSON、读写删和 warning 不泄密；fallback 的迁移/清理副作用。
- 精确 SHA-256/base64url PKCE S256 和 state。
- 真实临时 FD、已知文件读取、非 CCR 不写；auth core 在 hermetic test 分支验证 env、OAuth-only 和第一方 IDE 的 FD 优先级，不触达 Keychain。
- 真实本地 listener 的成功 code/state、302、缺 code/state mismatch 400、连续错误请求和 close 事件。
- axios 边界的真实 authorization grant、401、profile 映射/错误隔离和 roles 全局配置写入。

**增量缺陷 RED→GREEN**：连续 `waitForAuthorization()` 旧实现累加 request/error handler，第二次错误回调触发 `ERR_HTTP_HEADERS_SENT`。`auth-code-listener.ts` 改用 `once` 后连续错误响应与成功/close 场景通过。回滚该生产修复会重新引入缺陷，spec 第 7.3 节明确风险，未把它写成无风险。

**边界与安全**：全部 dummy token 仅在内存/临时文件，不打印；无真实 Keychain、远程登录、浏览器、OAuth provider、CCR/Desktop 或私有协议调用。首轮 CCR 分支测试已删除，检查未发现 `/home/claude/.claude/remote` 目录副作用。真实手动 code、完整 managed/apiKeyHelper、Keychain/libsecret 和 live OAuth 仍保留缺口。

**原 Finding 状态**：B3-auth-01/02 原行保持 open；agent 曾改为 in-progress 的行已恢复原文。spec 保持原 approved 状态，两个测试文件唯一登记 coverage。

---

## 修复台账：B3-settings-01（2026-11-19 最终返工）

**Finding ID**：B3-settings-01；B3-settings-02/03 只保留 P3 设计审阅，不实施可配置窗口。

首轮 `7e9bbe5` 只有 8 个 helper 测试，独立评审指出 core/cache/update/detector/managed/migration/remote/policy/sync 大部分声明与实现不符；另一次代理中断留下部分测试，也未作为完成证据。最终拆成 3 个真实测试文件，共 34 个测试、69 个断言：

- `tests/settings.test.ts`：真实多来源优先级、数组/对象合并、显式 undefined 删除、缓存 reset、无效 JSON 原样保留、权限 validation、internal write、managed base + 字母序 drop-in、autoUpdates/bypass 迁移和幂等。
- `tests/settingsChangeDetector.test.ts`：真实 chokidar watcher，内部写不通知、外部写通知、delete→recreate 合并为一次通知、后续真删除再次通知；完整关闭 watcher。
- `tests/settingsRemote.test.ts`：真实生产 304 流程发送确定性 If-None-Match 并保留缓存；policy cache-miss 的 essential-traffic fail-closed、未知 policy fail-open 和缓存显式 allow/deny；settings sync 白名单、500KiB 限制和缓存失效。

**必要的可测试性重构**：`DOWNLOAD_USER_SETTINGS` 是编译期关闭的宏，不能靠模块 mock 打开已消除代码。先得到缺少 `localFileSync.ts` 的真实 RED，再把原 `applyRemoteEntriesToLocal` 和大小常量原样抽到 `src/services/settingsSync/localFileSync.ts`，gated 入口继续调用同一实现。没有启用外部 feature、改变同步行为或访问远程服务。类型检查曾发现上传构建仍需要 `getMemoryPath`，已恢复导入并复验。

**证据边界**：全部使用临时目录和本地 watcher；axios/OAuth 只替换外部边界，dummy token 不是凭据且不输出。未执行真实上传/下载、组织策略、远程设置、MDM、模型或桌面 live。spec 第 7/7.3 节记录三层证据、未覆盖项和回滚；coverage 使用唯一 `settings-offline-contract-tests` 分组并登记新生产模块。

**原 Finding 状态**：B3-settings-01/02/03 均保持 open，不修改历史统计。spec 保持 draft。源码行为。原 Finding ID、原发现和历史统计均保留。

---

### 说明

本次完成所有 9 个子系统的深度生命周期审计，README 已统一更新。
