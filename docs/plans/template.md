---
commit: <full-sha | self>
changeId: <required-when-commit-is-self>
title: <commit-subject>
date: <commit-date>
status: implemented | partial | unimplemented
kind: component | metadata-migration | evidence-update
---

# 实施计划：<commit-subject>

> 本模板只规定结构。实际 PLAN 必须按代码依赖重建文件级实施顺序，不能使用“修改实现并测试”之类的通用步骤。

## 目标与前置条件

<要修复的具体问题、父提交状态和开始实施前必须确认的条件>

## 复用与兼容处理

<复用的现有函数/服务/权限路径；接口、持久化、迁移和生命周期约束>

## 文件级实施步骤

### 1. <先建立的基础类型、schema 或底层模块>

<具体文件、符号、输入输出和本步形成的依赖>

### 2. <接入执行或状态流>

<具体文件、调用关系、错误传播和清理行为>

### 3. <连接 CLI/SDK/UI/CI 等外部入口>

<注册顺序、兼容处理和权限路径>

### 4. <补测试和构建>

<针对上述行为的具体回归及验证方式；步骤数量按实际提交调整>

## 风险与处理

<竞态、迁移、协议、权限或测试盲区及对应缓解措施>

## 验收顺序

<按依赖顺序列出应检查的验收条件，不写历史执行结果>

## 完成状态与剩余工作

<逐项列出已实现和未实现范围，不附测试、CI 或 live 执行结论>
