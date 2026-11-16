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
| documentation-system | 0 | 2/2 | 完整 | 一致 | N/A | 充分 (离线测试) | 1 | [batch-0.md#documentation-system](batch-0.md#documentation-system) |
| plugins | 0 | 14/14 | 完整 | 一致 | 部分一致 | 部分充分 (有测试，缺集成) | 2 | [batch-0.md#plugins](batch-0.md#plugins) |
| query-core | 0 | 3/3 | 完整 | 一致 | 部分一致 | 部分充分 (有测试，缺端到端) | 2 | [batch-0.md#query-core](batch-0.md#query-core) |
| sdk-query-sessions | 0 | 11/11 | 完整 | 一致 | 部分一致 | 充分 (核心模块覆盖) | 1 | [batch-0.md#sdk-query-sessions](batch-0.md#sdk-query-sessions) |
| sdk-type-generation | 0 | 3/3 | 完整 | 一致 | N/A | 充分 | 1 | [batch-0.md#sdk-type-generation](batch-0.md#sdk-type-generation) |
| cli-startup | 1 | 6/6 | 完整 | 一致 | 一致 | 部分充分 (无直接测试, spec 截断) | 1 | [batch-1.md#cli-startup](batch-1.md#cli-startup) |
| context-compaction | 1 | 8/8 | 完整 | 一致 | 一致 | 部分充分 (核心有测试, 其他模块缺) | 3 | [batch-1.md#context-compaction](batch-1.md#context-compaction) |
| model-api | 1 | 12/12 | 完整 | 一致 | 一致 | 部分充分 (测试覆盖有限) | 1 | [batch-1.md#model-api](batch-1.md#model-api) |
| attachments | 2 | 6/6 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（无独立测试） | 3 | [batch-2.md#attachments](batch-2.md#attachments) |
| bridge | 2 | 22/22 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 4 | [batch-2.md#bridge](batch-2.md#bridge) |
| buddy | 2 | 3/3 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（UI交互无测试） | 3 | [batch-2.md#buddy](batch-2.md#buddy) |
| computer-use | 2 | 3/3 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（真实桌面环境无验收） | 4 | [batch-2.md#computer-use](batch-2.md#computer-use) |
| file-tools | 2 | 10/10 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（无独立测试） | 3 | [batch-2.md#file-tools](batch-2.md#file-tools) |
| lsp | 2 | 8/8 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 3 | [batch-2.md#lsp](batch-2.md#lsp) |
| mcp | 2 | 20/20 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 3 | [batch-2.md#mcp](batch-2.md#mcp) |
| onboarding-ui | 2 | 1/1 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 3 | [batch-2.md#onboarding-ui](batch-2.md#onboarding-ui) |
| permissions | 2 | 14/14 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（核心裁决路径无测试） | 3 | [batch-2.md#permissions](batch-2.md#permissions) |
| session-persistence | 2 | 7/7 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 4 | [batch-2.md#session-persistence](batch-2.md#session-persistence) |
| shell-tools | 2 | 13/13 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 4 | [batch-2.md#shell-tools](batch-2.md#shell-tools) |
| tool-framework | 2 | 7/7 | 完整 | 一致 | 有边界搜索但未完整对齐 | 部分充分（关键路径无测试） | 4 | [batch-2.md#tool-framework](batch-2.md#tool-framework) |
| auth | 3 | 20/20 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（仅 oauthRefresh 和 linuxSecretStorage） | 2 | [batch-3.md#auth](batch-3.md#auth) |
| commit-attribution | 3 | 6/6 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | 3 | [batch-3.md#commit-attribution](batch-3.md#commit-attribution) |
| git-integration | 3 | 9/9 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | 3 | [batch-3.md#git-integration](batch-3.md#git-integration) |
| memory | 3 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | 6 | [batch-3.md#memory](batch-3.md#memory) |
| notifications | 3 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | 1 | [batch-3.md#notifications](batch-3.md#notifications) |
| session-search-recovery | 3 | 8/8 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | 1 | [batch-3.md#session-search-recovery](batch-3.md#session-search-recovery) |
| sessions-share | 3 | 6/6 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（share/ccshare 有完整测试） | 1 | [batch-3.md#sessions-share](batch-3.md#sessions-share) |
| settings | 3 | 21/21 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | 3 | [batch-3.md#settings](batch-3.md#settings) |
| skills | 3 | 17/17 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（测试不完整） | 6 | [batch-3.md#skills](batch-3.md#skills) |
| app-state | 4 | 10/10 | ✅完整 | ✅一致（除循环更新防护功能未实现） | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | 2 | batch-4.md#app-state |
| assistant-ui | 4 | 2/2 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | 1 | batch-4.md#assistant-ui |
| commands-framework | 4 | 3/3 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（测试不足） | 1 | batch-4.md#commands-framework |
| cost-tracking | 4 | 10/10 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | 1 | batch-4.md#cost-tracking |
| ide-integration | 4 | 8/8 | ✅完整 | ✅一致（设计文档已明确指出 lockfile 并发与崩溃清理限制） | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | 3 | batch-4.md#ide-integration |
| ink-platform | 4 | 20/20 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（测试不足） | 1 | batch-4.md#ink-platform |
| repl-input | 4 | 9/9 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（测试不足） | 2 | batch-4.md#repl-input |
| text-formatting | 4 | 12/12 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 1 | batch-4.md#text-formatting |
| ui-rendering | 4 | 14/14 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 2 | batch-4.md#ui-rendering |
| voice-assistant | 4 | 10/10 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 1 | batch-4.md#voice-assistant |
| workspace-ui | 4 | 13/13 | ✅完整 | ✅一致（设计文档已明确指出沙箱刷新竞态权衡） | ⚠️不充分（仅源码） | ❌无测试 | 2 | batch-4.md#workspace-ui |
| agent-swarms | 5 | 20/20 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（仅 agent-memory 测试） | 8 | batch-5.md#agent-swarms |
| help-feedback | 5 | 2/2 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 2 | batch-5.md#help-feedback |
| plan-worktree | 5 | 10/10 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（仅 plan-mode 测试） | 3 | batch-5.md#plan-worktree |
| review-analysis | 5 | 5/5 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（仅 review-artifact 测试） | 3 | batch-5.md#review-analysis |
| scheduling | 5 | 22/22 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（仅 cron-lifecycle 测试） | 6 | batch-5.md#scheduling |
| task-system | 5 | 21/21 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ❌无测试 | 5 | batch-5.md#task-system |
| workflow | 5 | 7/7 | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（完整 workflow 测试） | 6 | batch-5.md#workflow |
| webbrowser-bundled-support | 5 | 2/2 | ✅完整 | ✅一致 | 有边界搜索但未完整对齐 | ⚠️部分充分（有测试，缺集成） | 2 | [batch-5.md#webbrowser-bundled-support](batch-5.md#webbrowser-bundled-support) |
| daemon-background | 6 | 10/10 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（有测试） | 3 | [batch-6.md#daemon-background](batch-6.md#daemon-background) |
| deep-link | 6 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无测试） | 4 | [batch-6.md#deep-link](batch-6.md#deep-link) |
| open-runner | 6 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | 7 | [batch-6.md#open-runner](batch-6.md#open-runner) |
| platform-integrations | 6 | 16/16 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（无完整测试） | 3 | [batch-6.md#platform-integrations](batch-6.md#platform-integrations) |
| remote-control | 6 | 7/7 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ⚠️ 部分充分（部分测试） | 3 | [batch-6.md#remote-control](batch-6.md#remote-control) |
| ssh | 6 | 9/9 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | 3 | [batch-6.md#ssh](batch-6.md#ssh) |
| teleport | 6 | 3/3 | 完整 | 一致 | ⚠️ 不充分（仅源码） | ✅ 充分（有完整测试） | 8 | [batch-6.md#teleport](batch-6.md#teleport) |
| build-feature-profile | 7 | 7/7 | 完整 | 一致 | N/A | 部分充分（有测试） | 1 | [batch-7.md#build-feature-profile](batch-7.md#build-feature-profile) |
| data-structures | 7 | 15/15 | 完整 | 一致 | N/A | 部分充分（无测试） | 4 | [batch-7.md#data-structures](batch-7.md#data-structures) |
| diagnostics | 7 | 2/2 | 完整 | 一致 | N/A | 部分充分（有测试） | 7 | [batch-7.md#diagnostics](batch-7.md#diagnostics) |
| experimental-features | 7 | 2/2 | 完整 | 一致 | N/A | 部分充分（有测试） | 7 | [batch-7.md#experimental-features](batch-7.md#experimental-features) |
| external-stubs | 7 | 5/5 | 完整 | 一致 | N/A | 部分充分（有测试） | 7 | [batch-7.md#external-stubs](batch-7.md#external-stubs) |
| hooks-system | 7 | 4/4 | 完整 | 一致 | N/A | 部分充分（有测试） | 2 | [batch-7.md#hooks-system](batch-7.md#hooks-system) |
| magic-docs | 7 | 4/4 | 完整 | 一致 | N/A | 部分充分（无测试） | 4 | [batch-7.md#magic-docs](batch-7.md#magic-docs) |
| messaging-primitives | 7 | 11/11 | 完整 | 一致 | N/A | 部分充分（有测试） | 3 | [batch-7.md#messaging-primitives](batch-7.md#messaging-primitives) |
| native-installer | 7 | 7/7 | 完整 | 一致 | N/A | 部分充分（无测试） | 4 | [batch-7.md#native-installer](batch-7.md#native-installer) |
| network-security | 7 | 7/7 | 完整 | 一致 | N/A | 部分充分（有测试） | 6 | [batch-7.md#network-security](batch-7.md#network-security) |
| runtime-lifecycle | 7 | 11/11 | 完整 | 一致 | N/A | 部分充分（无测试） | 6 | [batch-7.md#runtime-lifecycle](batch-7.md#runtime-lifecycle) |
| telemetry | 7 | 1/1 | 完整 | 一致 | N/A | 部分充分（无测试） | 4 | [batch-7.md#telemetry](batch-7.md#telemetry) |
| test-validation | 7 | 11/11 | 完整 | 一致 | N/A | 部分充分（有测试） | 6 | [batch-7.md#test-validation](batch-7.md#test-validation) |
| web-tools | 7 | 9/9 | 完整 | 一致 | N/A | 部分充分（有测试） | 5 | [batch-7.md#web-tools](batch-7.md#web-tools) |

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
| P0 | 0 |
| P1 | 0 |
| P2 | 3 |
| P3 | 2 |

### 发现分类

| 类别 | 数量 |
|------|------|
| 测试缺口 | 4 |
| 证据不足 | 1 |

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
| P1 | 1 |
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
| Batch 1 | 5 |
| Batch 2 | 41 |
| Batch 3 | 26 |
| Batch 4 | 17 |
| Batch 5 | 35 |
| Batch 6 | 31 |
| Batch 7 | 66 |
| 跨域 | 9 |
| **总计** | **235** |

### 按严重度分类

| 严重度 | 数量 |
|--------|------|
| P0 | 0 |
| P1 | 2 |
| P2 | 97 |
| P3 | 136 |
| **总计** | **235** |

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
| B3-auth-01 | auth | Keychain 缓存 30 秒，跨进程刷新后另一个进程最多 30 秒才看到新 token | `src/utils/secureStorage/macOsKeychainHelpers.ts:69-91` | None | 每次读取 tokens 时检查磁盘 mtime 或 Keychain 自身修改时间，变更则立即清缓存 | [batch-3.md](batch-3.md) |
| B7-test-validation-06 | test-validation | `scripts/live-model-validation.ts` 在 `enableConfigs()` 前检查凭据，standalone 脚本的 settings 初始化契约需要明确，凭据互斥检查需要集中处理 | `scripts/live-model-validation.ts:40-48` | None | 明确 standalone 脚本的 settings 初始化契约，集中处理凭据互斥检查 | [batch-7.md](batch-7.md) |

---

## 完整整改优先级

### P1 问题（2 项）

1. **B3-auth-01**：（主责：auth）
   - 描述：Keychain 缓存 30 秒，跨进程刷新后另一个进程最多 30 秒才看到新 token
   - 证据：`src/utils/secureStorage/macOsKeychainHelpers.ts:69-91`
   - 依赖：None
   - 验收：每次读取 tokens 时检查磁盘 mtime 或 Keychain 自身修改时间，变更则立即清缓存
   - 来源：[batch-3.md](batch-3.md)

2. **B7-test-validation-06**：（主责：test-validation）
   - 描述：`scripts/live-model-validation.ts` 在 `enableConfigs()` 前检查凭据，standalone 脚本的 settings 初始化契约需要明确，凭据互斥检查需要集中处理
   - 证据：`scripts/live-model-validation.ts:40-48`
   - 依赖：None
   - 验收：明确 standalone 脚本的 settings 初始化契约，集中处理凭据互斥检查
   - 来源：[batch-7.md](batch-7.md)

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

## 验证与测试结果

#### `bun scripts/check-design-docs.ts`
✅ Passed - 0 errors, 73 warnings (expected - 69 DRAFT_SPEC + 4 UNCOVERED_FILE)

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
| batch 1 | ✅ 已完成 | Context 审查，5 项发现 |
| batch 2 | ✅ 已完成 | 工具与会话审查，41 项发现 |
| batch 3 | ✅ 已完成 | Memory 审查，26 项发现（含 1 P1） |
| batch 4 | ✅ 已完成 | UI 子系统审查，17 项发现 |
| batch 5 | ✅ 已完成 | Agent 子系统审查，35 项发现 |
| batch 6 | ✅ 已完成 | 远程连接审查，31 项发现 |
| batch 7 | ✅ 已完成 | 工程模块审查，66 项发现（含 1 P1） |
| cross-subsystem | ✅ 已完成 | 横向契约审查，9 项发现 |

**总体状态**：✅ **审计完成** - 所有 69 个子系统已覆盖（含新增 webbrowser-bundled-support），发现已登记，无 P0 问题，2 项 P1 问题待修复。完整报告请参考各 batch 文件及 [cross-subsystem.md](cross-subsystem.md)。
