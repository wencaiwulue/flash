---
commit: e2e0ff6e0897141823d361204e81aef79922f33b
title: "Make feature profile test CI-independent"
date: 2026-11-10T19:33:02+08:00
status: implemented
kind: component
---

# Make feature profile test CI-independent

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 enabledFeatures 测试已经在独立 Bun 子进程中构建并加载真实外部特性包，且用占位 ANTHROPIC_API_KEY 和 NODE_ENV=production 避免凭据依赖及测试专用工具。但是子进程仍继承任意的 ANTHROPIC_BASE_URL 与 ENABLE_TOOL_SEARCH：ENABLE_TOOL_SEARCH=false/auto:100 或实验 beta kill switch 可强制 standard；在该变量未设置或为空且 ANTHROPIC_BASE_URL 指向非第一方代理时，代理保护也会排除 ToolSearchTool，画像因而可能预期 31 个工具。第一方端点下未显式配置仍默认 tst。fixture 的构建、特性列表和 FEATURE_PROFILE 输出协议均已存在，本提交不重写这些机制。

同一个外部构建测试需要在本机与 CI 的不同环境 overlay 下得到一致的工具注册结果。提交通过固定第一方端点和显式 tool-search 配置，使既有条件工具稳定进入画像，并把总数及必要成员更新为 32 与 ToolSearch。它解决的是这项测试的两个环境敏感输入，不证明所有继承变量都已隔离，也不把注册断言扩展成真实搜索或网络请求验证。

## 目标与非目标

### 目标

- 在 feature-profile 子进程中覆盖继承的 ANTHROPIC_BASE_URL，固定使用 https://api.anthropic.com。
- 显式设置 ENABLE_TOOL_SEARCH=true，使乐观门控在测试构建中选择 ToolSearchTool。
- 把编译画像的期望更新为 32 个非空工具，并要求工具名子集包含 ToolSearch。
- 同步 STATUS 与 RELEASE 中既有的工具池及画像数量记录。

### 非目标

- 不修改生产端点默认值、tool-search 默认模式、代理保护或实验 beta 开关。
- 不实现 ToolSearchTool，也不调用其搜索、select 或 tool_reference 行为。
- 不访问 Anthropic API，不验证占位 key、真实凭据、OAuth 或 provider/proxy 兼容性。
- 不建立最小环境白名单；...process.env 及其余工具池变量仍然保留。
- 不重新实现 proactive、Sleep 或 Coordinator worker，只复用上一提交加入画像的字段。

## 方案架构与数据流

测试架构保持两级进程：外层 Bun test 用 Bun.spawn 执行 verify-enabled-features.ts，后者以 Bun.build 构造外部特性包，再动态 import 产物并输出 FEATURE_PROFILE JSON。 NODE_ENV=production 继续排除 TestingPermissionTool，占位 key 继续满足离线加载前提；新增的两个变量只是这一既有 env overlay 的覆盖项，而非 fixture 编译定义或生产配置。

ToolSearch 的计数变化来自既有门控链。ENABLE_TOOL_SEARCH=true 经 getToolSearchMode 选择 tst，并使 isToolSearchEnabledOptimistic 跳过“未显式配置时的代理保护”；固定 https://api.anthropic.com 则由 isFirstPartyAnthropicBaseUrl 识别为第一方主机。getAllBaseTools 因而在条件插槽加入 ToolSearchTool，工具数由 31 变为 32。CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 的高优先级 standard 强制路径没有被本提交改写。

画像协议仍只输出注册表和少量状态字段。断言将 toolCount 固定为 32、nullCount 固定为 0，并在 arrayContaining 的必要子集中加入 ToolSearch；没有新增 expect 或测试用例，所以文档维持 77 tests、329 assertions。STATUS 的 Built-in tool pool 行与 RELEASE 的 Proactive state and Coordinator workers 验证句只同步这一总数， RELEASE 没有新增独立发布小节。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `tests/enabledFeatures.test.ts`，符号 `ENABLE_TOOL_SEARCH` | 固定两个环境输入，并把真实 bundle 画像更新为 32 个非空工具和 ToolSearch 必要成员。 |
| 变更 | `docs/STATUS.md`，符号 `Built-in tool pool` | 将 Built-in tool pool 的外部画像数量从 31 同步为 32。 |
| 变更 | `docs/RELEASE.md`，符号 `## Proactive state and Coordinator workers` | 在既有 proactive/coordinator 发布验证句中同步 32-tool 数量，不新增功能发布范围。 |
| 复用 | `tests/fixtures/verify-enabled-features.ts`，符号 `FEATURE_PROFILE=` | 复用独立 Bun.build、外部 USER_TYPE 编译定义、bundle import 和画像 JSON 输出。 |
| 复用 | `tests/fixtures/feature-check.ts`，符号 `getAllBaseTools` | 复用真实 registry、proactive 状态和 coordinator 定义的导出入口。 |
| 复用 | `src/tools.ts`，符号 `ToolSearchTool` | 复用既有乐观门控条件插槽，本提交没有修改生产工具池。 |
| 复用 | `src/utils/toolSearch.ts`，符号 `isToolSearchEnabledOptimistic` | 复用模式解析、实验 beta kill switch 与代理启发式来解释测试环境效果。 |
| 复用 | `src/utils/model/providers.ts`，符号 `isFirstPartyAnthropicBaseUrl` | 复用第一方 base URL 主机判断，固定端点与该逻辑相匹配。 |
| 复用 | `src/tools/ToolSearchTool/ToolSearchTool.ts`，符号 `ToolSearchTool` | 复用完整既有工具实现；画像测试只观察注册，不调用搜索。 |

## 关键决策与工程取舍

- 在现有子进程 env 中定点覆盖两个变量，而不是替换完整环境；改动小且直接对应可观察的 31/32 差异，但仍接受其他 ambient 变量影响画像的残余风险。
- 选择官方第一方 URL 作为测试常量，以匹配现有 provider 判断；该常量不是 mock server，也不意味着测试会建立网络连接。
- 同时断言总数和 ToolSearch 成员，避免只靠数量掩盖目标工具缺失；但没有把 32 个名称改成完整有序快照，以保留既有画像测试形态。
- 只更新历史验证文档的数量，不把 ToolSearch 注册解释为模型支持、搜索质量或真实 API 可用性。

### 备选方案与回溯分析

- 回溯性比较：可以用最小 env allowlist 获得更强 hermetic 性，但那会扩大本提交对子进程加载条件的调整面；实际方案保留 ...process.env，仅固定已识别的端点和开关，残余变量仍需后续硬化。
- 回溯性比较：可以在生产代码中默认开启 ToolSearch 来稳定数量，却会改变用户及代理环境行为；实际只改测试进程，生产门控保持原样。
- 回溯性比较：可以删除 tool-search 条件或 mock getAllBaseTools 来避免环境敏感，但那会削弱真实 bundle 注册验证；实际继续构建并加载真实 registry。

## 安全与协议边界

- ANTHROPIC_API_KEY 使用明确占位文本，测试不需要有效密钥；fixture 没有模型查询步骤。
- 固定 URL 是真实官方端点而非禁网地址，当前无网络调用不代表未来增加调用时会自动被沙箱阻止。
- 子进程仍继承其他环境变量，潜在认证材料没有被逐一清除；因此安全结论是无需有效 Anthropic key，而不是完全无凭据环境。
- fixture 继续把 USER_TYPE 编译为 external，没有引入内部用户构建或额外权限。

## 验收标准

- 子进程环境显式包含固定 ANTHROPIC_BASE_URL、ENABLE_TOOL_SEARCH=true、占位 key 和 production 模式。
- 真实外部 bundle 加载后报告 32 个工具、0 个 null，且必要工具子集包含 ToolSearch。
- 测试不要求有效 API 凭据，不发起模型或 ToolSearch 调用。
- STATUS 与 RELEASE 的相关数量均为 32，原 77/329 测试与断言总数不被虚增。

## 实现状态与剩余范围

- 状态：**implemented**
- CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 仍可从父环境强制 standard，其他工具池变量也仍可改变画像，完全确定性尚未建立。
- 总数加必要子集不能发现所有同名数量替换或完整工具组成错误，也没有在该画像测试中断言名称唯一性。
- ToolSearch 的真实搜索行为、模型支持及不同 provider/proxy 的兼容性仍需独立测试。
