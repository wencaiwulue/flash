---
commit: <full-sha | self>
changeId: <required-when-commit-is-self>
title: <commit-subject>
date: <commit-date>
status: implemented | partial | unimplemented
kind: component | metadata-migration | evidence-update
---

结构化记录必须另含 slug: <feature-slug>；slug 用于输出文件名，不重复写入生成后的 frontmatter。

# <commit-subject>

> 正文依据对应 revision 的实现与测试独立编写；验收标准只写应满足的条件，不记录历史执行结果。

## 前置状态与问题

<父提交的具体行为、缺陷或缺失能力，以及为什么需要本提交>

## 目标与非目标

<本提交的可观察目标，以及明确排除的范围>

## 方案架构与数据流

<组件职责、接口、状态转换、持久化格式或端到端数据流；纯元数据提交写实际迁移流程>

## 文件、接口与复用关系

<每个变更文件的设计作用、复用模块、测试和验收关系，而不是裸文件列表>

## 关键决策与工程取舍

<为什么采用该结构，复用、兼容性、复杂度和失败语义方面的代价>

## 备选方案与回溯分析

<与代码相符的备选方案及不采用原因；不得虚构未记录的作者心理活动>

## 安全与协议边界

<权限、认证、路径、进程、网络及未知协议约束>

## 验收标准

<可以独立判断实现是否满足目标的行为条件>

## 实现状态与剩余范围

<implemented/partial/unimplemented 及具体未完成项>
