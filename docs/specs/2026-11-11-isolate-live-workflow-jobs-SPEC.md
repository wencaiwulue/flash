---
commit: 85028f74ed5ec110dcfd0a0933f615f88cc4600e
title: 临时缩减 live workflow 的 job 解析面
date: 2026-11-11
retrospective: true
---

# 临时缩减 live workflow 的 job 解析面

## 设计

该提交从 workflow 删除 cloud 和 desktop 两个 job，只保留 model 与 SkillHub，用于隔离平台解析问题。两个验证脚本本身没有删除，后续恢复 job 时仍应调用同一入口。

删除 cloud/desktop 后，workflow 不再提供 OAuth Cloud 或桌面验证路径；保留的 model secrets job-if 仍需独立处理。

## 验收标准

1. jobs 只剩 model 与 skillhub，cloud/desktop 的 if、steps、env 一并移除。
2. `scripts/live-cloud-validation.ts` 和 `live-desktop-validation.ts` 不需要随删除而修改。
3. 文档只描述临时解析面缩减，不宣称 Cloud/desktop 已支持或被永久移除。
