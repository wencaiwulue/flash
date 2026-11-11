---
commit: 6ef3352651472a951a3779f7b9f906fbc5ca86ca
title: "Allow live jobs without precreated environment"
date: 2026-11-11T09:18:52+08:00
status: partial
kind: component
---

# Allow live jobs without precreated environment

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交刚加入四个 live job，其中 model、cloud、desktop 都声明 environment: live-validation，skillhub 没有该字段。model/cloud 的 job if 仍直接使用该位置不支持的 secrets context；desktop 保留 vars 条件和 self-hosted runner。

提交主题要求允许 job 在没有预建 Environment 时运行，实际补丁只删除三个 Environment 绑定。这样可以改变平台对 named Environment 的依赖，但不会修改任何凭据或桌面开关条件，也不修复 model/cloud 在 job if 使用 secrets 的上下文错误；提交没有平台错误、运行结果或文档同步。

## 目标与非目标

### 目标

- 删除 model、cloud、desktop 的 environment: live-validation 三行。
- 保持四个 job、各自 if、runner、步骤、环境变量映射、触发器和 contents: read 权限不变。

### 非目标

- 不删除 model 的 secret gate、Cloud 的三项 secret gate 或 desktop 的仓库变量 gate。
- 不修改任何验证脚本，不宣称 Cloud/desktop 已执行，也不记录 workflow 注册或 CI 运行。
- 不处理后续提交才出现的 job 删除、无条件运行或 workflow 重命名。

## 方案架构与数据流

此 revision 仍是同一 live-validation.yml 和四个 job。变化仅在 job 到 GitHub Environment 的绑定：model 与 cloud 继续是 ubuntu-latest，desktop 继续是 self-hosted，三者不再引用 live-validation Environment；skillhub 原本就没有该绑定。

可用性判断仍只位于 job if，model/cloud 没有脚本 guard；但 secrets 在 jobs.<job_id>.if 不受支持，不能声称未配置时会可靠跳过。desktop 的 vars gate 保留，变量非 1 时不会进入脚本；本提交没有把这些判断迁移到脚本。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `.github/workflows/live-validation.yml`，符号 `jobs:` | 仅删除 model、cloud、desktop 的 live-validation Environment 绑定。 |
| 复用 | `docs/RELEASE.md`，符号 `protected environment is present`，revision `commit` | 未随补丁更新，保留了对 protected environment 的过时依赖描述。 |
| 复用 | `scripts/live-desktop-validation.ts`，符号 `process.env.CLAUDE_DESKTOP_LIVE !== '1'`，revision `commit` | 脚本开关未改；workflow 的仓库变量 job gate 也仍独立存在。 |

## 关键决策与工程取舍

- 采用最小三行删除来解除 named Environment 依赖，而不同时改写 secret 映射或 job 条件。
- 保留父提交文档不改，使 RELEASE 中 OAuth/desktop 仅在 protected environment 存在时运行的描述不再准确对应当前 workflow；因此本记录将提交标为 partial，而非隐去这一缺陷。

### 备选方案与回溯分析

- 保留 Environment 并另行预建它属于平台配置方案，不是本 diff；同时更新 RELEASE 或调整 gate 能保持一致性，但本提交也未采用。

## 安全与协议边界

- 删除 named Environment 绑定意味着这些 job 不再由该 Environment 提供保护边界，既有 secret 条件和变量条件仍保留。
- 补丁不包含凭据值，不改变 contents: read，也不把 desktop 移到 hosted runner。

## 验收标准

- diff 恰好删除三个 environment 字段，四个 job 及其余 YAML 保持原样。
- model、cloud、desktop 在该 revision 不再依赖 live-validation Environment；desktop 仍由 vars 条件控制，model/cloud 的 secrets job-if 则仍存在上下文限制。
- 没有将移除 Environment 描述为取消凭据 gate、脚本 skip 或 live 验证成功。

## 实现状态与剩余范围

- 状态：**partial**
- RELEASE 的 protected environment 描述尚未与三行删除同步。
- model/cloud 的 secrets job-if 仍不受支持；解除 Environment 绑定后的 workflow 注册、条件求值和各 job 实际运行也需要平台侧证据。
