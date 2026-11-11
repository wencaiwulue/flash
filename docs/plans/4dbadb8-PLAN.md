---
commit: 4dbadb8a7616033419b9d4a614b62c11c1c3df52
title: "Record live validation workflow success"
date: 2026-11-11T09:42:27+08:00
status: partial
kind: evidence-update
---

# 实施计划：Record live validation workflow success

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要补录 GitHub Actions 结果，同时保留缺凭据跳过与真正执行的区别。实际补丁在 RELEASE 写明 model/Cloud 可跳过，却在 STATUS 写成 Model、SkillHub、Cloud jobs passed，两个公开状态来源因此对 Cloud 给出不一致含义。

- 读取本地 sentinel 的既有发布段，并核对 hosted run 中各 job 是 executed 还是 skipped。

## 复用与兼容处理

### 复用现有实现

- 沿用 STATUS 的 Verified evidence 表和 RELEASE 的 CI live validation 段，不创建第二套运行记录。

### 兼容、迁移与生命周期

- 既有本地 sentinel 不变；新增 hosted 结果必须与原能力矩阵分开解读。

## 文件级实施步骤

### 1. 补写 RELEASE 运行结果

在 SkillHub global namespace 说明后追加 42940722483，并保留三个环境缺省时的跳过语义。

涉及位置：`docs/RELEASE.md`

### 2. 增加 STATUS 摘要

把 workflow 行加入验证表；审查时应发现 Cloud jobs passed 与上一步限定不一致，而不是将其当成可靠 live 证明。

涉及位置：`docs/STATUS.md`

### 3. 核对跨文档结论

逐 job 比较两个文件，标记 Cloud 的冲突并保留 desktop 无 runner 的边界。

涉及位置：`docs/RELEASE.md`、`docs/STATUS.md`

## 风险与处理

- 把 skipped 写成 passed 会让后续审计误以为 OAuth Cloud 已验证，这是本提交实际引入的文档风险。

## 验证顺序

1. 检查两文件 diff 中的 run ID 和 skip 条件，再对照 STATUS 摘要，确认没有把 skip 当作 live 成功。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- hosted run 及跳过条件已进入 RELEASE，STATUS 也增加了对应 workflow 行。

### 未完成或后续工作

- 两个文档对 Cloud 的结论尚未调和，且没有新增 Cloud/desktop 实际执行证据。
