---
commit: e92caa6639daf982d3299a485dfc6c0b5ff7f1e7
title: "Implement local skill discovery"
date: 2026-11-10T19:47:22+08:00
status: implemented
kind: component
---

# 实施计划：Implement local skill discovery

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要从本地 command 元数据构建可缓存的 Fuse 索引，为自然语言查询提供确定性关键词 fallback，并避免再次推荐消息中已经可见或调用过的技能。turn-zero、写入 pivot 和 subagent spawn 要产生同一 native discovery 附件，DiscoverSkills 则让模型主动复用完全相同的本地搜索；缓存必须随既有命令 reload 失效。远程 canonical skill 没有权威加载协议，仍须明确不可用，不能以本地结果或成功遥测伪造远程能力。

- 确认父提交的附件、query prefetch、UI、提示词、缓存清理和远程 stub 已存在，核心搜索/信号仍为 no-op。
- 确认 getSkillToolCommands 能提供本地元数据，Fuse 依赖已存在，动态 import 可打断 commands 初始化环。
- 确认 turn-zero 与后续轮次具有不同阻塞/异步时序，三类信号必须共享附件类型。
- 把本地离线索引/构建验证与真实模型、磁盘 reload 和远程 canonical 验证分别规划。

## 复用与兼容处理

### 复用现有实现

- 复用 getSkillToolCommands、clearCommandMemoizationCaches 和 MCP 通知中的 clearSkillIndexCache 钩子。
- 复用 attachments/query/messages/AttachmentMessage 的阻塞 turn-zero、异步 prefetch、system-reminder 和 CLI 展示。
- 复用 DiscoverySignal、DISCOVER_SKILLS_TOOL_NAME、ToolUseContext.discoveredSkillNames 和 SkillTool was_discovered。
- 复用主 agent/subagent 提示、feature 条件注册和独立 bundle 画像，不重写注册或 UI 框架。
- 复用 remoteSkillLoader/remoteSkillState/telemetry 的显式不可用实现，保持本地与远程边界。

### 兼容、迁移与生命周期

- EXPERIMENTAL_SKILL_SEARCH 未编译时，条件 require/DCE 仍可排除工具和附件路径；编译后默认开启，可用运行时 falsy 值关闭。
- 启用后普通 skill listing 缩到 bundled/MCP，本地 project/user/plugin 等改由发现机制补充，这是既有管线被激活后的可见性变化。
- searchLocalSkills 的可选 index 注入保持原三参数调用兼容，同时支持纯离线测试。
- DiscoverSkills 只增加基础工具，Skill(name) 仍是加载完整技能的既有入口，外部画像契约由 32 变为 33。
- 运行时 kill switch 不会清已有索引或 discovered-name 集合，恢复开启后仍按原缓存和可见性状态运行。

## 文件级实施步骤

### 1. 构建可失效的本地元数据索引

在 localSearch.ts 定义 SkillIndexEntry/LocalSkillMatch 和 cwd Promise Map，动态加载 commands 并复用 getSkillToolCommands，排除 bundled/MCP、规范 whenToUse。缓存进行中和完成加载，失败删除对应项，clearSkillIndexCache 清空 Map，使 commands.ts 既有清理能够触发下次重建。

涉及位置：`src/services/skillSearch/localSearch.ts`、`src/commands.ts`

### 2. 实现 Fuse 排名和自然语言 fallback

对空查询、exclude 和 limit 先作规范，以 0.5/0.3/0.2 权重及 threshold 0.4 建 Fuse。完整查询无结果时进行小写 Unicode 切词、长度/停用词过滤和唯一 term 搜索，按 skill 聚合匹配 term 数及最低 score，最终只返回名称、描述和分数。

涉及位置：`src/services/skillSearch/localSearch.ts`

### 3. 加入可见性过滤与发现遥测

从 skill_discovery 附件和 Skill tool_use 收集精确名称，searchLocalSkills 并行取索引/可见集合并作为排除项；搜索前再检查 kill switch，返回时写入 context.discoveredSkillNames。保持该集合供父提交 SkillTool 的 was_discovered 使用，不扫描任意文本或调用远程状态。

涉及位置：`src/services/skillSearch/localSearch.ts`、`src/tools/SkillTool/SkillTool.ts`

### 4. 实现三类发现信号与查询构造

在 prefetch.ts 实现最近用户文本和显式 input 的 2000 字符查询，write-pivot 追加四种写入工具的路径/命令/描述。findWritePivot 只看最近 discovery 之后的 assistant 写入；启动优先级依次为 user_input、无历史 discovery 的 subagent_spawn、write_pivot。turn-zero 走 user_input，后续复用 query 的异步 prefetch 和 post-tools 附件。

涉及位置：`src/services/skillSearch/prefetch.ts`、`src/query.ts`、`src/utils/attachments.ts`

### 5. 暴露 DiscoverSkills 并接通运行时开关

featureCheck.ts 使用 isEnvDefinedFalsy 提供运行时关闭；新工具以严格 query/limit 调用 searchLocalSkills，返回名称/描述并提示 Skill 加载。tools.ts 在 EXPERIMENTAL_SKILL_SEARCH 下注册，build.ts 与画像 fixture 开启同一 feature，保持未编译构建的条件排除。

涉及位置：`src/services/skillSearch/featureCheck.ts`、`src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts`、`src/tools.ts`、`scripts/build.ts`、`tests/fixtures/verify-enabled-features.ts`

### 6. 保持展示、缓存和远程边界一致

确认 messages/attachments 继续把本地发现作为可重新注入的 system-reminder，普通 listing 与本地索引对 bundled/MCP 的排除互补；命令 reload 必须同时清内层 memoize 和外层索引。检查远程 loader/state/telemetry 仍不可用，不把本地名称写入 canonical 状态。

涉及位置：`src/commands.ts`、`src/utils/messages.ts`、`src/services/skillSearch/remoteSkillLoader.ts`、`src/services/skillSearch/remoteSkillState.ts`、`src/services/skillSearch/telemetry.ts`

### 7. 补充离线回归和 33 工具画像

skillSearch.test.ts 用注入索引和构造消息验证排名、exclude/limit、可见集合、遥测、turn-zero、write-pivot/subagent 与 kill switch；enabledFeatures.test.ts 更新 33 和 DiscoverSkills。另行识别 fallback、真实索引/cache reload 和 DiscoverSkills.call 的直接覆盖缺口，不用测试文件存在替代执行结果。

涉及位置：`tests/skillSearch.test.ts`、`tests/enabledFeatures.test.ts`

### 8. 记录本地验证和远程未实现状态

STATUS/RELEASE 更新 83/352、33 工具及 typecheck/build/declarations/CLI smoke 记录，将本地能力限定为 offline index/build。远程 canonical 明列 Not implemented，不引用或推断后续真实模型、远程协议结果，并保留缓存测试覆盖与文档枚举不完全一致的说明。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 索引依赖显式失效，直接磁盘修改可能陈旧；catch 虽删除失败 Promise，却不比较 Map 中的当前句柄，clear 后新旧加载重叠时可能误删新缓存项。
- 动态 import 用于打断初始化环，模块加载顺序仍需关注；全局 getCwd 也可能与调用方预期项目根不同。
- fallback 是启发式关键词聚合，对未分词语言、长连续文本和低质量非零完整查询结果能力有限。
- 不可信元数据进入模型 reminder 是提示注入面，搜索只读不代表后续 Skill 正文可无条件信任。
- 自动路径吞错为空结果提高韧性但降低可诊断性，直接工具调用的错误行为又不完全相同。
- 远程错误文案与 local-only DiscoverSkills 存在措辞错位，可能引导模型尝试并不存在的 canonical 发现。

## 验证顺序

1. 定向验证 Fuse 权重、exclude/limit、空查询，并补充完整查询零结果后分词才命中的 fallback 用例。
2. 用真实临时 command 目录检查索引来源、bundled/MCP 排除、cwd 并发 Promise、失败重试和命令 reload 后重建。
3. 构造 discovery/Skill 消息验证精确名称排除和 was_discovered 集合，检查大小写与其他 listing 形式边界。
4. 分别观察 turn-zero 阻塞附件、后续 prefetch 时序、最近 discovery 后 write-pivot 和首次 subagent_spawn。
5. 直接调用 DiscoverSkillsTool.call 验证 schema、无结果/有结果文本、limit 和 kill switch，再构建画像核对 33 个非空工具。
6. 确认远程 _canonical_ 仍返回未发现或 unavailable，且没有远程成功遥测；远程协议不能用本地测试替代。
7. 依据 at-commit STATUS/RELEASE 引用 83/352、typecheck/build/declarations/CLI smoke，不把当前记录校验当成历史测试重跑。
8. 真实模型驱动的技能选择、Skill 加载和端到端 query 只在授权环境另行执行并留存来源。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- cwd Promise 元数据索引、失败驱逐和显式缓存清理已实现，并复用既有命令失效入口。
- 加权 Fuse、零结果关键词 fallback、结构化可见性过滤和 discovered-name 记录已完成。
- turn-zero、write-pivot、subagent_spawn 三类信号与统一 native 附件已接入既有管线。
- DiscoverSkills 工具、运行时 kill switch、编译 feature 和 33 工具画像已经注册。
- 六个离线技能测试及 at-commit 83/352、类型检查、构建和 CLI smoke 记录已有来源。
- 远程 canonical loader/state/telemetry 保持明确不可用，没有用本地结果伪造远程能力。

### 未完成或后续工作

- 真实磁盘索引、缓存重建、fallback 专项和 DiscoverSkills.call 的直接测试覆盖不足。
- 真实模型技能发现/选择/加载、完整 query/attachment/subagent 端到端会话未在该提交验证。
- watcher/TTL、按 context 指定 cwd、更多写入信号和更广可见性识别未实现。
- 远程 canonical 加载与遥测仍未实现，相关旧错误文案与本地工具能力存在错位。
- STATUS 的 feature 枚举未同步 EXPERIMENTAL_SKILL_SEARCH，缓存验证表述也需要更精确的测试证据。
