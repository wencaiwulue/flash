---
commit: 4dbadb8a7616033419b9d4a614b62c11c1c3df52
title: 同步 live workflow 状态与桌面跳过语义
date: 2026-11-11
retrospective: true
---

# 同步 live workflow 状态与桌面跳过语义

## 设计

该提交同步两处发布文档：`docs/STATUS.md` 新增 live-validation workflow 行，区分 model、SkillHub、Cloud job 与无 self-hosted runner 时的 desktop skip；`docs/RELEASE.md` 扩展同一段，补充 workflow 和 skip 元数据。

这是状态文档更新，不改变门控实现。文档必须保持 job 执行与 desktop skip 的不同语义，不把 desktop 写成已执行。

## 验收标准

1. STATUS 新行列出三个 job 与 desktop skip，RELEASE 同步该边界。
2. 两处均保留授权桌面环境与无 runner skip 的区别。
3. diff 只修改 STATUS/RELEASE，未改 workflow 或探针。
