---
commit: b183b9a76948750cf396dd36c62ad06a62221b60
title: 恢复 Cloud/Desktop job 并添加凭据门控
date: 2026-11-11
retrospective: true
---

# 恢复 Cloud/Desktop job 并添加凭据门控

## 设计

该提交为 model 添加 API key if，并恢复 cloud/desktop 两个完整 job。cloud 条件要求 OAuth token、org UUID 和 base URL 全非空，desktop 要求 `vars.CLAUDE_DESKTOP_LIVE=='1'` 且使用 self-hosted。

model/cloud 仍在 `jobs.*.if` 直接使用 secrets，因此门控写法存在上下文限制；恢复 job 不能等同于门控有效。

## 验收标准

1. model、cloud、desktop 的 if、runner、脚本和 env 与 diff 一致，skillhub 不变。
2. cloud/desktop 的脚本入口与先前删除文件一致。
3. model/cloud 的 secrets job-if 必须被标为待修正，不得宣称缺配置可靠跳过。
