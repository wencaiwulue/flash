---
commit: <full-sha | self>
changeId: <required-when-commit-is-self>
title: <commit-subject>
date: <commit-date>
status: implemented | partial | unimplemented
kind: component | metadata-migration | evidence-update
---

# <commit-subject>

> 本文由结构化记录渲染。正文必须依据该提交的 diff、实现、测试和有出处的证据独立编写；本模板只规定结构，不是可交付内容。

## 前置状态与问题

<父提交的具体行为、缺陷或缺失能力，以及为什么需要本提交>

## 目标与非目标

<本提交的可观察目标，以及明确排除的范围>

## 方案架构与数据流

<组件职责、接口、状态转换、持久化格式或端到端数据流；纯元数据提交写实际迁移流程>

## 文件、接口与证据关系

<每个变更文件的设计作用、复用模块、测试和证据来源，而不是裸文件列表>

## 关键决策与工程取舍

<为什么采用该结构，复用、兼容性、复杂度和失败语义方面的代价>

## 备选方案与回溯分析

<与代码相符的备选方案及不采用原因；不得虚构未记录的作者心理活动>

## 安全与协议边界

<权限、认证、路径、进程、网络及未知协议约束>

## 验收标准

<可以独立判断实现是否满足目标的行为条件>

## 验证证据

<区分新增测试、实际执行、CI、diff 事实和后续证据，并给出具体来源>

## 实现状态与剩余范围

<implemented/partial/unimplemented 及具体未完成项>
