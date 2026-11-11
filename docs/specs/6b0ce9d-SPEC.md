---
commit: 6b0ce9d6834a125567ec0121caa531f5b8341101
title: "Finalize previous commit documentation"
date: 2026-11-11T11:13:50+08:00
status: implemented
kind: metadata-migration
---

# Finalize previous commit documentation

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父版本 787b2dc 的 INDEX 为 Implemented 69，b6bf982 尚无 SPEC/PLAN 或 status 对象。这里的 b6bf982 是本提交的祖父提交而非直接父提交，中间的 787b2dc 不能误写进新文件身份。

需要补登记文档链中较早的 b6bf982，同时让它自己的 SPEC 正确描述 b6bf982 为 6c3c1e4 建文档的四路径变更；若按通常的直接父提交模板处理，会同时错置两层提交。

## 目标与非目标

### 目标

- 以 b6bf9822536793efc08cd9ce4d94f1c066530d1c 的完整身份新建 SPEC 与 PLAN，记录其 6c3c1e4 文档产物范围。
- 把 b6bf982 加入 INDEX 和 status/index.json，将 Implemented 从 69 调至 70，并保持 self 条目位于末尾。

### 非目标

- 不改写 787b2dc、6c3c1e4 或 b6bf982 的既有历史文档，也不增加产品功能。
- 不把 PLAN 中的测试、构建及 CI 检查清单视作本提交留下的执行结果。

## 方案架构与数据流

本次落盘完全是文档元数据：两个新 Markdown 负责祖父提交说明，两个既有索引负责人工与机器检索，没有运行时代码路径。

b6bf982-SPEC 内嵌的 Actual scope 指向更下一层的 6c3c1e4-SPEC/PLAN；本提交自身则只新增 b6bf982 的两个文件并更新 INDEX/status。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/INDEX.md` | Implemented 69→70，新增 b6bf982 表格入口。 |
| 变更 | `docs/plans/b6bf982-PLAN.md` | 新建祖父提交 b6bf982 的实施计划。 |
| 变更 | `docs/specs/b6bf982-SPEC.md` | 新建 b6bf982 规格并记录 6c3c1e4 嵌套文档范围。 |
| 变更 | `docs/status/index.json` | 在 self 前注册 b6bf982 的机器可读对象。 |

## 关键决策与工程取舍

- SPEC 明确采用 b6bf982 的日期、标题和 implemented 状态，并列出其 6c3c1e4 两个文档、INDEX、status 共四个路径及 78 增 1 删。
- 新表格行和 JSON 对象均插在 self 前，Implemented 单独增一；Partial 1、Unimplemented 0 及 self 内容不变。

### 备选方案与回溯分析

- 若改为给直接父提交 787b2dc 建档，会漏掉当时尚无入口的 b6bf982；若只补 SPEC，则 PLAN 与两类索引仍无法形成完整导航，因此维持四文件闭合。

## 安全与协议边界

- diff 仅含文档和索引文本，没有密钥、权限判断或协议实现变化；通用安全句子不构成安全控制已落地的证明。

## 验收标准

- 两个 frontmatter 与 b6bf982 的 full SHA、2026-11-11T11:12:31+08:00 时间及标题一致。
- INDEX 70/1/0 汇总、新增 b6bf982 链接行和 status 中同 SHA 对象相互对应，self 仍在最后且没有额外变更路径。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | 新 SPEC frontmatter 锁定 b6bf982，而 Actual scope 列出的是该提交为 6c3c1e4 创建的两个产物。 | `docs/specs/b6bf982-SPEC.md`，符号 `commit: b6bf9822536793efc08cd9ce4d94f1c066530d1c`，revision `6b0ce9d6834a125567ec0121caa531f5b8341101` |
| diff-observed | 新 PLAN 使用同一 b6bf982 身份并包含实施步骤、风险、验证及完成状态小节。 | `docs/plans/b6bf982-PLAN.md`，符号 `## Implementation steps`，revision `6b0ce9d6834a125567ec0121caa531f5b8341101` |
| diff-observed | INDEX patch 将 implemented 计数改为 70，并在 self 前加入 b6bf982 的双链接行。 | `docs/INDEX.md`，符号 `- Implemented: 70`，revision `6b0ce9d6834a125567ec0121caa531f5b8341101` |
| diff-observed | status patch 插入 b6bf982 完整对象，spec/plan 字段指向本次新建的两个路径。 | `docs/status/index.json`，符号 `"fullSha": "b6bf9822536793efc08cd9ce4d94f1c066530d1c"`，revision `6b0ce9d6834a125567ec0121caa531f5b8341101` |
| not-recorded | 新文档列出的 bun test、typecheck、build 与 CI 均没有随附输出，不能作为已通过证据。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- 新 SPEC/PLAN 对 b6bf982 的设计说明较模板化；本记录只能确认其实际元数据范围和关联，不能补足未记录的验证。
