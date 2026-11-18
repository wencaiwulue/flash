---
id: upstream-config-task-2-multi-baseline
batch: 3
title: Task 2：多基线迁移与完整性门禁设计
date: 2026-11-18
status: approved
---

# Task 2：多基线迁移与完整性门禁设计

本文实现总路线的 Task 2：多基线基础设施、非破坏性矩阵迁移、按批次（B1-B5）的完整性检查、以及最终严格验收模式。

## 1. 问题与约束

### 1.1 要修复的审查问题

根据 2026-11-18 审查，当前实现存在以下问题：

1. **缺少 spec 和迁移脚本**：报告声称存在 `2026-11-18-upstream-config-task-2-multi-baseline.md` 和 `scripts/migrate-matrix-v2.ts`，但二者均未提交。
2. **ownerBatch 按 kind 分配（setting=3/hook=4/env=5）不符合路线**：应按 B1-B5/最终（final）的语义确定归属，而非按配置类型。
3. **缺少 ignored-by-design 状态和证据验证**：仅 `lifecycle=removed` 可直接排除；deprecated 或 active 需要 `ignored-by-design` 理由和证据。
4. **迁移未保留现有 owner/spec/verifiedVersion**：当前实现将不变条目设为 undefined，应保留并记录当前基线审核元数据。
5. **消失条目被当作 excluded**：矩阵与清单 ID 必须精确对应，消失条目应报告复核，不应自动标记为 excluded。
6. **最终模式测试只是 `expect(true).toBe(true)`**：需要真实行为测试证明：当前矩阵在最终模式下失败；完全 aligned/允许 excluded 的合成矩阵通过。
7. **CLI 模式/基线/批次选择未验证**：需要证明 `--mode`、`--baseline`、批次选择工作正常；迁移拒绝覆盖。
8. **迁移差异缺少语义变化**：需要证明类型/默认值/scope/precedence/lifecycle 变化正确触发降级；输出确定排序，不包含时间戳（除非注入）。
9. **fixtures/token-count-*.json 被破坏风险**：测试不能修改无关 fixtures。
10. **报告与提交不一致**：最终报告必须与实际提交文件和测试结果一致，附带 RED/GREEN 证据。

### 1.2 现有代码状态

- `scripts/upstreamConfigInventory.ts`：已有 `getBaselinePointer()`、`loadInventoryForVersion()`、`diffInventories()` 基本框架，但缺少完整测试和规范整合。
- `scripts/checkUpstreamConfigCompatibility.ts`：已有 `CheckMode`、`MatrixEntryV2`、`checkCompatibilityV2()`、`migrateMatrix()`、`--mode/--baseline` CLI，但需要根据审查修复。
- `fixtures/upstream-config/2.1.311/`：已有 inventory.json 和 compatibility.yaml，但 ownerBatch 全部是 3（错误）。
- `fixtures/upstream-config/baseline.json`：已有，指向 2.1.311。
- `fixtures/upstream-config/env-consumers.json`：已有，空对象。

### 1.3 约束

1. 保持现有公共 `checkCompatibility()` 接口不变，供 B0 调用者继续使用。
2. B0 的 2.1.311 基线必须保持可通过漂移模式（drift）检查。
3. spec 必须登记到 `docs/architecture/coverage/manifest.yaml`，并附带独立 coverage YAML，不与 B0 重复拥有文件。
4. 必须有 `ignored-by-design` 状态枚举和验证，且必须有证据。
5. deprecated 不得仅因生命周期而排除；removed/no-op 需要上游证据。
6. 批次模式必须支持只检查 B1/B2/B3/B4/B5，不强制后续批次完成；最终模式检查全部。
7. 迁移必须是确定性的，没有时间戳（除非明确注入用于审计），且排序稳定。
8. 不添加 `--force` 覆盖选项；必须显式拒绝覆盖现有矩阵。

## 2. 设计理由与备选方案

| 决策 | 机制 | 理由 | 不采用的方案 | 证据 |
|---|---|---|---|---|
| 新增 spec 而非复用 B0 | 独立 `upstream-config-task-2-multi-baseline` spec 和 coverage，拥有新脚本/测试；B0 保留兼容性矩阵和检查 | 职责分离；避免 B0 与多基线功能重复声明 | 仅更新 B0 spec：审查要求明确登记新 spec | 审查问题 1；现有 manifest.yaml 结构 |
| ownerBatch 按 B1-B5 语义，确定性函数 | `determineOwnerBatch(id, inventoryEntry)` 函数，按路线章节 4.5 分类 | 与路线批次定义一致；可审计；可测试 | 继续 kind=3/4/5：违反审查问题 2；人工随机分配：不可复现 | 路线 4.5 节 B1-B5 定义；审查问题 2 |
| `ignored-by-design` 作为 status 或 exclusion.reason？ | 作为 `exclusion.reason` 包含 `ignored-by-design`，并在最终模式验证证据；matrix 保持兼容状态枚举 | 不破坏向后兼容；exclusion 已有 reason/evidence 结构 | 新增状态枚举：需要修改 B0 checkCompatibility 太多 | 审查问题 3；现有矩阵结构 |
| 迁移保留不变条目 | `migrateMatrix()` 保留 `ownerBatch`/`spec`/`verifiedVersion`/`currentReview`，仅当上游变化时降级 aligned→partial；记录 `currentReview={by:current-baseline,at:deterministic,baseline:fromVersion}` | 保护已有人工工作；明确审核历史；无变化条目无需重新验证 | 清空所有字段：破坏现有进度 | 审查问题 4 |
| 消失条目报告而非排除 | `checkCompatibilityV2()` 检查 `matrix ID ⊆ inventory ID`，报告 `stale-matrix-entry`；`migrateMatrix()` 不添加消失条目为 excluded，而是在输出差异中明确列出消失项供人工复核 | 矩阵与清单 ID 必须精确对应；消失可能是文档重构而非真正移除 | 自动转 excluded：可能丢失应实现的条目 | 审查问题 5；路线要求矩阵与清单一一对应 |
| 合成测试矩阵验证最终模式 | 测试创建小型合成 inventory 和完全 aligned + 正确 excluded 的矩阵，验证通过；同样矩阵若缺少 owner/spec/verifiedVersion 则失败 | 真实证明最终模式工作；不依赖真实 B1-B5 完成即可测试门禁 | 仅 `expect(true).toBe(true)`：无意义 | 审查问题 6；现有测试框架 |
| CLI 选项完整测试 | 测试 `--mode drift/batch/final`、`--baseline`、批次选择通过/拒绝的场景；测试 `--initialize-matrix` 拒绝覆盖 | 证明 CLI 行为符合要求 | 不测 CLI：仅测库函数 | 审查问题 7；现有 CLI 框架 |
| 迁移输出确定顺序，无时间戳 | entries 按 kind 然后 id 稳定排序；`migratedAt` 仅在明确传入时设置（用于审计），否则不设置；差异输出按确定分组排序 | 可复现测试；Git diff 干净；避免虚假变化 | 每次时间戳不同：Git 噪声 | 审查问题 8；现有 diffInventories 框架 |
| 测试不修改 fixtures | 所有测试使用临时目录；测试 token-count-*.json 不在 upstream-config 下，不会触碰 | 保护用户令牌计数缓存；避免无关提交 | 直接修改 fixtures：危险 | 审查问题 9；现有测试实践 |
| 报告附加真实命令输出 | 最终提交后记录：定向测试、typecheck、check-design-docs、漂移模式（通过）、最终模式（预期失败）、完整 test/build 的实际输出，附带 RED/GREEN 标签 | 报告与实际一致；可审计 | 仅文字声称：不可验证 | 审查问题 10；任务要求 |

## 3. 目标与非目标

### 3.1 目标

1. 提交真实 spec（本文）并登记到 manifest.yaml，附带独立 coverage YAML。
2. 实现确定性 `determineOwnerBatch()` 函数，按 B1-B5 语义分类，附带完整测试。
3. 实现 `ignored-by-design` 证据验证，区分 deprecated/removed/no-op 场景。
4. 修复 `migrateMatrix()` 保留不变条目，正确降级变化条目，不自动排除消失条目。
5. 替换占位 `expect(true).toBe(true)` 为真实合成矩阵测试，证明最终模式门禁工作。
6. 验证 CLI `--mode`、`--baseline`、批次选择行为正确；`--initialize-matrix` 拒绝覆盖。
7. 确保迁移输出确定排序，无时间戳（除非显式注入）。
8. 确保测试不破坏 `fixtures/token-count-*.json`。
9. 更新报告，包含真实命令输出和 RED/GREEN 证据。

### 3.2 非目标

1. 不实现 B1-B5 的任何实际配置对齐；仅提供基础设施。
2. 不修改 B0 的 `checkCompatibility()` 公共接口；仅扩展 `checkCompatibilityV2()`。
3. 不修改 B0 的 fixtures/2.1.311/compatibility.yaml 的 status/implementation/tests/evidence/dimensions/notes/exclusion（除非修复 ownerBatch）。
4. 不创建 `--force` 覆盖选项。
5. 不添加新的基线版本；仅使用现有 2.1.311 演示基础设施。

## 4. 架构、模块与数据流

### 4.1 基线指针与文件结构

保持现有结构不变，但明确定义语义：

```text
fixtures/upstream-config/
  baseline.json          # {schemaVersion:1,active:"2.1.311",available:["2.1.311"]}
  env-consumers.json     # {schemaVersion:1,consumers:{}} - 环境变量显式消费者注册表
  2.1.311/
    inventory.json       # B0 上游清单
    compatibility.yaml   # B0 矩阵，带有 ownerBatch/spec/verifiedVersion/currentReview
```

### 4.2 OwnerBatch 确定性分配

实现 `determineOwnerBatch(id, inventoryEntry)` 函数，按路线 4.5 节：

```typescript
export function determineOwnerBatch(
  id: string,
  entry?: { lifecycle?: 'active' | 'deprecated' | 'removed', kind?: 'setting' | 'hook' | 'env' }
): 1 | 2 | 3 | 4 | 5 {
  // B1: Hooks 与当前环境变量
  if (id.startsWith('hook:')) return 1
  // 环境变量按语义划分：B1（进程/subagent）、B4（MCP/认证/远程）、B5（Artifact/mods/反馈）
  if (id.startsWith('env:')) {
    const envName = id.slice('env:'.length)
    if (envName.includes('SUBAGENT') || envName.includes('SESSION') ||
        envName.includes('DEBUG') || envName.includes('LOG') || envName.includes('VERBOSE') ||
        envName.includes('TERM') || envName.includes('NO_PROGRESS') || envName.includes('NO_COLOR')) {
      return 1
    }
    if (envName.includes('MCP') || envName.includes('PLUGIN') || envName.includes('SKILL') ||
        envName.includes('AUTH') || envName.includes('OAUTH') || envName.includes('GITHUB') ||
        envName.includes('GITLAB') || envName.includes('BRIDGE') || envName.includes('REMOTE') ||
        envName.includes('CROSS_SESSION') || envName.includes('GATEWAY')) {
      return 4
    }
    if (envName.includes('ARTIFACT') || envName.includes('SYNC') || envName.includes('MOD') ||
        envName.includes('FEEDBACK') || envName.includes('AUTO_CONTINUE')) {
      return 5
    }
    // 剩余环境变量默认 B1
    return 1
  }

  // B1: setting 前缀匹配（subagent/进程相关）
  if (id.startsWith('setting:subagent') ||
      id.startsWith('setting:background') ||
      id.startsWith('setting:daemon')) {
    return 1
  }

  // B2: 本地核心与 UI
  if (id.startsWith('setting:model') ||
      id.startsWith('setting:thinking') ||
      id.startsWith('setting:compact') ||
      id.startsWith('setting:output') ||
      id.startsWith('setting:status') ||
      id.startsWith('setting:terminal') ||
      id.startsWith('setting:theme') ||
      id.startsWith('setting:editor') ||
      id.startsWith('setting:ui') ||
      id.startsWith('setting:show') ||
      id.startsWith('setting:verbose') ||
      id.startsWith('setting:auto') ||
      id.startsWith('setting:fileCheckpointing') ||
      id.startsWith('setting:teammate') ||
      id.startsWith('setting:preferred')) {
    return 2
  }

  // B3: 安全与文件系统（permissions/attribution/worktree/sandbox）
  if (id.startsWith('setting:permissions') ||
      id.startsWith('setting:attribution') ||
      id.startsWith('setting:worktree') ||
      id.startsWith('setting:sandbox') ||
      id.startsWith('setting:allowManagedHooksOnly')) {
    return 3
  }

  // B4: 集成与托管（MCP/插件/认证/remote/跨会话）
  if (id.startsWith('setting:mcp') ||
      id.startsWith('setting:plugin') ||
      id.startsWith('setting:skill') ||
      id.startsWith('setting:auth') ||
      id.startsWith('setting:oauth') ||
      id.startsWith('setting:github') ||
      id.startsWith('setting:gitlab') ||
      id.startsWith('setting:bridge') ||
      id.startsWith('setting:remote') ||
      id.startsWith('setting:crossSession') ||
      id.startsWith('setting:isolatePeer') ||
      id.startsWith('setting:forceLogin') ||
      id.startsWith('setting:gateway') ||
      id.startsWith('setting:disableClaudeAi') ||
      id.startsWith('setting:allowAllClaudeAi') ||
      id.startsWith('setting:forceRemote')) {
    return 4
  }

  // B5: 完全缺失功能（Artifact/同步/mods/反馈/自动继续）
  if (id.startsWith('setting:artifact') ||
      id.startsWith('setting:sync') ||
      id.startsWith('setting:mod') ||
      id.startsWith('setting:feedback') ||
      id.startsWith('setting:autoContinue') ||
      id.startsWith('setting:dialogExpiry') ||
      id.startsWith('setting:switchModels')) {
    return 5
  }

  // 默认 B3（B0 批次，基础设施）
  return 3
}
```

此函数可完全测试，覆盖代表性条目。

### 4.3 矩阵条目 V2 与迁移

保持现有 `MatrixEntryV2` 结构不变，但明确定义：

```typescript
export type MatrixEntryV2 = CompatibilityMatrixEntry & {
  ownerBatch?: 1 | 2 | 3 | 4 | 5  // B1-B5
  spec?: string  // 拥有 spec 的 id，如 'upstream-config-b0-baseline'
  verifiedVersion?: string  // 已验证基线版本，如 '2.1.311'
  currentReview?: {
    by: string  // 审核者/批次标记，如 'baseline-2.1.311'
    at: string  // 确定性时间戳，仅用于审计，默认不设置
    baseline: string  // 审核时的基线版本
  }
}
```

`migrateMatrix()` 修复为：

1. **不变条目**：保留 `ownerBatch`/`spec`/`verifiedVersion`/`currentReview`；如果 `currentReview` 缺失，添加 `{by:'baseline-2.1.311',baseline:'2.1.311'}`（无 `at` 时间戳以确保确定性）。
2. **变化条目**：若原状态为 `aligned`，降级为 `partial`，清空 `verifiedVersion`，保留其他字段，添加 note 说明上游变化。
3. **新增条目**：按 `determineOwnerBatch()` 分配 ownerBatch，状态根据 `afterBaseline` 设为 `blocked` 或 `missing`，其他为默认值。
4. **消失条目**：**不**自动添加为 excluded；而是在迁移差异输出中明确列出 `removedIds`，返回给调用者供人工复核。
5. **迁移元数据**：`migratedFrom`/`migratedTo` 保留；`migratedAt` 仅在明确传入时设置，否则不设置以确保确定性。
6. **排序**：entries 按 `kindOrder={setting:0,hook:1,env:2}` 然后 `id` 字典序稳定排序。

### 4.4 CheckMode 与完整性验证

三种模式：

| 检查项 | drift | batch | final |
|---|---|---|---|
| 基础矩阵结构 | ✓ | ✓ | ✓ |
| 漂移检测（missing/stale） | ✓ | ✓ | ✓ |
| ownerBatch 存在性 | ✗ | ✓（仅当前批次） | ✓（全部） |
| spec 引用存在性 | ✗ | ✓（仅当前批次） | ✓（全部） |
| 实现/测试路径存在 | ✗ | ✓（仅当前批次） | ✓（全部） |
| 环境变量消费者注册 | ✗ | ✓ | ✓ |
| `ignored-by-design` 证据验证 | ✗ | ✗ | ✓ |
| `excluded` 理由验证（仅 removed/ignored-by-design） | ✗ | ✗ | ✓ |
| deprecated 未被排除（除非 ignored-by-design） | ✗ | ✗ | ✓ |
| `aligned` 六维完整+verifiedVersion+currentReview | ✗ | ✗ | ✓ |
| 总数与六维一致 | ✗ | ✗ | ✓ |

批次选择通过 `--batch B1` 或 `--batch 1` 传入；多个批次可重复传入，如 `--batch 1 --batch 2`。

### 4.5 `ignored-by-design` 验证规则

最终模式强制执行：

1. `status=excluded` 时：
   - 若 `inventoryEntry.lifecycle=removed`：接受，证据必须指向上游移除声明。
   - 否则：`exclusion.reason` 必须包含 `ignored-by-design`，且 `exclusion.evidence` 必须非空（指向 spec/决定）。
   - deprecated 不得仅因生命周期而排除，除非有 `ignored-by-design` 证据。
2. `ignored-by-design` 证据必须说明理由，如：
   - "Desktop-only, CLI ignores per upstream docs"
   - "Removed/no-op in 2.1.311, per binary probe"

### 4.6 CLI 行为

扩展现有 CLI：

```bash
# 漂移模式（默认，向后兼容 B0）
bun scripts/checkUpstreamConfigCompatibility.ts --mode drift

# 批次模式（仅检查 B1）
bun scripts/checkUpstreamConfigCompatibility.ts --mode batch --batch 1

# 最终模式（检查全部，预期当前失败）
bun scripts/checkUpstreamConfigCompatibility.ts --mode final

# 指定基线（默认使用 active）
bun scripts/checkUpstreamConfigCompatibility.ts --baseline 2.1.311

# 初始化矩阵（拒绝覆盖）
bun scripts/checkUpstreamConfigCompatibility.ts --initialize-matrix
# 若 compatibility.yaml 已存在，报错 "refusing to overwrite existing compatibility matrix"
```

## 5. 失败语义与工程取舍

| 触发条件 | 处理方式 | 理由 |
|---|---|---|
| `ownerBatch` 缺失 | 批次/最终模式产生 `invalid-owner-batch` 诊断 | 所有条目必须可归属 |
| `spec` 引用不存在 | 批次/最终模式产生 `invalid-spec` 诊断 | spec 必须登记在 manifest 中 |
| 实现/测试路径不存在 | 批次/最终模式产生 `invalid-implementation-path`/`invalid-test-path` | 引用必须指向真实文件（允许空数组表示未开始） |
| 环境变量无注册消费者 | 批次/最终模式产生 `invalid-env-consumer` | 注入不算完成，必须显式消费者 |
| `ignored-by-design` 无证据 | 最终模式产生 `invalid-exclusion-evidence` | 排除决策必须可审计 |
| deprecated 被排除且无 `ignored-by-design` | 最终模式产生 `invalid-deprecated-effective-excluded` | deprecated 仍有效时不应排除 |
| `aligned` 缺少六维/verifiedVersion/currentReview | 最终模式产生 `invalid-aligned-not-complete`/`invalid-verified-version`/`invalid-current-review` | aligned 必须完整可审计 |
| 矩阵 ID 不在清单中 | 所有模式产生 `stale-matrix-entry` | ID 必须精确对应 |
| 清单 ID 不在矩阵中 | 所有模式产生 `missing-matrix-entry` | ID 必须精确对应 |

工程取舍：

- 保留 `checkCompatibility()` 公共接口不变，B0 调用者无需修改；仅新代码使用 `checkCompatibilityV2()`。
- 批次模式允许空实现/测试数组，表示"未开始"，不产生诊断；仅当路径非空且不存在时才报错。
- `currentReview.at` 时间戳可选，仅当需要审计时注入，避免 Git 噪声。

## 6. 现状验收标准

### 6.1 必须通过的测试

```bash
# 定向测试（必须全部通过）
bun test tests/upstream-config-inventory.test.ts
bun test tests/upstream-config-compatibility.test.ts

# 类型检查（必须通过）
bun run typecheck

# 设计文档检查（必须通过）
bun scripts/check-design-docs.ts

# 漂移模式（必须通过，保持 B0 兼容）
bun scripts/checkUpstreamConfigCompatibility.ts --mode drift

# 最终模式（预期失败，当前矩阵无 aligned 且 ownerBatch 待修复）
bun scripts/checkUpstreamConfigCompatibility.ts --mode final
# 预期：非零退出码

# 完整测试与构建（必须通过）
bun run test
bun run build
```

### 6.2 必须提交的文件

1. 本文 spec：`docs/superpowers/specs/2026-11-18-upstream-config-task-2-multi-baseline-design.md`
2. Coverage：`docs/architecture/coverage/upstream-config-task-2-multi-baseline.yaml`
3. 更新 manifest：`docs/architecture/coverage/manifest.yaml`（新增 spec 登记）
4. 修复脚本：`scripts/upstreamConfigInventory.ts`（新增 `determineOwnerBatch()`）
5. 修复脚本：`scripts/checkUpstreamConfigCompatibility.ts`（修复 `migrateMatrix()`、`checkCompatibilityV2()`、CLI 批次选择）
6. 修复测试：`tests/upstreamConfigInventory.test.ts`（新增 ownerBatch 测试）
7. 修复测试：`tests/upstreamConfigCompatibility.test.ts`（替换占位测试，新增合成矩阵测试）
8. 修复矩阵：`fixtures/upstream-config/2.1.311/compatibility.yaml`（修复 ownerBatch 为 B1-B5 值，其他字段不变）
9. 更新报告：`.superpowers/sdd/task-2-report.md`（附带真实命令输出和 RED/GREEN 证据）

### 6.3 验收条件

1. 所有审查问题（1-10）明确修复，有代码/测试/证据对应。
2. 所有测试通过（除最终模式预期失败）。
3. 提交信息包含 `Co-authored-by: Claude <noreply@anthropic.com>` 和 `Co-authored-by: Kimi <noreply@moonshot.ai>`。
4. report.md 中的声明与实际提交文件完全一致。

## 7. 代码与测试证据

### 7.1 新增/修改文件

| 文件 | 变更类型 | 所有者 |
|---|---|---|
| `docs/superpowers/specs/2026-11-18-upstream-config-task-2-multi-baseline-design.md` | 新增 | 本 spec |
| `docs/architecture/coverage/upstream-config-task-2-multi-baseline.yaml` | 新增 | 本 spec |
| `docs/architecture/coverage/manifest.yaml` | 修改 | 本 spec（仅新增登记） |
| `scripts/upstreamConfigInventory.ts` | 修改 | 本 spec |
| `scripts/checkUpstreamConfigCompatibility.ts` | 修改 | 本 spec |
| `tests/upstreamConfigInventory.test.ts` | 修改 | 本 spec |
| `tests/upstreamConfigCompatibility.test.ts` | 修改 | 本 spec |
| `fixtures/upstream-config/2.1.311/compatibility.yaml` | 修改（仅 ownerBatch） | B0 baseline spec |
| `.superpowers/sdd/task-2-report.md` | 修改 | 本 spec |

### 7.2 不拥有的文件

- B0 的其他 fixtures/脚本/测试仍由 `upstream-config-b0-baseline` spec 拥有，避免重复。

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/upstream-config-task-2-multi-baseline.yaml)

相关 spec：
- `upstream-config-b0-baseline`：B0 基线与矩阵
- `upstream-configuration-alignment`：总路线

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 每次基线升级时重新分配 ownerBatch 可能很麻烦 | ownerBatch 记录在矩阵中并由迁移保留；首次分配后无需重新计算 | 低 | 迁移保留 ownerBatch 测试通过 | S | 已设计 |
| P2 | 环境变量消费者注册表当前为空 | 未来批次实现真实消费者时，更新 env-consumers.json | 低 | 批次模式验证消费者注册 | S | 已设计 |
| P2 | 未来可能需要 `--force` 覆盖 | 目前严格拒绝；未来确有需要时再添加，且必须有确认提示 | 低 | CLI 拒绝覆盖测试通过 | S | 已设计 |
