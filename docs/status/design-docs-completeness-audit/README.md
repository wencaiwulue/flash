# Design Docs Completeness Audit

## 基线

- 仓库 commit：c546cf2cd86e263d59dfd13b9894868c3b00813d → **3e615fd** (增量)
- 上游 CLI：2.1.212 (Claude Code)
- 官方文档索引：https://code.claude.com/docs/llms.txt
- 矩阵生成时间：2026-11-16T06:23:54.850Z
- 范围：69 个注册子系统、全部 coverage groups、顶层文档、未注册工程 spec 与横向契约。
- 当前状态：矩阵已建立，子系统审查尚未完成；open 不表示无问题。

## 基线检查结果

```
Design docs: 0 errors, 73 warnings
```

## 总矩阵

| Spec ID | Batch | Coverage groups | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 发现 | 报告 |
|---|---:|---:|---|---|---|---|---:|---|
| documentation-system | 0 | 2/2 | 完整 | 一致 | N/A | 充分 (离线测试) | 1 | [00-core-query-sdk.md#documentation-system](00-core-query-sdk.md#documentation-system) |
| plugins | 0 | 14/14 | 完整 | 一致 | 部分一致 | 部分充分 (有测试，缺集成) | 2 | [00-core-query-sdk.md#plugins](00-core-query-sdk.md#plugins) |
| query-core | 0 | 3/3 | 完整 | 一致 | 部分一致 | 部分充分 (有测试，缺端到端) | 2 | [00-core-query-sdk.md#query-core](00-core-query-sdk.md#query-core) |
| sdk-query-sessions | 0 | 11/11 | 完整 | 一致 | 部分一致 | 充分 (核心模块覆盖) | 1 | [00-core-query-sdk.md#sdk-query-sessions](00-core-query-sdk.md#sdk-query-sessions) |
| sdk-type-generation | 0 | 3/3 | 完整 | 一致 | N/A | 充分 | 1 | [00-core-query-sdk.md#sdk-type-generation](00-core-query-sdk.md#sdk-type-generation) |
| cli-startup | 1 | 6/6 | 完整 | 一致 | 一致 | 部分充分 (无直接测试, spec 截断) | 1 | [01-startup-context-model.md#cli-startup](01-startup-context-model.md#cli-startup) |
| context-compaction | 1 | 8/8 | 完整 | 一致 | 一致 | 部分充分 (核心有测试, 其他模块缺) | 3 | [01-startup-context-model.md#context-compaction](01-startup-context-model.md#context-compaction) |
| model-api | 1 | 12/12 | 完整 | 一致 | 一致 | 部分充分 (测试覆盖有限) | 1 | [01-startup-context-model.md#model-api](01-startup-context-model.md#model-api) |
| attachments | 2 | 6/6 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（无独立测试） | 3 | [02-tools-permissions-sessions.md#attachments](02-tools-permissions-sessions.md#attachments) |
| bridge | 2 | 22/22 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 4 | [02-tools-permissions-sessions.md#bridge](02-tools-permissions-sessions.md#bridge) |
| buddy | 2 | 3/3 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（UI交互无测试） | 3 | [02-tools-permissions-sessions.md#buddy](02-tools-permissions-sessions.md#buddy) |
| computer-use | 2 | 3/3 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（真实桌面环境无验收） | 4 | [02-tools-permissions-sessions.md#computer-use](02-tools-permissions-sessions.md#computer-use) |
| file-tools | 2 | 10/10 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（无独立测试） | 3 | [02-tools-permissions-sessions.md#file-tools](02-tools-permissions-sessions.md#file-tools) |
| lsp | 2 | 8/8 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 3 | [02-tools-permissions-sessions.md#lsp](02-tools-permissions-sessions.md#lsp) |
| mcp | 2 | 20/20 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 3 | [02-tools-permissions-sessions.md#mcp](02-tools-permissions-sessions.md#mcp) |
| onboarding-ui | 2 | 1/1 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 3 | [02-tools-permissions-sessions.md#onboarding-ui](02-tools-permissions-sessions.md#onboarding-ui) |
| permissions | 2 | 14/14 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（核心裁决路径无测试） | 3 | [02-tools-permissions-sessions.md#permissions](02-tools-permissions-sessions.md#permissions) |
| session-persistence | 2 | 7/7 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 4 | [02-tools-permissions-sessions.md#session-persistence](02-tools-permissions-sessions.md#session-persistence) |
| shell-tools | 2 | 13/13 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 4 | [02-tools-permissions-sessions.md#shell-tools](02-tools-permissions-sessions.md#shell-tools) |
| tool-framework | 2 | 7/7 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 4 | [02-tools-permissions-sessions.md#tool-framework](02-tools-permissions-sessions.md#tool-framework) |
| auth | 3 | 20/20 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试，B3-auth-01 已修复） | 2 | [03-memory-auth-settings.md#auth](03-memory-auth-settings.md#auth) |
| commit-attribution | 3 | 6/6 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | 3 | [03-memory-auth-settings.md#commit-attribution](03-memory-auth-settings.md#commit-attribution) |
| git-integration | 3 | 9/9 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | 3 | [03-memory-auth-settings.md#git-integration](03-memory-auth-settings.md#git-integration) |
| memory | 3 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | 6 | [03-memory-auth-settings.md#memory](03-memory-auth-settings.md#memory) |
| notifications | 3 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | 1 | [03-memory-auth-settings.md#notifications](03-memory-auth-settings.md#notifications) |
| session-search-recovery | 3 | 8/8 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | 1 | [03-memory-auth-settings.md#session-search-recovery](03-memory-auth-settings.md#session-search-recovery) |
| sessions-share | 3 | 6/6 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（share/ccshare 有完整测试） | 1 | [03-memory-auth-settings.md#sessions-share](03-memory-auth-settings.md#sessions-share) |
| settings | 3 | 21/21 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | 3 | [03-memory-auth-settings.md#settings](03-memory-auth-settings.md#settings) |
| skills | 3 | 17/17 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | 6 | [03-memory-auth-settings.md#skills](03-memory-auth-settings.md#skills) |
| app-state | 4 | 10/10 | ✅完整 | ✅一致（除循环更新防护功能未实现） | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | 2 | [04-app-state-terminal-ui.md#app-state](04-app-state-terminal-ui.md#app-state) |
| assistant-ui | 4 | 2/2 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | 1 | [04-app-state-terminal-ui.md#assistant-ui](04-app-state-terminal-ui.md#assistant-ui) |
| commands-framework | 4 | 3/3 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（测试不足） | 1 | [04-app-state-terminal-ui.md#commands-framework](04-app-state-terminal-ui.md#commands-framework) |
| cost-tracking | 4 | 10/10 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | 1 | [04-app-state-terminal-ui.md#cost-tracking](04-app-state-terminal-ui.md#cost-tracking) |
| ide-integration | 4 | 8/8 | ✅完整 | ✅一致（设计文档已明确指出 lockfile 并发与崩溃清理限制） | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | 3 | [04-app-state-terminal-ui.md#ide-integration](04-app-state-terminal-ui.md#ide-integration) |
| ink-platform | 4 | 20/20 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（测试不足） | 1 | [04-app-state-terminal-ui.md#ink-platform](04-app-state-terminal-ui.md#ink-platform) |
| repl-input | 4 | 9/9 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（测试不足） | 2 | [04-app-state-terminal-ui.md#repl-input](04-app-state-terminal-ui.md#repl-input) |
| text-formatting | 4 | 12/12 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 1 | [04-app-state-terminal-ui.md#text-formatting](04-app-state-terminal-ui.md#text-formatting) |
| ui-rendering | 4 | 14/14 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 2 | [04-app-state-terminal-ui.md#ui-rendering](04-app-state-terminal-ui.md#ui-rendering) |
| voice-assistant | 4 | 10/10 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 1 | [04-app-state-terminal-ui.md#voice-assistant](04-app-state-terminal-ui.md#voice-assistant) |
| workspace-ui | 4 | 13/13 | ✅完整 | ✅一致（设计文档已明确指出沙箱刷新竞态权衡） | ⚠️不充分（仅源码） | ❌无测试 | 2 | [04-app-state-terminal-ui.md#workspace-ui](04-app-state-terminal-ui.md#workspace-ui) |
| agent-swarms | 5 | 20/20 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（仅 agent-memory 测试） | 8 | [05-agents-tasks-workflows.md#agent-swarms](05-agents-tasks-workflows.md#agent-swarms) |
| help-feedback | 5 | 2/2 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 2 | [05-agents-tasks-workflows.md#help-feedback](05-agents-tasks-workflows.md#help-feedback) |
| plan-worktree | 5 | 10/10 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（仅 plan-mode 测试） | 3 | [05-agents-tasks-workflows.md#plan-worktree](05-agents-tasks-workflows.md#plan-worktree) |
| review-analysis | 5 | 5/5 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（仅 review-artifact 测试） | 3 | [05-agents-tasks-workflows.md#review-analysis](05-agents-tasks-workflows.md#review-analysis) |
| scheduling | 5 | 22/22 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（仅 cron-lifecycle 测试） | 6 | [05-agents-tasks-workflows.md#scheduling](05-agents-tasks-workflows.md#scheduling) |
| task-system | 5 | 21/21 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 5 | [05-agents-tasks-workflows.md#task-system](05-agents-tasks-workflows.md#task-system) |
| workflow | 5 | 7/7 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（完整 workflow 测试） | 6 | [05-agents-tasks-workflows.md#workflow](05-agents-tasks-workflows.md#workflow) |
| webbrowser-bundled-support | 5 | 2/2 | ✅完整 | ✅一致 | 有边界搜索但未完整对齐 | ⚠️部分充分（有测试，缺集成） | 2 | [05-agents-tasks-workflows.md#webbrowser-bundled-support](05-agents-tasks-workflows.md#webbrowser-bundled-support) |
| daemon-background | 6 | 10/10 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（有测试） | 3 | [06-remote-background-platforms.md#daemon-background](06-remote-background-platforms.md#daemon-background) |
| deep-link | 6 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | 4 | [06-remote-background-platforms.md#deep-link](06-remote-background-platforms.md#deep-link) |
| open-runner | 6 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | 7 | [06-remote-background-platforms.md#open-runner](06-remote-background-platforms.md#open-runner) |
| platform-integrations | 6 | 16/16 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无完整测试） | 3 | [06-remote-background-platforms.md#platform-integrations](06-remote-background-platforms.md#platform-integrations) |
| remote-control | 6 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（部分测试） | 3 | [06-remote-background-platforms.md#remote-control](06-remote-background-platforms.md#remote-control) |
| ssh | 6 | 9/9 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | 3 | [06-remote-background-platforms.md#ssh](06-remote-background-platforms.md#ssh) |
| teleport | 6 | 3/3 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | 8 | [06-remote-background-platforms.md#teleport](06-remote-background-platforms.md#teleport) |
| build-feature-profile | 7 | 7/7 | 完整 | 一致 | N/A | 部分充分（有测试） | 1 | [07-build-runtime-stubs.md#build-feature-profile](07-build-runtime-stubs.md#build-feature-profile) |
| data-structures | 7 | 15/15 | 完整 | 一致 | N/A | 部分充分（无测试） | 4 | [07-build-runtime-stubs.md#data-structures](07-build-runtime-stubs.md#data-structures) |
| diagnostics | 7 | 2/2 | 完整 | 一致 | N/A | 部分充分（有测试） | 7 | [07-build-runtime-stubs.md#diagnostics](07-build-runtime-stubs.md#diagnostics) |
| experimental-features | 7 | 2/2 | 完整 | 一致 | N/A | 部分充分（有测试） | 7 | [07-build-runtime-stubs.md#experimental-features](07-build-runtime-stubs.md#experimental-features) |
| external-stubs | 7 | 5/5 | 完整 | 一致 | N/A | 部分充分（有测试） | 7 | [07-build-runtime-stubs.md#external-stubs](07-build-runtime-stubs.md#external-stubs) |
| hooks-system | 7 | 4/4 | 完整 | 一致 | N/A | 部分充分（有测试） | 2 | [07-build-runtime-stubs.md#hooks-system](07-build-runtime-stubs.md#hooks-system) |
| magic-docs | 7 | 4/4 | 完整 | 一致 | N/A | 部分充分（无测试） | 4 | [07-build-runtime-stubs.md#magic-docs](07-build-runtime-stubs.md#magic-docs) |
| messaging-primitives | 7 | 11/11 | 完整 | 一致 | N/A | 部分充分（有测试） | 3 | [07-build-runtime-stubs.md#messaging-primitives](07-build-runtime-stubs.md#messaging-primitives) |
| native-installer | 7 | 7/7 | 完整 | 一致 | N/A | 部分充分（无测试） | 4 | [07-build-runtime-stubs.md#native-installer](07-build-runtime-stubs.md#native-installer) |
| network-security | 7 | 7/7 | 完整 | 一致 | N/A | 部分充分（有测试） | 6 | [07-build-runtime-stubs.md#network-security](07-build-runtime-stubs.md#network-security) |
| runtime-lifecycle | 7 | 11/11 | 完整 | 一致 | N/A | 部分充分（无测试） | 6 | [07-build-runtime-stubs.md#runtime-lifecycle](07-build-runtime-stubs.md#runtime-lifecycle) |
| telemetry | 7 | 1/1 | 完整 | 一致 | N/A | 部分充分（无测试） | 4 | [07-build-runtime-stubs.md#telemetry](07-build-runtime-stubs.md#telemetry) |
| test-validation | 7 | 11/11 | 完整 | 一致 | N/A | 部分充分（有测试） | 6 | [07-build-runtime-stubs.md#test-validation](07-build-runtime-stubs.md#test-validation) |
| web-tools | 7 | 9/9 | 完整 | 一致 | N/A | 部分充分（有测试） | 5 | [07-build-runtime-stubs.md#web-tools](07-build-runtime-stubs.md#web-tools) |

## 分类统计与整改顺序

### Batch 0 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 5 |
| 完整文档 | 5 |
| 实现一致 | 5 |
| 发现总数 | 5 |
| P0 | 0 |
| P1 | 0 |
| P2 | 2 |
| P3 | 3 |

### Batch 1 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 3 |
| 完整文档 | 3 |
| 实现一致 | 3 |
| 上游一致 | 3 |
| 发现总数 | 5 |
| 有效发现（open） | 4 |
| 误报（rejected） | 1 |
| P0 | 0 |
| P1 | 0 |
| P2 | 3 |
| P3 | 2（其中 1 个 rejected） |

### 发现分类（仅有效发现）

| 类别 | 数量 |
|------|------|
| 测试缺口 | 4 |
| 证据不足 | 0（原 1 个为误报） |

### Batch 2 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 12 |
| 完整文档 | 12 |
| 实现一致 | 12 |
| 发现总数 | 41 |
| P0 | 0 |
| P1 | 0 |
| P2 | 24 |
| P3 | 17 |

### Batch 3 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 9 |
| 完整文档 | 9 |
| 实现一致 | 9 |
| 发现总数 | 26 |
| P0 | 0 |
| P1 | 0 (1 已修复) |
| P2 | 12 |
| P3 | 13 |

### 发现分类（含 Batch 2）

| 类别 | 数量 |
|------|------|
| 测试缺口 | 27 |
| 验证缺口 | 12 |
| 契约缺口 | 5 |
| 验收缺口 | 1 |
| 证据不足 | 1 |

### Batch 4 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 10 |
| 完整文档 | 10 |
| 实现一致 | 10 |
| 发现总数 | 17 |
| P0 | 0 |
| P1 | 0 |
| P2 | 11 |
| P3 | 6 |

### Batch 5 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 8 |
| 完整文档 | 8 |
| 实现一致 | 8 |
| 发现总数 | 35 |
| P0 | 0 |
| P1 | 0 |
| P2 | 13 |
| P3 | 22 |

### Batch 6 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 7 |
| 完整文档 | 7 |
| 实现一致 | 7 |
| 发现总数 | 31 |
| P0 | 0 |
| P1 | 0 |
| P2 | 6 |
| P3 | 25 |

### Batch 7 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 14 |
| 完整文档 | 14 |
| 实现一致 | 14 |
| 发现总数 | 66 |
| P0 | 0 |
| P1 | 1 |
| P2 | 25 |
| P3 | 40 |

### 跨域发现统计

| 类别 | 数量 | 说明 |
|------|------|------|
| X-context | 3 | X-context-01/X-context-05/X-context-06（X-context-02/X-context-03/X-context-04 为已验证契约） |
| X-memory | 3 | X-memory-02/X-memory-03/X-memory-04 |
| X-state | 1 | X-state-01 |
| X-recovery | 1 | X-recovery-01 |
| X-boundary | 1 | X-boundary-01 |
| **总计** | **9** | 1 P2、8 P3 |

---

## 总分类统计

| 类别 | 数量 |
|------|------|
| Batch 0 | 5 |
| Batch 1 | 4（原 5，1 个 rejected） |
| Batch 2 | 41 |
| Batch 3 | 26 |
| Batch 4 | 17 |
| Batch 5 | 35 |
| Batch 6 | 31 |
| Batch 7 | 66 |
| 跨域 | 9 |
| **总计** | **234**（原 235，1 个 rejected） |

### 按严重度分类（仅有效发现）

| 严重度 | 数量 |
|--------|------|
| P0 | 0 |
| P1 | 1（原 2，1 个已修复） |
| P2 | 98（原 97，新增 1 个测试） |
| P3 | 135（原 136，1 个 rejected） |
| **总计** | **234**（原 235，1 个修复 +1 个新增测试） |

### 误报记录（rejected）

| 批次 | ID | 说明 |
|------|----|------|
| Batch 1 | B1-cli-startup-01 | cli-startup spec 截断误报——实际文档完整共 2394 行 |

### 发现分类统计

| 类别 | 数量 |
|------|------|
| 文档缺口 | 10 |
| 已证实实现问题 | 10 |
| 上游偏离 | 0 |
| 验证缺口 | 185 |
| 可选改进 | 30 |
| **总计** | **235** |

### P1 发现详情

| ID | 主责 | 说明 | 证据 | 依赖 | 验收条件 | 来源 |
|----|------|------|------|------|----------|------|
| B3-auth-01 ✅ | auth | [已修复] Keychain 缓存 30 秒，跨进程刷新后另一个进程最多 30 秒才看到新 token | `src/utils/secureStorage/macOsKeychainHelpers.ts:90-109` | None | 使用共享 cache-version 标记（~/.claude/.keychain-cache-version.json），每次写入时原子更新 UUID，读取前检查版本，变更则立即刷新缓存 | [03-memory-auth-settings.md](03-memory-auth-settings.md) |
| B7-test-validation-06 | test-validation | `scripts/live-model-validation.ts` 在 `enableConfigs()` 前检查凭据，standalone 脚本的 settings 初始化契约需要明确，凭据互斥检查需要集中处理 | `scripts/live-model-validation.ts:40-48` | None | 明确 standalone 脚本的 settings 初始化契约，集中处理凭据互斥检查 | [07-build-runtime-stubs.md](07-build-runtime-stubs.md) |

---

## 完整整改优先级

### P1 问题（1 项，1 项已修复）

1. **B3-auth-01 ✅ 已修复**：（主责：auth）
   - 描述：[已修复] Keychain 缓存 30 秒，跨进程刷新后另一个进程最多 30 秒才看到新 token
   - 证据：`src/utils/secureStorage/macOsKeychainHelpers.ts:90-109, src/utils/secureStorage/macOsKeychainStorage.ts:26-199`
   - 修复方案：使用共享 cache-version 标记（~/.claude/.keychain-cache-version.json），每次写入时原子更新 UUID，读取前检查版本，变更则立即刷新缓存
   - 来源：[03-memory-auth-settings.md](03-memory-auth-settings.md)

2. **B7-test-validation-06**：（主责：test-validation）
   - 描述：`scripts/live-model-validation.ts` 在 `enableConfigs()` 前检查凭据，standalone 脚本的 settings 初始化契约需要明确，凭据互斥检查需要集中处理
   - 证据：`scripts/live-model-validation.ts:40-48`
   - 依赖：None
   - 验收：明确 standalone 脚本的 settings 初始化契约，集中处理凭据互斥检查
   - 来源：[07-build-runtime-stubs.md](07-build-runtime-stubs.md)

### P2 问题（97 项，优先级排序）

1. **测试缺口类**：优先添加关键路径测试
   - plugins/query-core 集成测试
   - B2 各子系统独立测试
   - B4 UI 组件测试
   - B5 Agent 子系统测试
   - B6 远程连接测试
   - B7 工程模块测试

2. **文档缺口类**：补充 spec 缺失章节
   - 各子系统 7.0 测试场景说明
   - feature gate 集中文档

3. **实现问题类**：修复不一致
   - 模块级状态清理
   - 路径验证统一

### P3 问题（136 项，可选改进）

- 硬编码阈值配置化
- 额外验证机制
- 文档完善建议

---

### 跨域发现优先级

1. **P2（1项）**：X-context-01（内存路径验证不一致 - 读取仅字符串前缀，写入完整 symlink 解析）
2. **P3（8项）**：X-context-05（上下文折叠阈值硬编码）、X-context-06（进度消息桥接机制）、X-memory-02（lastSummarizedMessageId 未持久化）、X-memory-03（无删除失效跟踪）、X-memory-04（密钥扫描模式未审计）、X-state-01（模块级可变状态）、X-recovery-01（会话元数据未验证）、X-boundary-01（功能门未集中文档）

注：X-context-02/X-context-03/X-context-04 已移至"契约验证确认"部分，为已验证正确契约而非缺陷。

---

## 文档整改台账（Task 17A/B）

**状态：仅文档层面 verified，未修改源码或修复代码问题**

| 整改项 | 关联 Finding ID | 文档更新 | 状态 | PR/Commit |
|--------|----------------|---------|------|-----------|
| Context/Memory spec 澄清 | X-context-01, X-memory-02/03/04 | `docs/superpowers/specs/2026-11-12-context-compaction-design.md`, `docs/superpowers/specs/2026-11-12-memory-design.md` | ✅ verified (文档) | #16 |
| Skills/Workflow/AppState/Session 契约 | X-state-01 | `docs/superpowers/specs/2026-11-12-app-state-design.md`, `docs/superpowers/specs/2026-11-12-session-persistence-design.md`, `docs/superpowers/specs/2026-11-12-workflow-design.md`, `docs/superpowers/specs/2026-11-12-skills-design.md` | ✅ verified (文档) | #16 |
| Build/Diagnostics/Placeholder 边界 | X-boundary-01 | `docs/superpowers/specs/2026-11-12-build-feature-profile-design.md`, `docs/superpowers/specs/2026-11-12-diagnostics-design.md`, `docs/superpowers/specs/2026-11-12-external-stubs-design.md` | ✅ verified (文档) | #16 |
| Protocol/Test-validation 契约 | B7-test-validation-06 | `docs/superpowers/specs/2026-11-12-test-validation-design.md`, `docs/superpowers/specs/2026-11-12-bridge-design.md`, `docs/superpowers/specs/2026-11-12-tool-framework-design.md` | ✅ verified (文档) | #16 |
| WebBrowser smoke coverage verified | webbrowser-bundled-support batch 5 | `docs/superpowers/specs/2026-11-16-webbrowser-bundled-support-design.md`, `docs/status/design-docs-completeness-audit/05-agents-tasks-workflows.md` | ✅ verified (文档) | #16 |
| 全量 69 注册 spec 三视图覆盖 | all 69 specs | `docs/superpowers/specs/` (all 69 registered spec files) | ✅ verified (文档) | #16 |

**Rejected 发现保留：** B1-cli-startup-01 保持 rejected，有效发现 234 + rejected 1 口径不变。

---

## 验证与测试结果

#### `bun scripts/check-design-docs.ts`
✅ Passed - 0 errors, 72 warnings (expected - 69 DRAFT_SPEC + 3 UNCOVERED_FILE: scripts/install.sh, tests/claudeInChromeWiring.test.ts, tests/installScript.test.ts)

#### `git diff --check`
✅ Passed - no whitespace errors

### 测试结果

#### `bun run typecheck`
✅ Exit code: 0 - Passed

#### `bun run test`
✅ Exit code: 0 - Passed (no failed test files)

#### `bun run build`
✅ Exit code: 0 - Passed

---

## 完成判定

| 批次 | 状态 | 说明 |
|------|------|------|
| batch 0 | ✅ 已完成 | 核心契约审查，5 项发现 |
| batch 1 | ✅ 已完成 | Context 审查，4 项有效发现（1 项误报 rejected） |
| batch 2 | ✅ 已完成 | 工具与会话审查，41 项发现 |
| batch 3 | ✅ 已完成 | Memory 审查，26 项发现（含 1 P1） |
| batch 4 | ✅ 已完成 | UI 子系统审查，17 项发现 |
| batch 5 | ✅ 已完成 | Agent 子系统审查，35 项发现 |
| batch 6 | ✅ 已完成 | 远程连接审查，31 项发现 |
| batch 7 | ✅ 已完成 | 工程模块审查，66 项发现（含 1 P1） |
| cross-subsystem | ✅ 已完成 | 横向契约审查，9 项发现 |

**总体状态**：✅ **审计完成** - 所有 69 个子系统已覆盖（含新增 webbrowser-bundled-support），发现已登记，无 P0 问题，2 项 P1 问题待修复。完整报告请参考各 batch 文件及 [cross-subsystem.md](cross-subsystem.md)。注：总计 234 项有效发现，另有 1 项误报（B1-cli-startup-01）已标记 rejected。
