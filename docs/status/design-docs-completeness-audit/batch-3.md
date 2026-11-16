# Batch 3 审计报告：Memory

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 可用 | /opt/homebrew/bin/claude 存在 |
| 官方文档 | ❓ 未访问 | code.claude.com 未实时访问 |
| 审查范围 | memory 子系统 | 深度生命周期审计，仅 memory 子系统完整审查；其余 8 子系统保持 open 状态 |

### 启动状态 RED ✅

```bash
# 门禁运行验证（审计开始前）
# batch-3.md 不存在 → RED
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
| Spec 存在 | ⏳ | docs/superpowers/specs/2026-11-12-auth-design.md（待审计） |
| Coverage 存在 | ⏳ | docs/architecture/coverage/auth.yaml（待审计） |
| Manifest 注册 | ⏳ | id: auth, batch: 3, status: draft（待审计） |
| Coverage 覆盖分组 | ⏳ | 待审计 |

**状态**：保持 open，本次仅审计 memory 子系统。

---

### commit-attribution

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ⏳ | docs/superpowers/specs/2026-11-12-commit-attribution-design.md（待审计） |
| Coverage 存在 | ⏳ | docs/architecture/coverage/commit-attribution.yaml（待审计） |
| Manifest 注册 | ⏳ | id: commit-attribution, batch: 3, status: draft（待审计） |
| Coverage 覆盖分组 | ⏳ | 待审计 |

**状态**：保持 open，本次仅审计 memory 子系统。

---

### git-integration

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ⏳ | docs/superpowers/specs/2026-11-12-git-integration-design.md（待审计） |
| Coverage 存在 | ⏳ | docs/architecture/coverage/git-integration.yaml（待审计） |
| Manifest 注册 | ⏳ | id: git-integration, batch: 3, status: draft（待审计） |
| Coverage 覆盖分组 | ⏳ | 待审计 |

**状态**：保持 open，本次仅审计 memory 子系统。

---

### notifications

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ⏳ | docs/superpowers/specs/2026-11-12-notifications-design.md（待审计） |
| Coverage 存在 | ⏳ | docs/architecture/coverage/notifications.yaml（待审计） |
| Manifest 注册 | ⏳ | id: notifications, batch: 3, status: draft（待审计） |
| Coverage 覆盖分组 | ⏳ | 待审计 |

**状态**：保持 open，本次仅审计 memory 子系统。

---

### session-search-recovery

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ⏳ | docs/superpowers/specs/2026-11-12-session-search-recovery-design.md（待审计） |
| Coverage 存在 | ⏳ | docs/architecture/coverage/session-search-recovery.yaml（待审计） |
| Manifest 注册 | ⏳ | id: session-search-recovery, batch: 3, status: draft（待审计） |
| Coverage 覆盖分组 | ⏳ | 待审计 |

**状态**：保持 open，本次仅审计 memory 子系统。

---

### sessions-share

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ⏳ | docs/superpowers/specs/2026-11-12-sessions-share-design.md（待审计） |
| Coverage 存在 | ⏳ | docs/architecture/coverage/sessions-share.yaml（待审计） |
| Manifest 注册 | ⏳ | id: sessions-share, batch: 3, status: draft（待审计） |
| Coverage 覆盖分组 | ⏳ | 待审计 |

**状态**：保持 open，本次仅审计 memory 子系统。

---

### settings

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ⏳ | docs/superpowers/specs/2026-11-12-settings-design.md（待审计） |
| Coverage 存在 | ⏳ | docs/architecture/coverage/settings.yaml（待审计） |
| Manifest 注册 | ⏳ | id: settings, batch: 3, status: draft（待审计） |
| Coverage 覆盖分组 | ⏳ | 待审计 |

**状态**：保持 open，本次仅审计 memory 子系统。

---

### skills

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ⏳ | docs/superpowers/specs/2026-11-12-skills-design.md（待审计） |
| Coverage 存在 | ⏳ | docs/architecture/coverage/skills.yaml（待审计） |
| Manifest 注册 | ⏳ | id: skills, batch: 3, status: draft（待审计） |
| Coverage 覆盖分组 | ⏳ | 待审计 |

**状态**：保持 open，本次仅审计 memory 子系统。

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
| 安全对抗测试 | ❌ 无 | ⚠️ symlink 逃出路径验证无测试 |
| 并发测试 | ❌ 无 | ⚠️ extractMemories 并发控制无测试 |

---

## 完成判定

### 总体评估

| 子系统 | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 总体 |
|--------|------------|------------|------------|----------|------|
| memory | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | ⚠️ 有条件通过（需补充测试） |
| auth | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| commit-attribution | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| git-integration | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| notifications | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| session-search-recovery | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| sessions-share | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| settings | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| skills | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |

### Batch 3 统计

| 项目 | 数量 |
|------|------|
| 已审计子系统 | 1（仅 memory） |
| 待审计子系统 | 8（auth/commit-attribution/git-integration/notifications/session-search-recovery/sessions-share/settings/skills） |
| 完整文档 | 1 |
| 实现一致 | 1 |
| 发现总数 | 6 |
| P0 | 0 |
| P1 | 0 |
| P2 | 2 |
| P3 | 4 |

### 发现分类

| 类别 | 数量 |
|------|------|
| 安全边界 | 3 |
| 测试缺口 | 2 |
| 契约缺口 | 1 |

### memory 生命周期证据链确认

✅ **加载**：loadMemoryPrompt → isAutoMemoryEnabled → ensureMemoryDirExists → truncateEntrypointContent

✅ **检索**：buildMemoryLines → scanMemoryFiles → formatMemoryManifest → findRelevantMemories（隐含在 ClaudeMD 集成中）

✅ **写入/提取**：executeExtractMemories → hasMemoryWritesSince → runForkedAgent（extract_memories）→ createAutoMemCanUseTool → 记忆目录内 Edit/Write

✅ **整理/同步**：autoDream 三级门控 → teamMemorySync 乐观锁 → 双向同步 pull-then-push

✅ **失效**：lastMemoryMessageUuid cursor 前进，hasMemoryWritesSince 跳过已提取范围

✅ **compact**：session-memory 阈值触发（token 增长 + toolCalls 计数 + 最后一轮无 toolCalls 安全点）

✅ **restore**：KAIROS 模式 getAutoMemDailyLogPath 每日日志路径

### Batch 3 总体结论

✅ **memory spec 质量优秀**：文档完整性高，11 项关键决策，7 个模块设计卡，完整生命周期证据链。

✅ **memory 实现一致性强**：所有分组源码与 spec 高度对齐，关键机制与文档完全一致，安全边界设计周到（团队记忆多重路径验证、秘密扫描、工具权限限制）。

⚠️ **测试覆盖严重不足**：memory 子系统无专用测试文件，7 个 coverage 分组均无对应独立测试，关键安全机制（symlink 验证）无对抗性测试。

⚠️ **其余 8 子系统保持 open**：本次仅审计 memory 子系统，auth/commit-attribution/git-integration/notifications/session-search-recovery/sessions-share/settings/skills 待后续审计。

### 子系统审计进度

| 子系统 | 状态 |
|--------|------|
| memory | ✅ 已审计 |
| auth | ⏳ 保持 open |
| commit-attribution | ⏳ 保持 open |
| git-integration | ⏳ 保持 open |
| notifications | ⏳ 保持 open |
| session-search-recovery | ⏳ 保持 open |
| sessions-share | ⏳ 保持 open |
| settings | ⏳ 保持 open |
| skills | ⏳ 保持 open |

**当前进度**：1/9 已审计，其余 8 子系统保持 open

### 说明

本次仅完成 memory 子系统的深度生命周期审计，其余 8 子系统（auth/commit-attribution/git-integration/notifications/session-search-recovery/sessions-share/settings/skills）保持 open 状态。README 暂不更新，待全部 9 子系统审计完成后统一更新。

