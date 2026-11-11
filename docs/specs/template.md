---
commit: <full-sha | self>
changeId: <required-when-commit-is-self>
title: <commit-subject>
date: <commit-date>
status: implemented | partial | unimplemented
kind: component | metadata-migration | evidence-update
retrospective: true
---

# <commit-subject>

> 正文必须依据对应 revision 独立撰写。结构化记录使用显式日期+功能 slug；验收只写应满足的条件，不写历史执行结果。

## 前置状态与问题

<父提交的具体行为、缺陷或缺失能力，以及为什么需要本提交>

## 目标与非目标

<可观察目标与明确排除的范围>

## 方案与控制流

<组件职责、接口、状态转换、持久化或端到端控制流；元数据提交只写实际迁移流程>

## 文件、接口与复用关系

<变更文件的设计作用、复用模块和测试关系，而不是裸文件列表>

## 关键决策与工程取舍

<为什么采用该结构，以及兼容、复杂度和失败语义方面的代价；无法确认时明确回溯分析>

## 安全与协议边界

<权限、认证、路径、进程、网络及协议约束；不适用于该提交时不设本节>

## 验收标准

<可以独立判断实现是否满足目标的行为条件>

## 实现状态与剩余范围

<implemented/partial/unimplemented 及具体未完成项，不附历史执行结论>
