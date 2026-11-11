---
commit: 4dd93b75220926cefbe9d5d017224238bfd8e0f1
title: "Re-register live validation workflow"
date: 2026-11-11T09:23:48+08:00
status: implemented
kind: metadata-migration
---

# Re-register live validation workflow

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父版本把 live 验证定义保存在 .github/workflows/live-validation.yml，内部名称仍为 live-validation。

提交主题指向重新注册，但可观察实现只有 workflow 文件换名；外部注册故障和结果都没有记录，设计范围不能扩展到平台行为。

## 目标与非目标

### 目标

- 将定义迁移到 .github/workflows/live-checks.yml，并保持 YAML 字节不变。

### 非目标

- 不修改内部名称、触发器、job、权限或验证脚本。
- 不把文件换名描述成 workflow dispatch、schedule 或 CI 已成功。

## 方案架构与数据流

产品架构不适用：本提交只有 GitHub Actions 路径迁移，没有产品源码或运行时 wiring；CI 定义本身不变。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `.github/workflows/live-checks.yml`（原路径 `.github/workflows/live-validation.yml`） | 同一 YAML blob 的纯重命名，覆盖新旧两个路径。 |

## 关键决策与工程取舍

- 以单一 R100 rename 表达注册路径变化，保留 model、skillhub 两个 job 及原有 name 字段。

### 备选方案与回溯分析

- 事后看，同时修改 name 虽能让显示名贴近新文件名，却会破坏纯重命名范围；保留旧路径则不存在本次可观察的注册路径迁移。

## 安全与协议边界

- contents: read、secret 与 variable 引用均逐字保留，没有新增权限或执行步骤。

## 验收标准

- 旧路径消失、新路径出现，rename detection 为 R100，新旧 blob 直接比较为空。

## 实现状态与剩余范围

- 状态：**implemented**
- GitHub 是否随后收录或执行新路径下的 workflow，需要平台侧证据。
