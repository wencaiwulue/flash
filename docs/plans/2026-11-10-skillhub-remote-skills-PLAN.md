---
commit: ab30aec7490292b93198d53c8436081dd8b06cdf
title: "Integrate SkillHub remote skills"
date: 2026-11-10T23:05:51+08:00
status: implemented
kind: component
---

# 实施计划：Integrate SkillHub remote skills

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要以 SkillHub 公共 REST 契约替代缺失的私有后端，把搜索结果变成当前进程可调用且已登记的 canonical 技能，再经 latest resolve 取得版本、下载固定版本包并复用磁盘缓存。远程 zip 是不可信输入，落盘前必须限制规模、拒绝路径穿越和 symlink，并保留原子 staging 清理。发现层还不能因 registry 故障丢掉本地结果，遥测必须来自真实成功或失败。目标提交只具备本地 HTTP registry 证据，不能把后续公共 live 响应兼容和运行结果倒填到这里。

- 以父提交 loader/state/telemetry 的 unavailable、undefined、no-op 为基线，保留其类型和 SkillTool 调用契约。
- 确认公共 REST 路径、code/data 包装和本地测试 server 可控，目标版本不预设默认公共 URL。
- 先定义恶意 zip、缓存版本和远程失败边界，把本地 HTTP 与后续公共/自托管 live 分开。

## 复用与兼容处理

### 复用现有实现

- 复用 createCombinedAbortSignal、fetch、URLSearchParams 和可选 Bearer 配置实现请求层。
- 复用 stripCanonicalPrefix、DiscoveredRemoteSkill、RemoteSkillLoadResult 与 SkillTool.executeRemoteSkill。
- 复用 searchLocalSkills/getVisibleSkillNames、skill_discovery attachment 和 native/aki/both 来源类型。
- 复用 getClaudeConfigHomeDir、fflate.unzipSync、logEvent 与既有成功/失败遥测调用点。

### 兼容、迁移与生命周期

- 保留 RemoteSkillLoadResult、DiscoveredRemoteSkill 和 _canonical_ 命名，既有 SkillTool 不需要修改即可替换不可用后端。
- CLAUDE_SKILL_REGISTRY_URL 与 TOKEN 决定部署端点和认证，未配置不会意外访问硬编码公共服务。
- 实际 Skill 调用仍受 EXPERIMENTAL_SKILL_SEARCH 与 USER_TYPE=ant 限制；发现可见不等于所有构建都可执行 canonical 技能。
- attachment.source 继续使用 aki 表示远程来源，这是既有消费者兼容标签，不代表仍使用私有 AKI 传输。
- 缓存目录包含版本哈希、SKILL.md 和 .skillhub.json；缺版本或 metadata 损坏会重新下载，不保证离线可用。

## 文件级实施步骤

### 1. 建立 SkillHub REST 传输契约

新增 skillhubClient.ts，先实现环境 URL 和统一 request 的 timeout、signal、token、Accept、HTTP/code 错误及 zip 下载响应大小检查（search/resolve JSON 无上限），再实现 search 的结果容器/字段规范化、resolve 的 latest/version 参数和 download 的版本化路径。

涉及位置：`src/services/skillSearch/skillhubClient.ts`

### 2. 连接远程搜索与 canonical 状态

在 remoteSkillState.ts 增加进程内注册表及 register/get/list/clear，再由 remoteSearch.ts 将 namespace/slug、名称、描述、shortId 和真实技能 URL 写入。未配置或空 query 保持空结果，使 SkillTool 能继续执行发现后校验。

涉及位置：`src/services/skillSearch/remoteSkillState.ts`、`src/services/skillSearch/remoteSearch.ts`

### 3. 实现版本缓存与安全 zip 落盘

在 remoteSkillLoader.ts 解析 canonical 位置和 resolve 版本，建立 SHA 版本目录及双文件缓存命中。随后加入下载、symlink/path/文件数/大小/SKILL.md 校验、staging 权限与 rename 清理，最后以 slug@url 合并 in-flight；保留无版本 latest 和后验资源限额的明确边界。

涉及位置：`src/services/skillSearch/remoteSkillLoader.ts`

### 4. 接通混合发现与真实遥测

修改 prefetch 和 DiscoverSkillsTool 并行本地/远程查询、注册 canonical 名、过滤可见项并隔离远程错误，输出 remoteError。把 telemetry no-op 改为真实事件，使既有 SkillTool 成功/失败分支获得实际字段；不把搜索失败转换为 loaded 成功。

涉及位置：`src/services/skillSearch/prefetch.ts`、`src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts`、`src/services/skillSearch/telemetry.ts`

### 5. 用本地 HTTP registry 建立回归

remoteSkills.test.ts 启动随机端口 server，提供真实 JSON 与 zip 响应，覆盖搜索/登记/prefetch、两文件落盘、第二次缓存、版本更新重新下载、../ 逃逸和 central-directory symlink。每个用例清理服务器、状态、环境变量和临时缓存，不用它冒充公共 registry。

涉及位置：`tests/remoteSkills.test.ts`

### 6. 回写本地验证和后续证据边界

STATUS/RELEASE 记录 134/580、类型检查、构建、38 工具及 local registry 范围，明确真实 registry 尚待运行。公共 SKILLHUB_LIVE_OK 和 global/displayName/summary/object latestVersion 兼容只在后代出现后作为 full-SHA later evidence 引用。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 完整 arrayBuffer/unzipSync 后才检查限制，恶意包可在拒绝前消耗大量内存；staging 不能解决这一资源风险。
- 公共响应形状在后代才修正，目标 default namespace 与字符串 latestVersion 对外兼容性有限。
- 缓存仍依赖在线 resolve，无版本退化为 latest，旧版本目录累积，且没有包签名或哈希内容验证。
- 全局 canonical Map 与不含选项的 inFlight 键可能串用状态、client、cacheDir 或 signal，多会话隔离不足。
- 零结果时 remoteError 不出现在文本、局部失败韧性不对称、失败 latency 固定零，都会降低诊断准确性。
- 本地四测试没有覆盖真实 SkillTool 注入、遥测、权限、公共网络、timeout/abort 和各项资源上限。

## 验收顺序

1. 用本地 server 核对三条 REST 路径、query/limit/namespace、code/data 与数组/items/skills/results 响应，另测空配置和 Bearer/abort/timeout。
2. 加载同一版本两次并检查 cacheHit 与 metadata，再改变 resolve 版本确认新目录、新下载和新 SKILL.md；另测无版本 latest 分支。
3. 分别构造空包、101 文件、缺 SKILL.md、超过 5 MiB、绝对/反斜杠/点/上级路径、symlink 和超过 10 MiB 响应，并观察内存限额发生的阶段。
4. 模拟远程失败而本地成功、远程成功而本地失败、零结果和已可见 canonical，核对附件、remoteError 文本与状态登记。
5. 直接观察成功/失败 logEvent 字段及 SkillTool 内容注入，确认失败继续抛出且成功事件不由搜索单独触发。
6. 引用 at-commit 134/580 和构建记录时注明历史来源；公共 live 只引用 9cd4c63 后代，私有/自托管另行验证。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 环境选择的公共 REST search/resolve/download、canonical 注册和本地/远程混合发现已经实现。
- 版本化磁盘缓存、固定版本下载、zip 路径/symlink 防护、staging 权限和 in-flight 请求去重已经落入代码。
- 远程错误降级和真实成功/失败遥测已经实现，未用空实现伪造结果；SkillTool 的 skillPath 目录契约错配仍属未完成集成。
- 四个本地 HTTP/ZIP 测试及 at-commit 134/580、typecheck/build/38 工具记录已形成；公共 live 被正确保留为后代证据。

### 未完成或后续工作

- 目标时没有公共或自托管 live 证据，公共 global/新响应字段兼容由后续 9cd4c63 才补齐。
- 流式下载/解压前资源硬上限、包完整性/签名、离线缓存和多会话状态隔离尚未实现。
- DiscoverSkills 零结果错误展示、对称失败韧性、真实遥测与资源边界测试仍不足；SkillTool 的 Base directory/invoked-skill 路径需改为使用 destination 或真正的 SKILL.md 路径，并补端到端回归。
