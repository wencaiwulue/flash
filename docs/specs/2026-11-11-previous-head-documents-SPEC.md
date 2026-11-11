---
commit: 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc
title: 在历史循环后补写 previous HEAD 文档
date: 2026-11-11
retrospective: true
---

# 在历史循环后补写 previous HEAD 文档

## 设计

主循环仍使用 `commits().slice(0,-1)` 排除当前 HEAD。该提交在循环之后新增 `commits().at(-2)`，若存在 previousHead，则额外调用 specFor/planFor 写入 previousHead 的 SPEC/PLAN。

这形成“祖先循环 + previousHead 补充 + self”的三段结构：previousHead 获得 SHA 文档，但 INDEX 和 JSON 不增加对应行，状态计数也不变。该不对称是本次设计的实际边界，不能描述为完整索引注册。

## 验收标准

1. previousHead 的 SPEC/PLAN 被补写且使用其 full SHA metadata。
2. 当前 HEAD 仍由 self 表示，主循环不处理它。
3. 单 commit 时 at(-2) 不存在，不生成额外文件。
4. INDEX/JSON/count 不因补充文件自动增加，后续若需要完整注册必须单独修正。
