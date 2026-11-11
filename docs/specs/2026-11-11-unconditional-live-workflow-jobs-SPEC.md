---
commit: 17f52b5584441f3c937f3d927acad381852159b7
title: 测试无 job 条件的 live workflow
date: 2026-11-11
retrospective: true
---

# 测试无 job 条件的 live workflow

## 设计

该提交删除 model 和 skillhub 的 job-level if，验证没有条件表达式时 workflow 的注册与执行行为。此时 model 不再检查 API key，SkillHub 不再限制 pull_request 事件；缺少凭据时仍会进入依赖安装和探针脚本，因为脚本内 skip guard 尚未加入。

## 验收标准

1. model 与 skillhub 均无 `if`，其余 job 配置保持不变。
2. 缺 API key 的行为不能再描述为 job-level skip；应在脚本入口补充明确 guard 或接受失败。
3. workflow_dispatch 与 schedule 之外的事件行为必须与无条件语义一致，不能沿用旧过滤假设。
