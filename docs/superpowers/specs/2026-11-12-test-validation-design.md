---
id: test-validation
batch: 7
title: Test Validation 测试运行、Live 验证与证据边界设计
date: 2026-11-12
status: draft
---

# Test Validation 测试运行、Live 验证与证据边界设计

## 1. 问题与约束

项目使用 Bun test 作为测试框架，需要同时支持：
- 快速离线单元/集成测试
- 需要真实凭据的 live 验证
- 构建产物验收测试
- 跨领域功能验证

当前存在以下需要统一设计的问题：
- 测试运行器逐文件隔离的机制与原因
- Live 验证的分类、凭据边界与失败语义
- 如何避免已归其他 spec 的测试重复覆盖
- Smoke 测试在 CI 中的位置与范围
- 失败汇总与报告方式

本设计描述从测试触发到结果输出的完整流程，以及各类验证的边界与决策。

## 2. 设计理由与备选方案

### 逐文件隔离运行测试

`scripts/test.ts` 为每个测试文件单独 spawn 一个 Bun 子进程，而不是一次性运行所有测试。这种设计：
- 避免测试间状态污染（全局变量、环境变量、文件系统）
- 每个测试可以独立配置 feature flags 或环境
- 失败可以精确到文件，便于并行化和重跑
- 与 Bun test 的默认行为一致，但显式控制注入 feature flags

代价是启动开销稍大，但相对于集成测试的隔离需求是可接受的。

**备选方案**：单进程运行所有测试 → 不采用，测试间状态污染风险高。

### Live 验证按领域分离而非统一套件

当前 live 验证分为四个独立脚本：
- `live-cloud-validation.ts`：需要 Claude AI OAuth token、组织 UUID
- `live-desktop-validation.ts`：需要 `CLAUDE_DESKTOP_LIVE=1`、桌面权限
- `live-model-validation.ts`：需要 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`（互斥）
- `live-skillhub-validation.ts`：需要 `CLAUDE_SKILL_REGISTRY_URL`、可选 token

按领域分离可以：
- 每个脚本明确声明自己需要的凭据和环境
- 跳过不满足条件的验证而不失败整个流程
- 独立超时和重试策略
- 不需要统一的大套件配置

**备选方案**：统一 live 验证套件 → 不采用，凭据和环境配置复杂，部分失败易导致整体跳过。

### Live 验证在 CI 中是可选的

Live 验证依赖外部服务、网络和凭据，CI 环境不一定能满足这些条件。因此：
- 本地开发时可以选择性运行
- CI 中通过环境变量控制是否启用
- 离线测试仍然是主要的质量门禁

**备选方案**：CI 强制要求 live 验证 → 不采用，外部依赖不可控，易导致 flaky。

### Smoke 测试单独存在而非集成到主测试

`buildArtifacts.test.ts` 只验证最基本的交付内容（CLI 可执行、SDK 可导入、类型声明存在），不运行完整功能测试。这是为了：
- 在快速构建流程中尽早发现打包问题
- 不依赖测试数据库或外部服务
- 可以在每次提交时运行而不影响速度

**备选方案**：把所有测试都放在 smoke 阶段 → 不采用，失去分层验证的价值。

### 跨领域测试集中验收

跨领域测试（功能配置、公共命令）不归属单个领域 spec，而是在中央位置验收。这样：
- 避免每个 spec 重复验证同一组工具/命令
- 确保整体一致性（例如工具数量、命令可用性）
- 变更影响可以在一个地方看到

**备选方案**：每个 spec 重复覆盖跨领域测试 → 不采用，维护成本高，容易 drift。

## 3. 目标与非目标

### 目标

- 明确测试运行器的隔离机制与 feature 注入
- 分类 live 验证并划定各自的凭据边界
- 定义 CI smoke 测试的范围与位置
- 建立失败汇总与报告方式
- 记录至少 5 个设计决策及其权衡
- 不重复已归其他 spec 的测试覆盖

### 非目标

- 不替换 Bun test 作为测试框架
- 不设计新的断言库或 mocking 框架
- 不强制要求所有功能都有 live 验证
- 不处理测试并行化调度（当前是串行）

## 4. 架构、模块与数据流

测试与验证分为三层：

```
┌─────────────────────────────────────────────────────────┐
│                         Live 验证层                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ Cloud 验证   │ │ Desktop 验证 │ │ Model/Workflow   │ │
│  │ (OAuth)      │ │ (屏幕权限)   │ │ (API Key)        │ │
│  └──────────────┘ └──────────────┘ └──────────────────┘ │
│  ┌──────────────────┐                                     │
│  │ SkillHub 验证    │                                     │
│  │ (Registry URL)   │                                     │
│  └──────────────────┘                                     │
└─────────────────────────────────────────────────────────┘
                              ↑ 可选
┌─────────────────────────────────────────────────────────┐
│                        跨领域验收层                             │
│  ┌──────────────────┐ ┌──────────────────┐               │
│  │ Enabled Features │ │ Public Commands  │               │
│  │ (离线 bundle)    │ │ (/summary 等)    │               │
│  └──────────────────┘ └──────────────────┘               │
└─────────────────────────────────────────────────────────┘
                              ↑ 必需
┌─────────────────────────────────────────────────────────┐
│                        Smoke 测试层                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │  CLI 可执行、SDK 可导入、类型声明存在              │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                              ↑ 必需
┌─────────────────────────────────────────────────────────┐
│                        测试运行器                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │ scripts/test.ts: 逐文件 spawn，注入 EXTERNAL_FEATURES │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

测试触发流程：
```
开发触发 / CI 触发
      ↓
scripts/test.ts [特定文件]
      ↓
遍历测试文件
      ↓
每个文件 spawn Bun test 子进程
      ↓
(注入 --feature=EXTERNAL_FEATURES...)
      ↓
收集失败文件列表
      ↓
汇总报告，非零退出
```

### 核心模块

- **测试运行器** (`scripts/test.ts`)：逐文件隔离运行测试，注入 feature flags
- **Live 验证脚本** (`scripts/live-*-validation.ts`)：按领域分离的真实服务验证
- **Smoke 测试** (`tests/buildArtifacts.test.ts`)：构建产物基本完整性验证
- **跨领域验收测试** (`tests/enabledFeatures.test.ts`, `tests/publicPromptCommands.test.ts`)：功能配置与公共命令集中验收

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 |
|---|---|
| 单个测试文件失败 | 记录失败，继续运行其他文件，最终汇总报告 |
| 测试发现失败但进程零退出 | 不视为失败（由 Bun test 保证） |
| Live 验证条件不满足 | 打印 `*_LIVE_SKIPPED`，不失败 |
| Live 验证条件满足但验证失败 | 抛出错误，非零退出 |
| Smoke 测试失败 | 立即失败，尽早反馈构建问题 |
| 跨领域验收失败 | 失败，表明整体一致性问题 |
| Feature 注入缺失 | 由 enabledFeatures 测试捕获（工具数量/注册异常） |
| 凭据互斥（API Key + Auth Token） | live-model-validation 立即失败 |

### 工程取舍

- **逐文件隔离 vs 启动开销**：选择隔离，避免状态污染的价值大于启动开销
- **Live 验证可选 vs 完整覆盖**：选择可选，外部依赖不可控，离线测试为主要门禁
- **Smoke 测试最小化 vs 完整验证**：选择最小化，快速反馈打包问题
- **跨领域集中验收 vs 分散重复**：选择集中，避免重复维护

## 6. 现状验收标准

### 测试运行器

- `scripts/test.ts` 必须为每个测试文件单独 spawn 子进程
- 必须注入所有 `EXTERNAL_FEATURES`
- 必须收集失败文件并汇总报告
- 有失败时必须非零退出

### Live 验证

- Cloud 验证：无 OAuth token 时打印 `CLOUD_LIVE_SKIPPED`，有 token 失败时抛出错误
- Desktop 验证：无 `CLAUDE_DESKTOP_LIVE=1` 时打印 `DESKTOP_LIVE_SKIPPED`
- Model 验证：同时设置 API Key 和 Auth Token 时立即失败
- SkillHub 验证：始终尝试，网络失败视为验证失败

### Smoke 测试

- 必须验证 `dist/main.js` 存在且可执行
- 必须验证 `dist/sdk.mjs` 存在
- 必须验证 `dist/types/entrypoints/agentSdkTypes.d.ts` 存在
- 必须验证 SDK 可以被导入
- 必须验证 `package.json` 的 exports 配置正确

### 跨领域验收

- `enabledFeatures.test.ts` 必须验证工具数量、注册状态、外层环境不影响 profile
- `publicPromptCommands.test.ts` 必须验证 `/summary` 和 `/autofix-pr` 命令

## 7. 代码与测试证据

### 现有测试

- `tests/buildArtifacts.test.ts`：Smoke 测试验证
- `tests/enabledFeatures.test.ts`：Enabled Features 验收测试
- `tests/publicPromptCommands.test.ts`：Public Prompt Commands 验收测试
- `tests/daemon.test.ts`：守护进程相关测试
- `tests/backgroundSessions.test.ts`：后台会话相关测试

### 实现证据

- `scripts/test.ts`：逐文件 spawn 实现，feature 注入逻辑
- `scripts/live-cloud-validation.ts`：Cloud 验证实现
- `scripts/live-desktop-validation.ts`：Desktop 验证实现
- `scripts/live-model-validation.ts`：Model 验证实现
- `scripts/live-skillhub-validation.ts`：SkillHub 验证实现
- `tests/fixtures/verify-enabled-features.ts`：验收 fixture 构建

### 未覆盖场景

- 测试并行化调度（当前串行）
- Live 验证网络请求重试机制
- JUnit XML 或其他结构化报告格式

## 8. 文件覆盖与相关子系统

本设计的覆盖率文件位于 [Coverage](../../architecture/coverage/test-validation.yaml)。

### 相关文件

- `scripts/test.ts`：测试运行器实现
- `scripts/live-cloud-validation.ts`：Cloud 验证
- `scripts/live-desktop-validation.ts`：Desktop 验证
- `scripts/live-model-validation.ts`：Model 验证
- `scripts/live-skillhub-validation.ts`：SkillHub 验证
- `scripts/externalFeatureProfile.ts`：外部功能列表
- `tests/buildArtifacts.test.ts`：Smoke 测试
- `tests/enabledFeatures.test.ts`：Enabled Features 验收
- `tests/publicPromptCommands.test.ts`：Public Prompt Commands 验收
- `tests/fixtures/`：测试 fixtures 目录

### 相关子系统

- Build & External Feature Profile：外部功能列表定义
- SDK Query Sessions：SDK 查询会话设计
- Daemon & Background：守护进程与后台会话设计

## 9. 改进建议

1. **测试并行化**：当前 `scripts/test.ts` 是串行运行每个文件，未来可以考虑并行化以加快速度，但需要注意资源竞争（例如临时目录、端口）。

2. **Live 验证的重试策略**：当前 live 验证没有重试，网络抖动可能导致 flaky。建议为网络请求添加指数退避重试机制。

3. **测试结果聚合**：当前只有简单的失败文件列表，没有 JUnit XML 或其他结构化报告，不利于 CI 可视化。建议添加 JUnit XML 输出格式支持。

4. **Fixtures 的维护**：`tests/fixtures/` 下的文件与实际源码的同步需要注意，特别是 `verify-enabled-features.ts` 中的构建配置需要与 `scripts/build.ts` 保持一致。建议添加集成测试验证 fixture 与构建配置一致性。

5. **跨领域测试的 spec 边界**：部分测试可能同时涉及多个领域（例如 proactive 与 sleep 工具），需要明确哪个 spec 负责覆盖，避免重复或遗漏。建议在各 spec 中明确标注边界。
