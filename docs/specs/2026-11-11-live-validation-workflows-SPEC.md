---
commit: 9cd4c63193ded6eb916bf734f65a427da193faf0
title: "Add live validation workflows and registry compatibility"
date: 2026-11-11T09:15:44+08:00
status: partial
kind: component
---

# Add live validation workflows and registry compatibility

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交没有 live-validation workflow，也没有四个专用验证脚本。SkillHub 搜索在 namespace 缺失时回填 default，只接受字符串 latestVersion，并仅从 name、description 读取显示信息；STATUS 仍把真实 registry、Cloud 和原生桌面往返列为待验证边界。

需要把已有模型、SkillHub、Cloud 与桌面能力分别接入可手动或定时运行的 CI 探针，同时让公共 SkillHub 的实际响应字段映射到现有搜索结果。每类检查需要隔离配置并给出可识别 sentinel，但本地脚本记录、hosted workflow 结果以及需要 OAuth 或交互桌面的验证必须分别陈述。model/cloud 还在 jobs.<job_id>.if 使用不受支持的 secrets context，因此新增 workflow 不能记为完整可靠的 CI 门控。

## 目标与非目标

### 目标

- 新增 workflow_dispatch 与每日 schedule 的只读 workflow，编排 model、skillhub、cloud、desktop 四个独立 job。
- 以 job 条件控制模型凭据、Cloud 三项配置和桌面开关，并为 model、cloud、desktop 绑定 live-validation Environment。
- 为各 job 设置独立 HOME 与 CLAUDE_CONFIG_DIR，运行对应 Bun 脚本并输出固定成功标记。
- 覆盖模型 workflow、proactive/Sleep、context collapse、reactive compaction，以及 SkillHub 搜索、下载和版本缓存命中。
- 保留 Cloud bridge 持久会话恢复、文件持久化、归档与清理链，以及桌面 screenshot 和客户端关闭。
- 兼容 global namespace、对象或字符串 latestVersion、displayName/name 与 summary/description 回退，并记录真实证据边界。

### 非目标

- 不把 RELEASE 中的本地模型和公共 SkillHub sentinel 写成 GitHub Actions workflow。
- 不宣称 Cloud OAuth、Cloud Files、bridge resume 或桌面 screenshot 已在此提交执行成功。
- 不把公共 registry 成功扩展为私有或 self-hosted SkillHub 已验证。
- 不引入后续提交才有的 model/cloud 脚本缺省跳过逻辑，也不改变现有 agent、bridge 或桌面协议。

## 方案架构与数据流

CI 层新增单一 live-validation.yml：model/cloud 的 job if 直接使用 secrets，desktop 使用 vars，skillhub 只检查事件。jobs.<job_id>.if 不支持 secrets context，故 model/cloud 不能表述为缺凭据时可靠跳过；desktop 的 vars 与 skillhub 的 github 条件才是受支持的输入。skillhub 不绑定 named Environment，也不要求 token；其余三个 job 在该 revision 显式使用 live-validation Environment。

每个 job 都 checkout、安装 Bun 1.3.14、冻结锁文件安装依赖，再用独立 HOME 和 CLAUDE_CONFIG_DIR 启动脚本。这里的隔离是不同 job 使用不同路径；cloud 与 SkillHub 另以 mkdtemp 管理工作目录或缓存，不能据此推断 self-hosted runner 上的固定配置目录每次都会全新创建。

model 脚本先启用配置并解析主模型，再串行执行四个探针：真实 workflow 完成、proactive 激活后的 Sleep、100 token 窗口下的一次 context collapse、以及 reactive compaction。任一状态或结果断言失败都会抛错，四项分别输出 WORKFLOW_LIVE_OK、PROACTIVE_LIVE_OK、CONTEXT_COLLAPSE_LIVE_OK、REACTIVE_COMPACTION_LIVE_OK，外层 finally 统一清理。

SkillHub 适配层保持现有请求、解包和列表提取，只扩展记录字段归一化：缺省 namespace 改为 global；版本依次取 version、latestVersion.version、字符串 latestVersion；名称依次取 displayName、name、slug；摘要依次取 summary、description、空串。live 脚本用默认公共地址或显式地址搜索 code，构造 namespace/slug 下载，再读同一缓存目录验证第二次 cacheHit。

Cloud 脚本独立于模型与桌面：从既有 OAuth 配置取 access token，组织 UUID 可由环境或接口获得，base URL 可直接回退既有 OAuth 配置。它创建并写回首个 perpetual bridge session， teardown 后恢复并比较 session ID，再设置 Cloud Files 所需环境、写入嵌套文件、执行 persistence 和 archive，最后清理注册资源与临时目录。不过 workflow 的三项 secret gate 比脚本回退更严格。

desktop 脚本保留独立开关：直接调用时变量非 1 只输出 DESKTOP_LIVE_SKIPPED；workflow 一旦执行变量 gate，又在步骤中显式传 1，因此会取得 computer-use client、调用 screenshot、检查 isError 并关闭客户端。该路径需要 self-hosted 与交互桌面，和 hosted model/SkillHub 证据不可混算。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `.github/workflows/live-validation.yml`，符号 `name: live-validation` | 新增四 job 的手动/定时 live 编排、条件、Environment、runner 和隔离环境。 |
| 变更 | `scripts/live-model-validation.ts`，符号 `WORKFLOW_LIVE_OK` | 新增模型 workflow、proactive、context collapse 与 reactive compaction 四段探针。 |
| 变更 | `scripts/live-skillhub-validation.ts`，符号 `SKILLHUB_LIVE_OK` | 新增公共或显式 registry 的搜索、下载、内容检查及缓存命中验证。 |
| 变更 | `scripts/live-cloud-validation.ts`，符号 `CLOUD_LIVE_OK` | 新增 OAuth bridge 恢复、Cloud Files 持久化、归档与清理验证。 |
| 变更 | `scripts/live-desktop-validation.ts`，符号 `DESKTOP_LIVE_SKIPPED` | 新增独立桌面开关、screenshot 探针和客户端关闭。 |
| 变更 | `src/services/skillSearch/skillhubClient.ts`，符号 `const latest = value.latestVersion` | 扩展 global namespace 和新旧响应字段的确定性归一化。 |
| 变更 | `docs/RELEASE.md`，符号 `## CI live validation` | 记录四 job 设计、隔离配置及模型/公共 SkillHub sentinel，不包含 Cloud/desktop 成功。 |
| 变更 | `docs/STATUS.md`，符号 `Verified (live public registry)` | 提升公共 SkillHub 证据状态，同时保留私有 registry、Cloud 和桌面边界。 |
| 复用 | `src/services/skillSearch/remoteSkillLoader.ts`，符号 `loadRemoteSkill`，revision `commit` | 复用既有远程技能下载和版本缓存，不在 live 脚本重写加载协议。 |
| 复用 | `src/bridge/remoteBridgeCore.ts`，符号 `initEnvLessBridgeCore`，revision `commit` | 复用既有 env-less perpetual bridge 实现完成 Cloud 探针。 |

## 关键决策与工程取舍

- 初始 revision 试图用 job 级条件阻止未配置探针，而不是在 model/cloud 脚本内输出跳过标记；但 secrets 不是 jobs.<job_id>.if 的受支持上下文，只有 desktop 的 vars gate 可按该语义分析，model/cloud 不能宣称会可靠 job-skip。
- 模型四个检查共用一个隔离脚本和最终清理，SkillHub、Cloud、desktop 则分别保有自身临时资源与成功条件，避免一个总脚本混淆外部依赖。
- SkillHub 新字段按明确优先级回退，保留显式旧字段和字符串 latestVersion 的兼容性；只有缺省 namespace 的返回值从 default 改为 global。
- STATUS 只把 SkillHub 提升为 live public registry，并继续列出 Cloud 与原生桌面的授权环境需求；RELEASE 的五项 sentinel 只归属于模型四项和 SkillHub 一项。

### 备选方案与回溯分析

- 回溯性比较：把所有探针放进一个 job 能减少重复安装步骤，却会共享配置、凭据和失败面；实际采用四 job 隔离，代价是 workflow 编排重复。
- 回溯性比较：只放宽 SkillHub 类型而不规定字段优先级会留下不确定映射；实际实现使用逐级回退，保留旧响应但优先使用公共 registry 的新字段。
- 回溯性比较：可以让 Cloud workflow 依赖脚本的 org/base URL 回退而减少 gate；本 revision 仍要求三项 secret 全非空，不能把直接调用能力当作 CI 条件。

## 安全与协议边界

- workflow 权限仅为 contents: read，凭据通过既有 secrets/vars 映射进入对应步骤；记录只写字段名和固定 sentinel，不包含任何凭据值。
- SkillHub token 仍由既有 client 转成 Authorization 头，live 脚本只输出成功标记；URL、namespace 和 slug 路径段按既有方式编码。
- model、Cloud、desktop 使用分离配置目录，SkillHub 缓存由 finally 删除；Cloud 只有进入 live try/finally 后才清理临时目录，缺 token 或组织解析失败发生在该块之前。self-hosted desktop 的固定目录仍需运行环境自行保证隔离。
- 移除或绕过外部授权不属于本提交；Cloud 与 desktop 没有执行证据时继续保持未验证状态。

## 验收标准

- workflow 含四个指定 job、两个触发器、只读权限及各自身份条件，model/cloud/desktop 的 Environment 与 runner 选择符合补丁。
- 模型脚本严格按四个探针顺序检查真实结果并输出四个 sentinel，任何失败不会被改写为成功。
- SkillHub 搜索无结果、下载内容异常或第二次未命中缓存都会失败，成功才输出 SKILLHUB_LIVE_OK。
- Cloud 恢复后的 session ID 必须一致，持久化必须返回至少一个文件，archive 后才输出 CLOUD_LIVE_OK。
- desktop 仅在开关为 1 时调用 screenshot，错误结果会抛错并关闭客户端；skip 与成功是不同标记。
- SkillHub 字段回退顺序和 global 缺省值与 at-commit 实现一致，显式旧字段仍可使用。
- 提交文档只记录模型与公共 SkillHub live sentinel；Cloud、desktop 和 hosted workflow 均无伪造成功结论。

## 实现状态与剩余范围

- 状态：**partial**
- model/cloud 的 secrets job-if 不受支持；设计应使用有效门控或脚本 guard 才能获得可预测的 CI 跳过行为。
- Cloud OAuth、perpetual bridge、Cloud Files 与原生桌面 screenshot 仍需各自授权环境的真实执行结果。
- 私有或 self-hosted SkillHub 仍是可选的独立验证，公共 registry 成功不覆盖其认证和部署差异。
- 初始 workflow 是否被平台注册以及四个 job 的实际执行或跳过情况，此提交没有平台侧记录。
