---
commit: 8117aaa81ba58bb7ddae1256712797880a6cdebd
title: "Finalize self record for current commit"
date: 2026-11-11T10:43:47+08:00
status: implemented
kind: metadata-migration
---

# Finalize self record for current commit

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

直接父提交是 587c466f7e28e4cb59b0c4522857a7110e7b152a。其生成器遍历 git log --reverse 的全部提交，INDEX 当时为 Implemented 40、Partial 1、Unimplemented 0；本提交没有改动这些文档。

最新 HEAD 也进入逐提交文档、索引行和状态计数，提交生成结果后产生的新 SHA 不会与已写入的 HEAD 身份一致，需要把当前 HEAD 排除在历史记录循环之外。

## 目标与非目标

### 目标

- 仅调整 buildCommitDocuments 的历史遍历边界，使最新 HEAD 不再生成历史 SPEC/PLAN 和索引项。
- 保留独立 self 文档与 self 索引项的既有生成路径。

### 非目标

- 本提交不新增 587c466 或 8117aaa 的 SPEC/PLAN，也不修改 INDEX/status。
- 不增加测试、CI 检查或文档内容模板，亦不声称执行过这些验证。

## 方案架构与数据流

commits() 将 git log --reverse 映射为时间正序数组，因而末尾元素就是当前 HEAD；slice(0, -1) 在主循环入口排除这一项。

被截断的循环仍统一负责历史 SPEC、PLAN、INDEX 行、JSON 对象及状态计数，循环之后的 self-SPEC、self-PLAN 和 self 注册逻辑不变。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `scripts/document-commits.ts` | 将历史文档生成循环改为排除最新 HEAD。 |

## 关键决策与工程取舍

- 只把 for (const commit of commits()) 改为 for (const commit of commits().slice(0, -1))，没有在各输出分支分别增加条件。
- self 与历史 HEAD 是两套身份：前者仍固定生成，后者不再冒充一个已经定稿的历史提交。

### 备选方案与回溯分析

- 保留全量循环再过滤输出会分散 HEAD 排除规则；修改 commits() 又会影响其他调用者，因此把边界限定在文档构建循环更直接。

## 安全与协议边界

- 单行变更不引入凭据、网络访问或权限绕过；它只减少被处理的 Git 元数据范围。

## 验收标准

- 当前 HEAD 不进入历史文档、两个索引或 implemented/partial/unimplemented 计数。
- self 的两个文件和索引项仍由原有代码生成，历史数组其余元素处理顺序不变。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | at-commit 源码显示主循环使用 slice(0, -1)，而文件其余部分没有在本提交变化。 | `scripts/document-commits.ts`，符号 `for (const commit of commits().slice(0, -1))`，revision `commit` |
| not-recorded | 该提交只有一行生成器源码差异，没有测试新增、命令输出或 CI 通过记录。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- 此提交只建立排除 HEAD 的规则；它本身及直接父提交的缺失文档需要由后续提交处理。
