---
commit: 4c04383cd5a2ee8953031948453d99da6d080946
title: 用 env 上下文替换 secrets 门控
date: 2026-11-11
retrospective: true
---

# 用 env 上下文替换 secrets 门控

## 设计

model/cloud 在 job 级 `env` 中先把 secrets 映射为同名环境变量，再把 if 改为读取 `env.*`。cloud 的三个变量保持同一映射，desktop 的 vars 条件不变。

该结构避免在 if 中直接访问 secrets，但 secrets 值也进入 job 环境，脚本仍只能使用必要变量，日志不得输出其内容。

## 验收标准

1. model/cloud 的 if 只引用 env，job-level env 与 secret 映射一一对应。
2. 步骤 env 中原有 OAuth/base URL/HOME/config 不被覆盖或丢失。
3. desktop 仍使用 vars.CLAUDE_DESKTOP_LIVE，skillhub 不变。
