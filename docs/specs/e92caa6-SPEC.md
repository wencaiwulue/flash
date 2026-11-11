---
commit: e92caa6639daf982d3299a485dfc6c0b5ff7f1e7
title: "Implement local skill discovery"
date: 2026-11-10T19:47:22+08:00
status: implemented
kind: component
---

# Implement local skill discovery

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交已经铺设 skill-discovery 类型、附件展示、query prefetch、提示词、命令缓存清理和远程边界，但核心仍是关闭的：isSkillSearchEnabled 固定 false，localSearch 只有空缓存清理，turn-zero 搜索返回空数组，prefetch 不启动且 collect 为空，DiscoverSkills 只有名称提示而没有工具实现。外部构建也未启用 EXPERIMENTAL_SKILL_SEARCH。既有 getSkillToolCommands、query/attachment 管线和 Fuse 依赖可复用，因此本提交应填充本地搜索与信号，而不是另建一套发现协议。

需要从本地 command 元数据构建可缓存的 Fuse 索引，为自然语言查询提供确定性关键词 fallback，并避免再次推荐消息中已经可见或调用过的技能。turn-zero、写入 pivot 和 subagent spawn 要产生同一 native discovery 附件，DiscoverSkills 则让模型主动复用完全相同的本地搜索；缓存必须随既有命令 reload 失效。远程 canonical skill 没有权威加载协议，仍须明确不可用，不能以本地结果或成功遥测伪造远程能力。

## 目标与非目标

### 目标

- 按 cwd 缓存本地技能元数据加载 Promise，排除 bundled/MCP，并提供失败驱逐和显式全量缓存清理。
- 以 name/description/whenToUse 加权 Fuse 排名，在完整查询零结果时进行去停用词的分词聚合 fallback。
- 从 discovery 附件与 Skill tool_use 计算可见名称，过滤重复推荐并记录 discoveredSkillNames 供既有遥测使用。
- 实现 user_input、write_pivot、subagent_spawn 三类信号，接入既有 turn-zero 阻塞附件和后续轮次 prefetch。
- 新增只读、并发安全的 DiscoverSkills 工具，与自动发现共享索引、fallback、可见性和 discovered-name 语义。
- 启用编译特性并保留 CLAUDE_CODE_SKILL_SEARCH 运行时 kill switch，将外部画像更新为 33 个非空工具。
- 维持远程 canonical loader/state/telemetry 的不可用边界，用离线测试和 at-commit 文档限定验证范围。

### 非目标

- 不实现远程 canonical-skill 加载、远程发现状态或远程成功/失败遥测，不生成 _canonical_ 结果。
- 不索引完整 SKILL.md 正文，不搜索 bundled/MCP，也不引入 LLM、embedding 或远程语义检索。
- 不新增文件系统 watcher、TTL 或基于 mtime 的自动缓存失效，依赖既有显式清理路径。
- 不恢复 assistant_turn 信号，不把 write-pivot 扩展为 Bash 等所有间接写入来源。
- 不把内存索引测试当作真实项目/用户/plugin 文件加载、真实模型选技能或端到端 query 验证。

## 方案架构与数据流

featureCheck 将固定 false 改为 !isEnvDefinedFalsy(CLAUDE_CODE_SKILL_SEARCH)，编译开关则由 build.ts 和 fixture 的 EXPERIMENTAL_SKILL_SEARCH 控制。编译进外部包后默认启用，运行时值 0/false/no/off 可关闭；条件 require 和工具注册仍允许未启用构建排除该功能。src/tools.ts 条件加载 DiscoverSkillsTool 并加入 getAllBaseTools，画像由 32 增至 33。

localSearch 的 indexCache 是 cwd 到 Promise<SkillIndexEntry[]> 的 Map，同时合并同 cwd 的并发加载与结果缓存。loadLocalSkillIndex 动态 import commands.js 以打断 commands→localSearch→commands 初始化环，复用 getSkillToolCommands(cwd)，排除 loadedFrom 为 bundled/mcp 的项，只保留 name/description/whenToUse，缺失 whenToUse 规范为空串。加载失败时无条件执行 indexCache.delete(cwd) 后重抛，并不确认 Map 中仍是原 Promise；若 clear 后新旧加载重叠，旧请求失败可能误删新请求的缓存项。clearSkillIndexCache 清空所有 cwd，避免失败或陈旧结果永久驻留。

searchSkillIndex 先 trim 空查询并按 exclude 过滤，再以 name=0.5、description=0.3、whenToUse=0.2 建 Fuse，threshold=0.4、ignoreLocation=true、includeScore=true、minMatchCharLength=2，limit 夹在 1 至 10、默认 5。完整查询先搜索一次；只有零结果时才小写切词，保留长度至少 3、非英文停用词的唯一 term，分别搜索后按 skill 聚合 matchedTerms 和最低 score，先比较匹配 term 数再比较 score。最终仅暴露 name/description/score，分数越低越好。

getVisibleSkillNames 只从两类消息提取精确名称：skill_discovery 附件的 skills[].name，以及 assistant 中名为 Skill 且 input.skill 为字符串的 tool_use。searchLocalSkills 再检查运行时开关，并行取得索引与可见集合，把可见名称作为 exclude 传给搜索；每个返回名称加入可选 context.discoveredSkillNames，供既有 SkillTool 的 was_discovered 事件判断。该过滤区分大小写，不从普通 skill_listing 文本或其他工具名推断。

buildDiscoveryQuery 仅在显式 input.trim() 非空时才 trim 并截到 2000 字符；否则将最近 user 文本与 write_pivot 字段原样拼接后截到 2000 字符，不逐段 trim。write_pivot 额外拼接最近写入 assistant 消息中 Write/Edit/NotebookEdit/MultiEdit 的 file_path、command、description 字符串字段。findWritePivot 只识别最后一个 discovery 附件之后的写入；只有实际生成附件后，该附件前的 pivot 才被抑制。搜索无结果或出错而未生成附件时，同一 pivot 可在后续 query 迭代重复触发。

startSkillDiscoveryPrefetch 的信号优先级为：显式 input 对应 user_input；有 agentId 且历史没有 discovery 对应 subagent_spawn；其后才检查 write_pivot，否则返回 null。getTurnZeroSkillDiscovery 固定走 user_input，并由既有 attachments 路径阻塞等待；后续 query 迭代以 input=null 启动异步 prefetch，与模型流和工具执行重叠，再在 post-tools 以 createAttachmentMessage 注入。subagent 附件通常下一轮可见，搜索异常在 discover/collector 降为 debug 与空结果。

DiscoverSkillsTool 输入为严格 query 非空字符串和可选整数 limit 1..10，call 直接复用 searchLocalSkills，输出 query 与 name/description 列表，不向模型暴露 Fuse score 或 whenToUse。工具只读、并发安全、maxResultSizeChars=20000，无结果返回明确文本，有结果提示通过 Skill(name) 加载完整说明；因此主动工具与自动附件共享排名、排除和 discovered-name 记录，但各自结果呈现不同。

缓存失效的外层实现位于 localSearch，接线复用父提交 commands.ts：clearCommandMemoizationCaches 清内层 command memoize 后调用 clearSkillIndexCache?.()，clearCommandsCache 再沿原路径清 plugin/skill 缓存；MCP list-changed 也保守调用清理，但 MCP 仍被新索引排除。没有 watcher/TTL。远程 remoteSkillLoader 继续抛 unavailable，remoteSkillState 对 _canonical_ 永远无发现项，logRemoteSkillLoaded 保持 no-op，本地 DiscoverSkills 不会跨入这些路径。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/services/skillSearch/localSearch.ts`，符号 `const indexCache = new Map<string, Promise<SkillIndexEntry[]>>` | 实现 cwd Promise 索引、加权 Fuse/fallback、可见性过滤、discovered-name 和显式缓存清理。 |
| 变更 | `src/services/skillSearch/prefetch.ts`，符号 `export function startSkillDiscoveryPrefetch(` | 实现查询构造、turn-zero、write-pivot/subagent 信号和 native discovery 附件。 |
| 变更 | `src/services/skillSearch/featureCheck.ts`，符号 `export function isSkillSearchEnabled(): boolean {` | 把固定禁用改为 CLAUDE_CODE_SKILL_SEARCH 的运行时 falsy kill switch。 |
| 变更 | `src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts`，符号 `export const DiscoverSkillsTool = buildTool({` | 新增严格输入、只读并发安全的模型工具，复用 searchLocalSkills 并返回精简匹配。 |
| 变更 | `src/tools.ts`，符号 `const DiscoverSkillsTool = feature('EXPERIMENTAL_SKILL_SEARCH')` | 在编译特性下加载 DiscoverSkills 并加入基础工具池。 |
| 变更 | `scripts/build.ts`，符号 `'EXPERIMENTAL_SKILL_SEARCH',` | 让外部 CLI/SDK 构建包含本地技能搜索实现。 |
| 变更 | `tests/skillSearch.test.ts`，符号 `describe('skill discovery prefetch'` | 新增六项内存索引/消息历史测试，覆盖排名、可见性、遥测、三类信号和 kill switch。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `'EXPERIMENTAL_SKILL_SEARCH',` | 让独立特性 bundle 与正式构建同步启用技能搜索。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.toolCount, JSON.stringify(profile)).toBe(33)` | 把外部画像固定为 33 个非空工具并包含 DiscoverSkills。 |
| 变更 | `docs/STATUS.md`，符号 `\| Remote canonical skills \| Not implemented \|` | 记录 83/352、33 工具、本地离线验证及远程 canonical 未实现边界。 |
| 变更 | `docs/RELEASE.md`，符号 `## Local skill discovery` | 记录 Fuse/fallback/信号/工具/缓存发布范围和离线验证、远程不可用声明。 |
| 复用 | `src/commands.ts`，符号 `clearSkillIndexCache?.()` | 复用命令 memoization 清理后的外层索引失效，避免只清内层缓存留下旧 Fuse 数据。 |
| 复用 | `src/query.ts`，符号 `startSkillDiscoveryPrefetch` | 复用后续 query 迭代的异步 prefetch 与 post-tools collect/attachment 注入。 |
| 复用 | `src/utils/attachments.ts`，符号 `getTurnZeroSkillDiscovery` | 复用真实用户输入的阻塞 turn-zero 发现、skip 防护和 bundled/MCP listing 分工。 |
| 复用 | `src/utils/messages.ts`，符号 `Skills relevant to your task:` | 复用 discovery 附件到 system-reminder 的展示及 Skill(name) 加载指导。 |
| 复用 | `src/constants/prompts.ts`，符号 `function getDiscoverSkillsGuidance(): string \| null {` | 复用主 agent/subagent 的 DiscoverSkills 使用提示，不新增第二套指导。 |
| 复用 | `src/tools/SkillTool/SkillTool.ts`，符号 `was_discovered:` | 复用 discoveredSkillNames 的 Skill 调用遥测及既有远程分支，发现工具本身不执行技能。 |
| 复用 | `src/services/skillSearch/remoteSkillLoader.ts`，符号 `export async function loadRemoteSkill(` | 保留外部构建远程加载明确 unavailable 的异常边界。 |
| 复用 | `src/services/skillSearch/remoteSkillState.ts`，符号 `export function getDiscoveredRemoteSkill(` | 保留 _canonical_ 远程发现状态永远为空的实现。 |
| 复用 | `src/services/skillSearch/telemetry.ts`，符号 `export function logRemoteSkillLoaded(` | 保留远程加载遥测 no-op，不随本地发现伪造远程成功事件。 |

## 关键决策与工程取舍

- 索引只存搜索所需元数据而非完整技能正文，降低索引体积和提示暴露；模型选中后仍须用 Skill 加载完整指令，发现与执行保持两个阶段。
- 缓存 Promise 而非仅缓存已完成数组，使同 cwd 并发调用共享一次加载；失败时驱逐对应项，避免一次瞬时错误锁死后续重试。
- fallback 仅在完整 Fuse 查询零结果时触发，避免覆盖已有排名；采用确定性的 Unicode 切词、英文停用词和匹配数/score 排序，不引入模型或网络依赖。
- 可见性以结构化附件和 Skill tool_use 为准，而非模糊扫描文本，减少误排除；代价是其他展示形式不会参与过滤。
- 三类信号共用 discover 和 native skill_discovery 附件，使自动推荐、工具搜索和 UI/消息渲染使用同一数据契约，score 只留在搜索内部。
- 运行时 kill switch 与编译 feature 分层，外部包默认可用但可快速关闭；kill switch 不主动清缓存或 discovered-name 集合，语义仅限于后续搜索。
- 远程能力继续显式不可用，不用本地命中填充 canonical 状态或记录远程成功，保持协议缺失时的诚实边界。

### 备选方案与回溯分析

- 回溯性比较：可以每次查询重新读取全部命令，避免缓存陈旧，却会把磁盘和命令加载成本放入 turn-zero；实际按 cwd 缓存 Promise，并接入既有命令 reload 的显式失效。
- 回溯性比较：可以对所有自然语言查询无条件分词并合并结果，召回可能更高，却会扰动完整查询已经有效的 Fuse 排名；实际只在零结果时启用 fallback。
- 回溯性比较：可以用 embedding/LLM 选择技能获得语义匹配，但需要额外模型、凭据和不确定性；实际完全离线使用 Fuse 与关键词聚合，效果受元数据和切词启发式限制。
- 回溯性比较：可以让 DiscoverSkills 直接返回完整技能正文，减少一次工具调用，却扩大上下文并混淆发现与执行；实际只返回名称/描述，由 Skill 按权限和既有流程加载。
- 回溯性比较：可以模拟远程 canonical 搜索以统一 UI，但没有权威协议会制造不可加载结果和虚假遥测；实际只交付本地发现并保持远程 stub。

## 安全与协议边界

- 新搜索处理本地 command 元数据，不增加网络协议；用户文本和 write-pivot 的文件路径、命令、描述进入本地查询，没有证据表明被发送到远程服务。
- project/user/plugin 等来源的描述会经 system-reminder 注入模型上下文，不可信项目或插件元数据仍是提示注入面，但发现结果不会自动执行技能正文。
- DiscoverSkills 标记只读且并发安全，只返回名称/描述；完整技能仍需另一次 Skill 调用并沿用其权限与来源处理。
- 严格 limit 和结果大小上限约束工具输出，空查询不建 Fuse；关闭运行时开关后 searchLocalSkills 直接返回空集合。
- 自动 prefetch 的搜索错误写 debug 并降为无附件，避免阻断主 query，但也可能隐藏损坏配置；直接 DiscoverSkills.call 不具有同一层 discover catch。
- 远程 loader/state/telemetry 未伪造能力或成功事件，_canonical_ 不会因为本地同名技能而获得可执行含义。

## 验收标准

- 同 cwd 的索引加载共享 Promise，bundled/MCP 被排除，加载失败可重试，clearSkillIndexCache 能使命令 reload 后的下次搜索重建。
- Fuse 使用指定字段权重与阈值，空查询返回空、exclude/limit 生效；完整查询零结果时按有效 term 数和最低 score 聚合 fallback。
- 已出现在 discovery 附件或由 Skill 调用的名称不再推荐，搜索结果名称进入 discoveredSkillNames。
- turn-zero 生成 native/user_input 附件，write-pivot 仅处理最近附件后的四种写入工具，首次无 discovery 的 subagent 使用 subagent_spawn。
- DiscoverSkills 与自动路径返回一致的本地匹配和排除语义，只暴露名称/描述并提示用 Skill 加载。
- 外部特性包加载 33 个非空工具并包含 DiscoverSkills，运行时 0/false/no/off 可关闭搜索。
- STATUS 将 Local skill search 限定为 offline index/build，Remote canonical skills 标为 Not implemented；测试新增不单独作为执行证据。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | localSearch.ts 实现 cwd Promise 缓存、非 bundled/MCP 元数据索引、加权 Fuse、零结果关键词 fallback、可见性排除和 discovered-name 记录。 | `src/services/skillSearch/localSearch.ts`，符号 `export function searchSkillIndex(`，revision `commit` |
| diff-observed | prefetch.ts 实现 user_input/write_pivot/subagent_spawn 的优先级、2000 字符查询构造、四种写入工具和最近 discovery 边界。 | `src/services/skillSearch/prefetch.ts`，符号 `export function startSkillDiscoveryPrefetch(`，revision `commit` |
| diff-observed | DiscoverSkillsTool 使用严格 query/limit 输入并直接调用 searchLocalSkills，工具注册由 EXPERIMENTAL_SKILL_SEARCH 条件控制。 | `src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts`，符号 `export const DiscoverSkillsTool = buildTool({`，revision `commit` |
| test-added | 新增 skillSearch 测试以三条内存索引覆盖排名/exclude/limit、两类可见名称、discovered-name 遥测、turn-zero、write-pivot/subagent 和 kill switch，共 6 tests、23 assertions；此项只声明测试加入。 | `tests/skillSearch.test.ts`，符号 `describe('local skill index'`，revision `commit` |
| test-added | 外部画像把工具数从 32 更新为 33并加入 DiscoverSkills，fixture 同步 EXPERIMENTAL_SKILL_SEARCH；未直接调用 DiscoverSkillsTool.call。 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.toolCount, JSON.stringify(profile)).toBe(33)`，revision `commit` |
| recorded-command-pass | 提交内 STATUS 的 Verified evidence 记录 bun test 通过 83 tests、352 assertions；这是 at-commit 历史记录，不是本次文档编写重新执行所得。 | `docs/STATUS.md`，符号 ``bun test``，revision `commit` |
| recorded-command-pass | 提交内 STATUS 记录 typecheck 零 TypeScript 错误、build 完成 CLI/SDK/declarations，能力矩阵把 Local skill search 标为 Verified (offline index/build)。 | `docs/STATUS.md`，符号 `\| Local skill search \| Verified (offline index/build) \|`，revision `commit` |
| recorded-command-pass | RELEASE 的 Local skill discovery 段记录 83/352、typecheck、build、declarations、CLI startup smoke 和 33-tool profile 通过，并明确远程 canonical loading 仍不可用。 | `docs/RELEASE.md`，符号 `## Local skill discovery`，revision `commit` |
| not-recorded | 没有真实模型选择/加载本地技能、真实项目或插件文件索引、远程 canonical round trip、直接 DiscoverSkills.call 或缓存 reload 的专门执行证据。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- 自然语言 fallback 没有专门构造“完整查询零结果、分词后命中”的测试，真实中文等未分词文本和低质量非零 Fuse 结果也未覆盖。
- 真实 getLocalSkillIndex 的磁盘加载、cwd 分区、并发 Promise 合并、失败驱逐及命令/MCP reload 后重建没有直接测试。
- 缓存无 watcher/TTL，直接修改磁盘元数据而未触发命令 reload 时可能陈旧；clear 后新旧加载重叠时，旧请求失败可能误删新 Promise。搜索使用全局 getCwd，不能按 context 指定另一 cwd；未生成附件的 write pivot 也可能重复触发。
- 可见性只识别 discovery 附件与 Skill tool_use，write-pivot 只覆盖四种写入工具，subagent 仅在没有任何先前 discovery 时触发。
- DiscoverSkillsTool.call、schema、结果文本及真实 query/attachment/subagent/model 端到端行为未由新增测试直接执行。
- STATUS 的 External feature profile 枚举未补 EXPERIMENTAL_SKILL_SEARCH，且 cache invalidation 的文档验证表述比新增测试直接覆盖更宽。
- 远程 canonical 加载与遥测仍未实现，某些既有错误文案提到 DiscoverSkills 找 remote skills，与新工具 local-only 能力不完全一致。
