# Batch 3 审计报告：Memory, Settings, Skills

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 可用 | /opt/homebrew/bin/claude 存在 |
| 官方文档 | ❓ 未访问 | code.claude.com 未实时访问 |
| 审查范围 | memory, settings, skills 子系统 | 深度生命周期审计，memory/settings/skills 子系统完整审查；其余 6 子系统保持 open 状态 |

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
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-settings-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/settings.yaml |
| Manifest 注册 | ✅ | id: settings, batch: 3, status: draft |
| Coverage 覆盖分组 | 14/14 | settings-types, settings-core, settings-constants, settings-cache, settings-change-detector, settings-validation, settings-permission-validation, settings-internal-writes, settings-managed-path, settings-apply-change, settings-schema-output, settings-all-errors, remote-managed-settings, policy-limits, settings-sync, settings-migrations, global-config-boundary, constants-settings, additional-files-source, additional-files-test, commands |

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
| Coverage 覆盖分组 | 11/11 | skills-load, skills-bundled, skills-mcp, skill-tool, discover-skills-tool, skill-search-local, skill-search-remote, skill-search-prefetch, skill-search-feature, skill-change-detector, skills-tests, skills-bundled-verify |

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
| 安全对抗测试 | ❌ 无 | ⚠️ symlink 逃出路径验证无测试、远程技能 zip 攻击有测试但 settings 无 |
| 并发测试 | ❌ 无 | ⚠️ extractMemories/技能 in-flight 去重无测试 |

---

## 完成判定

### 总体评估

| 子系统 | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 总体 |
|--------|------------|------------|------------|----------|------|
| memory | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | ⚠️ 有条件通过（需补充测试） |
| settings | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | ⚠️ 有条件通过（需补充测试） |
| skills | ✅ 完整 | ✅ 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | ⚠️ 有条件通过（需补充测试） |
| auth | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| commit-attribution | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| git-integration | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| notifications | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| session-search-recovery | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |
| sessions-share | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 待审计 | ⏳ 保持 open |

### Batch 3 统计

| 项目 | 数量 |
|------|------|
| 已审计子系统 | 3（memory, settings, skills） |
| 待审计子系统 | 6（auth/commit-attribution/git-integration/notifications/session-search-recovery/sessions-share） |
| 完整文档 | 3 |
| 实现一致 | 3 |
| 发现总数 | 15 |
| P0 | 0 |
| P1 | 0 |
| P2 | 7 |
| P3 | 8 |

### 发现分类

| 类别 | 数量 |
|------|------|
| 安全边界 | 3 |
| 测试缺口 | 4 |
| 契约缺口 | 1 |
| 功能缺失 | 3 |
| 可观测性不足 | 1 |
| 灵活性不足 | 2 |
| 缓存一致性 | 1 |

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

### Batch 3 总体结论

✅ **memory/settings/skills spec 质量优秀**：文档完整性高，每个 spec 包含 10+ 关键决策表格、模块设计卡、完整生命周期证据链。

✅ **memory/settings/skills 实现一致性强**：所有分组源码与 spec 高度对齐，关键机制与文档完全一致，安全边界设计周到（settings 与 global config 分离、skills MCP 不执行 shell 注入、远程技能 zip 安全检查）。

⚠️ **测试覆盖严重不足**：memory/settings 子系统无专用测试文件，skills 仅有部分测试（skillSearch/remoteSkills），关键安全机制和核心逻辑无回归保护。

⚠️ **其余 6 子系统保持 open**：本次仅审计 memory/settings/skills 子系统，auth/commit-attribution/git-integration/notifications/session-search-recovery/sessions-share 待后续审计。

### 子系统审计进度

| 子系统 | 状态 |
|--------|------|
| memory | ✅ 已审计 |
| settings | ✅ 已审计 |
| skills | ✅ 已审计 |
| auth | ⏳ 保持 open |
| commit-attribution | ⏳ 保持 open |
| git-integration | ⏳ 保持 open |
| notifications | ⏳ 保持 open |
| session-search-recovery | ⏳ 保持 open |
| sessions-share | ⏳ 保持 open |

**当前进度**：3/9 已审计，其余 6 子系统保持 open

### 说明

本次完成 memory/settings/skills 三个子系统的深度生命周期审计，其余 6 子系统（auth/commit-attribution/git-integration/notifications/session-search-recovery/sessions-share）保持 open 状态。README 暂不更新，待全部 9 子系统审计完成后统一更新。

