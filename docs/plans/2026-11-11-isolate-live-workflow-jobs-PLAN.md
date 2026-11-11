---
commit: 85028f74ed5ec110dcfd0a0933f615f88cc4600e
title: "Isolate live workflow job parsing"
date: 2026-11-11T09:20:57+08:00
status: partial
kind: component
---

# 实施计划：Isolate live workflow job parsing

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

提交主题把变化称为隔离 live workflow 的 job 解析，实际做法是从 workflow 删除 Cloud 与 desktop 两个完整 job，只留下 model 和 skillhub。没有解析错误或平台日志可用于进一步解释原因；可确定的是两类验证在 CI 编排中消失，而脚本和四 job 文档仍保留。

- 读取 6ef3352651472a951a3779f7b9f906fbc5ca86ca 的完整四 job 文件，确认 Environment 已在父提交移除，本步只处理 Cloud/desktop job。

## 复用与兼容处理

### 复用现有实现

- 保留 model 与 SkillHub 的既有命令、隔离目录和 gate，并保留两个外部能力脚本供直接调用或后续恢复。

### 兼容、迁移与生命周期

- 手动和定时触发、model/SkillHub 的既有路径不变；model 的 secrets job-if 上下文缺陷也未在本提交处理。
- Cloud 与 desktop 从 CI job 变为仅脚本可调用；absent 不代表条件求值为 skipped。
- 原 Environment 解除状态保持不变，本提交没有重命名 workflow 或改变内部 name。

## 文件级实施步骤

### 1. 确定要保留的二 job 基线

核对 model 与 skillhub 的起止范围及其 if，明确本提交不重排或改写这两段，也不重新添加 Environment。

涉及位置：`.github/workflows/live-validation.yml`

### 2. 整段移除 Cloud 与 desktop 编排

先删除 cloud 的 runner、安装、OAuth env 和脚本步骤，再删除 desktop 的 self-hosted runner、变量 gate、隔离 env 与 screenshot 脚本步骤。

涉及位置：`.github/workflows/live-validation.yml`

### 3. 核对脚本留存与覆盖缺口

读取两个脚本确认实现未删，再把它们标记为 workflow 未引用；对照 RELEASE 记录四 job 文案偏差，且没有运行证据时不声称解析已修复。

涉及位置：`scripts/live-cloud-validation.ts`、`scripts/live-desktop-validation.ts`、`docs/RELEASE.md`

## 风险与处理

- 仅看脚本和 RELEASE 会误以为 Cloud/desktop 仍由 CI 覆盖，实际已没有相应 job。
- 若后续只复制最终四 job 状态而不记录此中间态，会丢失此次隔离对验证范围的真实影响。

## 验收顺序

1. 检查 diff 为单文件 31 行删除，并在 at-commit YAML 中确认仅 model、skillhub 两个 job。
2. 分别确认 Cloud/desktop 脚本 blob 未改，且不为其虚构 skip 或 live 成功日志。
3. 后续若恢复 job，应以新的 revision 和运行记录证明，不回填为本提交结果。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- Cloud/desktop 的 31 行 CI 编排已移除，model 与 SkillHub 保持原条件及步骤。
- 两个被移除入口对应的脚本仍完整保留。

### 未完成或后续工作

- Cloud/desktop CI 覆盖与文档一致性尚未恢复，model 的 secrets job-if 仍无效，平台解析和 workflow 执行均无证据。
