---
commit: ab30aec7490292b93198d53c8436081dd8b06cdf
title: "Integrate SkillHub remote skills"
date: 2026-11-10T23:05:51+08:00
status: implemented
kind: component
---

# Integrate SkillHub remote skills

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交 0b6806800508a15c7a5f8293c572b8fa5c960d24 的 remoteSkillLoader 固定抛出 unavailable，remoteSkillState.getDiscoveredRemoteSkill 永远返回 undefined，telemetry 为防伪造成功而只是 no-op；prefetch 与 DiscoverSkillsTool 只查询本地技能。SkillTool 已有 _canonical_ 校验、权限、加载和成功/失败遥测调用点，但缺少可返回真实 metadata 与 SKILL.md 的后端。STATUS 因而把 remote canonical skills 标为未实现，而不是已有另一种私有 AKI/GCS 传输可直接使用。

需要以 SkillHub 公共 REST 契约替代缺失的私有后端，把搜索结果变成当前进程可调用且已登记的 canonical 技能，再经 latest resolve 取得版本、下载固定版本包并复用磁盘缓存。远程 zip 是不可信输入，落盘前必须限制规模、拒绝路径穿越和 symlink，并保留原子 staging 清理。发现层还不能因 registry 故障丢掉本地结果，遥测必须来自真实成功或失败。目标提交只具备本地 HTTP registry 证据，不能把后续公共 live 响应兼容和运行结果倒填到这里。

## 目标与非目标

### 目标

- 实现环境变量选择的 SkillHubClient，覆盖 search、latest/version resolve、版本化/无版本 download、10 秒超时、AbortSignal 和可选 Bearer token。
- 把 namespace/slug 搜索结果登记为 _canonical_ 名称及进程全局 Map metadata；该状态不按会话隔离，复用既有 SkillTool 的发现后校验和加载路径。
- 每次加载先 resolve，以 baseUrl/namespace/slug@version 的 SHA-256 建缓存，命中要求 SKILL.md 与 metadata 同时可读，版本变化重新下载。
- 仅对 zip 下载响应在完整 arrayBuffer 后限制 10 MiB，并限制解压非目录文件 100 个及合计 5 MiB；search/resolve JSON 没有响应大小上限。要求根 SKILL.md，拒绝前导斜线、反斜杠、点/上级分量与 zip symlink。
- 以 0700 目录、0600 文件和唯一 staging/rename 落盘，按 slug@url 合并 in-flight 请求；下载或校验失败不会立即清理不完整的旧 destination，异常清理的是 staging。
- 并行本地/远程发现、过滤已可见 canonical 技能，远程失败保留本地结果，并以真实 load 结果或 error 发送遥测。
- 用真实本地 HTTP registry 固定协议与恶意包回归，将公共/自托管 live 和后续兼容性证据单列。

### 非目标

- 不恢复私有 AKI/GCS 协议，也不虚构无配置时的远程结果；目标版本没有默认公共 registry URL。
- 不把 default namespace 与字符串 version 的本地 fixture 当作公共 SkillHub 响应已经完全兼容；字符串 latestVersion 虽有客户端分支，但新增 fixture 未覆盖。
- 不把缓存设计成离线存储：即使最终命中，当前实现仍先执行网络 resolve。
- 不执行 zip 中的代码或展开本地 slash-command 替换；既有 SkillTool 只把远程 SKILL.md 作为声明式指令注入。
- 不在目标提交宣称公共或自托管 registry live 已通过，也不把四个新增测试写成遥测、超时和所有大小上限均已覆盖。
- 不改变 SkillTool 既有的 EXPERIMENTAL_SKILL_SEARCH 与 USER_TYPE=ant canonical 执行门槛。

## 方案架构与数据流

skillhubClient.ts 的 getSkillHubRegistryUrl 只读取 CLAUDE_SKILL_REGISTRY_URL 并去尾部斜线，空配置使 searchRemoteSkills 返回空数组。request 用 createCombinedAbortSignal 合并调用者取消与 10 秒 timeout，按 JSON/zip 设置 Accept，可选加入 Bearer token，非 2xx 直接报错；JSON 支持 code/data 包装及非零 code 的 msg。zip 先 arrayBuffer 再检查 10 MiB。search 请求 /api/v1/skills?keyword&page=1&size，默认五条并钳制 1 至 20，可附 namespace，兼容数组及 items/skills/results；目标版本缺省 namespace=default，读取 name/description，以及 version 或字符串 latestVersion；新增 fixture 只覆盖 version 分支。

resolve 对 /api/v1/skills/{namespace}/{slug}/resolve 使用 version 或 tag=latest，download 在有版本时走 /versions/{version}/download，否则走 /download，路径段均 encodeURIComponent。remoteSearch 将结果规范为 namespace/slug，登记 name、description、shortId 和 /api/v1/skills/... URL。remoteSkillState 以进程内 Map 提供 register/get/list/clear，canonical 对外名为 _canonical_<namespace>/<slug>。既有 SkillTool 在 ant+feature 分支要求先发现，再读取同一 Map 并调用 loader，未登记名称不能直接加载任意 URL。

remoteSkillLoader 从 canonical URL 提取 origin、可选路径前缀及 API marker，并优先用 slug 的 namespace 部分定位。每次 load 先 resolve，从 version 或 latestVersion 取版本，以 baseUrl/namespace/slug@version 的 SHA-256 为目录名；无版本则退化为 @latest 和无版本下载。默认 cacheRoot 为配置目录 skill-cache，命中需同时读 SKILL.md 与解析 .skillhub.json，返回 skillhub-cache，否则重新下载并返回 skillhub。inFlight 以 slug@url 合并并发 Promise，finally 删除句柄；其键不包含 cacheDir/client/signal。

下载后先扫描 central directory 的 Unix external attributes，拒绝 0120000 symlink，再 unzipSync。非目录条目必须 1 至 100 个，根目录必须含 SKILL.md；assertSafePath 拒绝空路径、前导斜线、反斜杠以及 . 或 .. 分量，累计内容超过 5 MiB 即失败。所有校验后才创建 key.pid.uuid.tmp staging，递归写 0700 目录和 0600 文件，写入 fileCount/totalBytes metadata，删除旧 destination 并 rename；异常清理 staging。文件数与解压字节限制在完整 unzipSync 后执行，10 MiB 也在完整缓冲后检查，因此不是读取前或解压前的内存硬上限。

prefetch.discover 与 DiscoverSkillsTool.call 并行本地和远程搜索，分别以 catch/包装结果隔离远程异常；本地 matches 与远程 _canonical_ 合并，并用 getVisibleSkillNames 过滤已可见或已调用项。prefetch 把远程名加入 discoveredSkillNames，source 按结果使用 native、aki 或 both，其中 aki 是沿用的附件来源标签。DiscoverSkills 输出增加 remoteError，有结果时映射文本追加 Remote registry error；零结果分支只返回 No new local skills matched，会隐藏该错误。远程故障不会覆盖本地 Promise 的成功值，但本地搜索自身抛错并不享有对称降级。

telemetry.logRemoteSkillLoaded 从 no-op 改为 tengu_remote_skill_loaded，发送 slug、cache_hit、latency_ms、数值 url_scheme，以及可选 file_count、total_bytes、fetch_method、error。父提交 executeRemoteSkill 已只在 load 成功后上报 cache/file/fetch 数据，异常分支上报 error 且沿用 latencyMs=0，再抛出失败；本提交提供真实后端与事件函数，不在搜索失败时制造 loaded 成功。技能内容随后仍由既有 SkillTool 注入并记录使用，但 loader 返回的 skillPath 实为 destination 目录而非 SKILL.md 文件；executeRemoteSkill 对其取 dirname 会把 Base directory 指到 cacheRoot，并把目录路径登记为 invoked-skill 文件路径。传输与遥测职责保持分离，这一执行集成缺口不由本地 loader 测试覆盖。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/services/skillSearch/skillhubClient.ts`，符号 `getSkillHubRegistryUrl` | 新增环境端点、超时/取消、认证、响应解包和三类公共 REST 请求。 |
| 变更 | `src/services/skillSearch/remoteSearch.ts`，符号 `searchRemoteSkills` | 把远程结果规范为 namespace/slug、登记 canonical metadata 并返回发现项。 |
| 变更 | `src/services/skillSearch/remoteSkillState.ts`，符号 `registerDiscoveredRemoteSkill` | 以进程内 Map 实现 canonical 注册、查询、列举和清空。 |
| 变更 | `src/services/skillSearch/remoteSkillLoader.ts`，符号 `assertSafePath` | 实现版本 resolve/cache、zip 防御、staging 落盘、metadata 和 in-flight 去重。 |
| 变更 | `src/services/skillSearch/prefetch.ts`，符号 `searchRemoteSkills` | 并行混合本地/远程发现，过滤可见项并在远程故障时保留本地结果。 |
| 变更 | `src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts`，符号 `remoteError` | 合并 canonical 结果、输出远程错误并保持本地技能返回。 |
| 变更 | `src/services/skillSearch/telemetry.ts`，符号 `logRemoteSkillLoaded` | 将 no-op 替换为带真实缓存、文件、fetch 或 error 字段的事件。 |
| 变更 | `tests/remoteSkills.test.ts`，符号 `describe('SkillHub discovery and loading'` | 新增四个真实本地 HTTP registry 和恶意 zip 回归。 |
| 变更 | `docs/STATUS.md`，符号 `Remote canonical skills via SkillHub` | 记录 local registry 验证、134/580 和真实 registry 尚待运行的边界。 |
| 变更 | `docs/RELEASE.md`，符号 `## SkillHub remote skills` | 记录 REST、canonical、版本缓存、安全 zip、本地结果和真实遥测的发布范围。 |
| 复用 | `src/services/skillSearch/localSearch.ts`，符号 `getVisibleSkillNames` | 复用本地搜索与可见技能集合，维持既有排名和去重行为。 |
| 复用 | `src/tools/SkillTool/SkillTool.ts`，符号 `executeRemoteSkill` | 复用 canonical 发现后校验、ant/feature 门槛、加载、成功/失败遥测和声明式内容注入。 |
| 复用 | `src/utils/combinedAbortSignal.ts`，符号 `createCombinedAbortSignal` | 复用外部 AbortSignal 与 10 秒请求 timeout 的组合及清理。 |
| 复用 | `src/utils/envUtils.ts`，符号 `getClaudeConfigHomeDir` | 复用配置根目录定位默认 skill-cache。 |
| 复用 | `src/services/analytics/index.ts`，符号 `logEvent` | 复用既有分析事件通道，不为 SkillHub 建立平行遥测后端。 |

## 关键决策与工程取舍

- registry 由环境变量显式选择，不为目标版本硬编码公共地址；这让本地协议测试和部署端点共用客户端，同时未配置时保持无远程结果。
- 搜索与加载通过 canonical Map 关联，SkillTool 只执行已发现 slug；相比接受任意 URL，这固定了发现先于加载的调用顺序，但状态是进程全局而非持久会话存储。
- 缓存键包含解析版本而非只看 slug，latest 变化会进入新目录；每次仍先 resolve 是为了获知当前版本，因此不提供免费离线命中。
- zip 全部通过校验后才进入 staging，失败不保留半包；版本目录替换前会删除旧目录，所以切换过程不是无窗口的原子交换。
- 远程发现错误与本地结果解耦，DiscoverSkills 另外暴露 remoteError；保留本地可用性比让可选 registry 阻断核心技能搜索更重要。
- 遥测复用 SkillTool 已有成功/异常调用点，事件字段直接来自 loader 返回值或 error；失败耗时仍固定零，不能解释成真实测时。

### 备选方案与回溯分析

- 回溯性比较：可以继续等待私有 AKI/GCS 协议并保留 unavailable，但这无法形成可测试后端；实际选择公开 REST，以环境端点和可选 token 保持部署适配。
- 回溯性比较：可以按 slug 永久缓存以减少请求，但 latest 更新会不可见；实际每次 resolve 并按版本分目录，代价是缓存依赖网络且旧版本目录会积累。
- 回溯性比较：可以把 zip 直接解到最终目录，代码更少，却会暴露部分写入和恶意路径；实际先校验再 staging/rename，并保留权限与清理约束。
- 回溯性比较：可以让任一远程错误使整个 discover 失败，行为更简单，却损害本地搜索；实际远程单独降级，但没有进一步处理本地失败的对称韧性。

## 安全与协议边界

- 路径检查在写文件前拒绝空路径、前导 /、反斜杠及 . 或 .. 分量，central directory symlink 检查拒绝 Unix symlink；这不是通用绝对路径检查，C:/ 等 Windows 驱动器形式未被显式拒绝。根 SKILL.md 与文件数/总字节约束限制包结构。
- staging 和最终目录使用 0700、技能及 metadata 使用 0600，随机 staging 名降低碰撞；写失败会删除临时树，不将不完整目录当作有效缓存。
- Bearer token 只进入请求 Authorization，不由客户端打印；公共包没有签名或内容哈希验证，SHA-256 仅用于缓存键，registry/TLS 与 token 仍是信任边界。
- zip 的 10 MiB 在 arrayBuffer 后判断，100 文件/5 MiB 在 unzipSync 后判断，无法阻止超大响应或高压缩比包先消耗内存；search/resolve JSON 没有大小上限，需要流式、JSON 与解压过程限额才能补齐。
- registry 返回的 name/description 在包下载和校验前即进入发现结果；SKILL.md frontmatter 不与搜索 metadata 或 canonical slug 交叉校验，既有 SkillTool 剥除 frontmatter 后注入 body。ant+feature 分支在 deny 规则之后自动允许 canonical 调用且不展开本地命令，不代表远程 metadata 或正文可信。
- canonical Map 可被同 slug 的新搜索覆盖且没有按会话隔离，inFlight 也会共享首个调用的选项；多租户或不同 cache/client 并发不能依赖这些全局结构隔离。

## 验收标准

- 未配置 registry 或 query 空白时远程搜索返回空；配置后搜索、resolve、download 使用约定 REST 路径、编码路径段、超时、取消和可选 token。
- 搜索结果被规范为 namespace/slug 并登记真实 URL，canonical 名称可经既有 SkillTool 查询；未先登记的 slug 不应进入远程加载。
- resolve 返回版本时下载固定版本 URL，同版本完整缓存命中，版本改变产生新 SHA 目录与新内容；缺版本时明确退化为 latest 而非声称不可变。
- 空包、超过 100 文件、缺根 SKILL.md、总内容超过 5 MiB、危险路径和 symlink 都在最终缓存写入前拒绝，合法包保留相对目录与权限。
- 远程搜索失败时本地结果仍返回，重复可见 canonical 被过滤；DiscoverSkills 在有结果时同时报告 remoteError，零结果错误展示缺陷需单独保留。
- 成功遥测包含真实 cache/file/byte/fetch 数据，失败遥测包含 error 并继续抛出；搜索失败不得发送伪造 loaded 成功。
- 本地 HTTP 回归覆盖搜索登记/prefetch、版本缓存与更新、路径穿越及 symlink；公共 live、私有自托管和后续响应兼容不得写作目标时验收。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | SkillHubClient 实现环境端点、10 秒组合取消、可选 Bearer、code/data 解包、search/resolve/download 及 zip 下载的 10 MiB 检查；search/resolve JSON 没有响应大小上限，目标代码没有默认公共 URL。 | `src/services/skillSearch/skillhubClient.ts`，符号 `export class SkillHubClient`，revision `commit` |
| diff-observed | loadRemoteSkill 每次 resolve，按版本哈希缓存，并包含 central-directory symlink、路径、文件数/大小、SKILL.md、staging 权限和 in-flight 逻辑。 | `src/services/skillSearch/remoteSkillLoader.ts`，符号 `export async function loadRemoteSkill`，revision `commit` |
| diff-observed | prefetch 并行本地/远程搜索并单独捕获远程异常，合并 canonical 结果、过滤可见技能和使用 native/aki/both 来源。 | `src/services/skillSearch/prefetch.ts`，符号 `async function discover`，revision `commit` |
| diff-observed | logRemoteSkillLoaded 已接入真实 logEvent，字段来自加载结果或 error；既有 SkillTool 成功/失败分支提供调用上下文。 | `src/services/skillSearch/telemetry.ts`，符号 `export function logRemoteSkillLoaded`，revision `commit` |
| test-added | 新增四个测试、17 个断言，以 127.0.0.1 临时 HTTP server 和真实 zip 覆盖搜索登记/prefetch、版本缓存与 1.0.0→1.0.1 更新、../ 路径及 symlink；此项只声明测试加入。 | `tests/remoteSkills.test.ts`，符号 `describe('SkillHub discovery and loading'`，revision `commit` |
| recorded-command-pass | 提交内 STATUS 记录 bun test 通过 134 个测试、580 个断言，远程能力状态为 Verified (local registry)；这是 at-commit 历史记录而非本次文档复跑。 | `docs/STATUS.md`，符号 ``bun test``，revision `commit` |
| recorded-command-pass | 提交内 RELEASE 记录 typecheck、build、declarations 和 38-tool feature profile 通过，并明确测试使用 real local HTTP registry、self-hosted live 另行处理。 | `docs/RELEASE.md`，符号 `## SkillHub remote skills`，revision `commit` |
| not-recorded | 目标提交没有公共或自托管 registry live 运行记录，也没有目标专属 CI run ID；STATUS 明确写 real registry round trip still pending，不能从本地 server 推断公共兼容。 | 未随提交记录执行证据 |
| later-evidence | 后续 9cd4c63193ded6eb916bf734f65a427da193faf0 的 STATUS 才记录 Verified (live public registry) 与 SKILLHUB_LIVE_OK；这是 descendant later evidence，不是 ab30aec 当时已有的公共运行结果。 | `docs/STATUS.md`，符号 `SKILLHUB_LIVE_OK`，revision `9cd4c63193ded6eb916bf734f65a427da193faf0` |
| later-evidence | 同一后续 revision 把缺省 namespace 从 default 改为 global，并增加 displayName/summary 与对象 latestVersion.version 兼容，说明目标本地 fixture 并未证明公共响应形状。 | `src/services/skillSearch/skillhubClient.ts`，符号 `displayName`，revision `9cd4c63193ded6eb916bf734f65a427da193faf0` |

## 实现状态与剩余范围

- 状态：**implemented**
- 公共 live 是后续 9cd4c63 在 global namespace 和新响应字段兼容后记录的结果；私有/自托管 registry 仍是独立环境验证，不由公共成功覆盖。
- 下载与解压上限均在完整缓冲/解压后执行，高压缩比或超大响应仍可能先造成内存压力；缓存也没有签名或内容完整性验证。
- resolve 无版本会退化为 latest，缓存命中前必须联网；inFlight 忽略 cacheDir/client/signal，canonical Map 也不按会话隔离。
- DiscoverSkills 零结果时渲染文本遗漏 remoteError，本地搜索失败也不会保留远程结果；失败遥测的 latencyMs 固定为零。
- loader 返回目录 skillPath，而 executeRemoteSkill 以 dirname(skillPath) 计算 Base directory 并登记 invoked-skill 文件路径，导致目录层级和状态路径错误。新增四测试未覆盖此集成问题，也未覆盖 DiscoverSkills 错误合成、遥测字段、SkillTool 端到端、10 MiB/5 MiB/100 文件、timeout/abort；实际 canonical 执行仍限 ant+feature。
