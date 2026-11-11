---
commit: 4dbadb8a7616033419b9d4a614b62c11c1c3df52
title: Live workflow 状态同步的实施步骤
date: 2026-11-11
retrospective: true
---

# Live workflow 状态同步的实施步骤

## 1. 核对 workflow 与脚本状态

检查 live-checks.yml 的 model/cloud/desktop 条件，以及 model/cloud/desktop 脚本的 skip 分支，区分 job 执行与 desktop 未配置。

## 2. 更新 STATUS

在构建与测试状态之后新增 live-validation workflow 行，列出 model、SkillHub、Cloud 与 desktop skip。

## 3. 更新 RELEASE

在同一段补 workflow 与 skip 元数据，保持 Cloud 凭据缺失和 desktop 无 runner 的不同处理。

## 4. 验收

检查两文件 diff 与 live-checks.yml 一致，未把 desktop skip 描述为 screenshot 成功。
