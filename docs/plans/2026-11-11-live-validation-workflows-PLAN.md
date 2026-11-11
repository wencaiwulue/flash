---
commit: 9cd4c63193ded6eb916bf734f65a427da193faf0
title: "Add live validation workflows and registry compatibility"
date: 2026-11-11T09:15:44+08:00
status: partial
kind: component
---

# 实施计划：Add live validation workflows and registry compatibility

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把已有模型、SkillHub、Cloud 与桌面能力分别接入可手动或定时运行的 CI 探针，同时让公共 SkillHub 的实际响应字段映射到现有搜索结果。每类检查需要隔离配置并给出可识别 sentinel，但本地脚本记录、hosted workflow 结果以及需要 OAuth 或交互桌面的验证必须分别陈述。model/cloud 还在 jobs.<job_id>.if 使用不受支持的 secrets context，因此新增 workflow 不能记为完整可靠的 CI 门控。

- 以父提交缺少 workflow/四个脚本及旧 SkillHub 字段归一化为基线，先核对现有模型、bridge、remote loader 与 computer-use API。
- 准备独立的外部验证矩阵：本地模型与公共 SkillHub、OAuth Cloud、self-hosted 交互桌面、hosted Actions 分别留证。

## 复用与兼容处理

### 复用现有实现

- 复用 startWorkflowTask、proactive/Sleep、context collapse 和 reactive compaction 的生产入口，不建立模型测试旁路。
- 复用 SkillHubClient、loadRemoteSkill、initEnvLessBridgeCore、runFilePersistence 和 open computer-use client。
- 沿用 cleanupRegistry、OAuth 配置、任务上下文及现有 STATUS/RELEASE 证据格式。

### 兼容、迁移与生命周期

- SkillHub 显式 namespace、version、name、description 和字符串 latestVersion 仍可解析，仅缺省 namespace 和新字段优先级发生变化。
- Cloud 脚本直接调用可回退组织查询和默认 base URL；初始 workflow 的 if 文本虽列出三项 secret，但该位置不支持 secrets context，不能把文本门槛当作有效 CI 条件。
- desktop 直接调用可在变量非 1 时跳过；workflow 执行 gate 后显式传 1，因此该 job 内执行的是 live 分支。
- 既有功能入口不变，新增脚本和 workflow 是独立验证面；模型/SkillHub 的历史 sentinel 不构成 Cloud/desktop 回归证据。

## 文件级实施步骤

### 1. 归一化公共 SkillHub 响应

先调整 namespace 缺省值，再按既定优先级加入 latestVersion 对象、displayName 与 summary 回退，保持已有搜索请求和显式旧字段兼容。

涉及位置：`src/services/skillSearch/skillhubClient.ts`

### 2. 实现模型与 SkillHub 探针

依次串接四个模型检查及各自断言，再实现 SkillHub 搜索、远程内容读取和第二次缓存命中；两者只输出固定 sentinel，并保留模型清理与 SkillHub 临时缓存删除。

涉及位置：`scripts/live-model-validation.ts`、`scripts/live-skillhub-validation.ts`、`src/services/skillSearch/remoteSkillLoader.ts`

### 3. 实现 Cloud 与桌面独立探针

Cloud 依次创建、写入、恢复并核对 session，再持久化文件和归档；desktop 保留开关分支，启用时调用 screenshot 并关闭客户端。两条路径分别处理资源，不共享模型成功结论。

涉及位置：`scripts/live-cloud-validation.ts`、`scripts/live-desktop-validation.ts`、`src/bridge/remoteBridgeCore.ts`

### 4. 编排四个隔离 CI job

新增手动和定时 workflow，逐 job 配置条件、runner、必要的 Environment、依赖安装及独立 HOME/CLAUDE_CONFIG_DIR；skillhub 保持公共默认，同时核对 model/cloud 的 secrets job-if 不受支持，不能与 desktop 的 vars gate 混为可靠执行条件。

涉及位置：`.github/workflows/live-validation.yml`

### 5. 记录分层验证结果与边界

在 RELEASE 写入已有模型四项和 SkillHub 一项 sentinel，在 STATUS 仅提升公共 registry 状态，并保留 Cloud、交互桌面与私有 registry 的后续步骤；没有 执行标识 时不声明 hosted CI 执行。

涉及位置：`docs/RELEASE.md`、`docs/STATUS.md`

## 风险与处理

- 四个 job 的外部依赖差异很大，统一 workflow 成功可能被误读；必须逐 job 记录 executed、skipped 与 absent，而非只看汇总状态。
- self-hosted desktop 使用固定配置路径，若 runner 复用目录，隔离强度不同于全新 hosted runner。
- model/cloud 初始判断只写在不受支持的 secrets job-if 中，脚本没有 skip guard；既不能推断有效 job skip，也不会得到脚本 skip sentinel。
- 公共响应字段回退可能掩盖异常数据类型，缺失 slug 的记录仍被过滤，版本字段仅在非空字符串时进入结果。

## 验收顺序

1. 静态比较父提交与当前提交，确认八个路径、四个新脚本和 SkillHub 四处字段映射全部覆盖。
2. 依据 at-commit RELEASE 引用模型四项与 SkillHub sentinel，不将该记录改写为本次重新运行或 Actions 结果。
3. 分别在授权 OAuth 与交互桌面环境运行对应脚本时，应检查 session ID、持久化文件、archive、screenshot 和清理，而非只等待进程退出。
4. 后续 hosted run 应逐 job 核对条件求值、runner、sentinel 和 skip；缺省或跳过不能提升为 live round trip 执行。
5. 以临时 registry 响应覆盖 global、latestVersion 对象/字符串、displayName/name 和 summary/description 的优先顺序。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- 四个 live 脚本、四 job workflow 和独立配置路径已经加入。
- SkillHub global namespace 与响应字段兼容已经落地，远程加载继续复用既有 loader。
- at-commit 文档已经记录模型四项和公共 SkillHub sentinel，并保留 Cloud/desktop 的未验证边界。

### 未完成或后续工作

- model/cloud 的有效 CI 门控尚未实现；Cloud 和桌面实际往返、私有 SkillHub 以及该 revision 的 hosted Actions 执行均没有随提交证据。
