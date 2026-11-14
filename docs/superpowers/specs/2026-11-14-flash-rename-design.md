---
id: flash-rename
batch: 4
title: 产品更名为 flash：README、提示词与发布产物重命名设计
date: 2026-11-14
status: draft
---

# 产品更名为 flash：README、提示词与发布产物重命名设计

## 1. 问题与约束

本仓库当前对外呈现的产品名是 "Claude Code"（README 标题、CLI 帮助文本、错误消息、工具描述、Agent 系统提示词），而仓库实际名称与发布渠道是 `wencaiwulue/flash`（`scripts/install.sh:4`、`docs/RELEASE.md:27`）。产品身份不一致，需要将对外呈现统一为 **flash**。

约束：
- 这是 Claude Code 的教学/研究快照，README 与注释中保留对上游的诚实归属（attribution）是前提。
- 存在大量**不能改**的技术标识：`CLAUDECODE=1` 环境变量协议、生成的上游事件类型、记录真实 Claude Code 的内置 agent 等，重命名必须可精确排除。
- 发布产物名（`claude-code-vX.Y.Z-<platform>-<arch>.tar.gz`）被安装脚本、README 示例、SHA256SUMS 校验文档、打包测试共同引用，必须一次性同步，否则安装脚本会因资产名不匹配而失败。
- 变更面广（src 中约 443 处 "Claude Code"、214 个文件），要求 diff 可审查、可回滚。

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 重命名机制：按排除清单过滤后直接替换字符串 | grep 生成文件清单 → 逐文件 sed → git diff 人工复核每一处残留 | 一次性身份变更，无运行时可变性需求；diff 为纯文本替换，易审查、可 `git revert` | 引入中心 `PRODUCT_NAME` 常量并穿透所有模板字符串（约 80 文件重构、模板格式化风险高、收益低） | 新增代码需手工遵循命名约定 | `src/tools/AgentTool/built-in/generalPurposeAgent.ts:3` 等均为一次性字面量 |
| 提示词一并更名 | Agent/工具提示词中的 "Claude Code" → "flash" | Agent 自我介绍是产品身份的一部分；保留旧名会造成用户可见的不一致 | 仅改用户可见字符串、不动提示词（Agent 仍自称 Claude Code，体验割裂） | 提示词 diff 需逐行确认语义 | `src/tools/AgentTool/built-in/generalPurposeAgent.ts:3`、`src/tools/AgentTool/built-in/planAgent.ts:21` |
| `claudeCodeGuideAgent` 不改名不改文案 | 整个文件排除在替换清单外 | 该 agent 的职责是讲解**真实** Claude Code / Claude Agent SDK / Claude API 及其官方文档 URL，与 flash 命名无关 | 一并改名（会导致该 agent 指向错误的产品文档） | 无 | `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts:30-100` |
| 二进制/归档名改为 `flash-vX.Y.Z-...` | `build-binary.ts` 单点产出命名，install.sh 与文档跟随 | 命名源头集中在 `build-binary.ts`，CI 工作流不硬编码产物名，无需改 `.github/workflows` | 同时改 CI 工作流（grep 验证工作流中无 `claude-code` 字面量，改了也无效果） | 旧版本 Release 资产名保持不变（历史资产不回填） | `scripts/build-binary.ts:71-81`、`.github/workflows/release.yml:82-115` |
| 归属表述保留在首行 | README 首行改为 "基于 Claude Code 的教学/研究快照…" | 诚实说明项目来源，同时明确产品名是 flash | 完全去掉 Claude Code 字样（丢失来源信息）、归属下移到 Background 节（首行信息密度下降） | 无 | `README.md:1-5`、`README.zh-CN.md:1-5` |
| 实施顺序：产物命名 → 测试 → 源码字符串 → 文档 | 分四步提交 | 保证任意中间提交点上测试与代码一致，文档始终描述已实现的行为 | 单一巨型提交（可回滚但不可审查）、文档先行（文档描述未实现的产物名） | 多一次提交开销 | `docs/COMMIT_DOCS.md` 的文档一致性要求 |

## 3. 目标与非目标

### 目标
- 对外产品名统一为 flash：README（双语）、CLI 帮助/版本字符串、错误消息、工具描述、Agent 与工具提示词。
- 发布产物、安装脚本、`package.json` name/bin 统一为 flash：二进制 `flash` / `flash.exe`，归档 `flash-vX.Y.Z-<platform>-<arch>.<ext>`。
- 打包测试断言与发布文档（`docs/RELEASING.md`、`docs/RELEASE.md:21`）同步更新。
- 建立可客观检验的完成标准：全仓 grep 残留仅剩排除清单条目。

### 非目标
- 不改 `claudeCodeGuideAgent` 的文案与标识符（它讲解真实的 Claude Code）。
- 不改 `CLAUDECODE=1` 环境变量协议（外部 CLI 依赖，`src/tools/BashTool/BashTool.tsx:1038`、`src/tools/PowerShellTool/PowerShellTool.tsx:745`）。
- 不改 `src/types/generated/events_mono/claude_code/**` 生成类型、OAuth 常量（`src/constants/oauth.ts`）、上游历史注释（如 `src/global.d.ts:12`、`src/setup.ts:422`）。
- 不改 `docs/RELEASE.md:33` 中的 legacy 仓库 URL `wencaiwulue/claude-code`（历史事实）。
- 不重命名更深层的技术标识符（`claude_code` snake_case、`ClaudeCode` PascalCase 内部类型等）。
- 不更新 `docs/architecture/`、`docs/status/` 的内容（本次范围外）。
- 不做中心化 `PRODUCT_NAME` 常量重构。

## 4. 重命名规则与排除清单

### 替换规则（按优先级应用）
1. `Claude Code`（产品指称）→ `flash`。若该行同时声称 flash 是 "Anthropic's official CLI for Claude"，则该短语删除或改写——flash 不再是官方 CLI（如 `generalPurposeAgent.ts:3` 改为 `You are an agent for flash.`）。
2. `claude-code`（二进制/归档/命令名）→ `flash`。
3. `claude_code` / `ClaudeCode` / `claudeCode` 标识符 → 默认保留，除非面向用户（当前无）。
4. **改写而非盲替换**：将 flash 描述为其已不再是的东西（官方 CLI）、作为 Claude Code 快照的归属行、指代上游机制的注释（`CLAUDECODE` hints protocol）一律人工改写，不走 sed。

### 排除清单（绝不替换）
| 路径/模式 | 原因 | 证据 |
|---|---|---|
| `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts` | 讲解真实 Claude Code 文档、SDK 与 API | `:30-100` |
| `src/types/generated/events_mono/claude_code/**` | 生成代码，上游 schema | 目录结构 |
| `CLAUDECODE=1` 相关字面量与注释 | 外部 hints 协议 | `src/tools/BashTool/BashTool.tsx:1038`、`src/tools/PowerShellTool/PowerShellTool.tsx:745` |
| `src/constants/oauth.ts` | 身份/协议常量 | 文件级 |
| 记录上游构建历史的注释 | 历史事实 | `src/global.d.ts:12`、`src/setup.ts:422`、`src/history.ts:412` |
| `docs/RELEASE.md:33` legacy URL | 历史仓库名 | 该行 |

### 归类裁决示例
- `src/history.ts:35` "Claude Code parses history…" 描述的是**本代码库**的行为 → 改为 flash。
- `src/tools/PowerShellTool/pathValidation.ts:1763` 等安全提示 "Claude Code may only access files…" 是面向用户的产品自称 → 改为 flash。

## 5. 分面变更明细

### 5.1 README（`README.md`、`README.zh-CN.md`）
- 标题 `# Claude Code` → `# flash`。
- 首行 → `Educational/research snapshot built on Claude Code: an agentic coding CLI and TypeScript Agent SDK built with Bun, React, and Ink.`（中文：`基于 Claude Code 的教学/研究快照：使用 Bun、React 和 Ink 构建的智能体编程 CLI 与 TypeScript Agent SDK。`）
- 命令与产物示例（双语 README 同步）：`claude-code --version` → `flash --version`（`README.md:63`、`README.zh-CN.md:63`），归档名/SHA256SUMS 示例 → `flash-vX.Y.Z-…`（`README.md:84,89-112`、`README.zh-CN.md:84,89-112`）。

### 5.2 `package.json`
- `"name": "claude-code"` → `"flash"`；`"bin": { "claude-code": "dist/main.js" }` → `"flash": "dist/main.js"`（`package.json:2,8`）。用户键入的命令变为 `flash`。

### 5.3 源码用户可见字符串（214 个文件含 "Claude Code"，含注释，需逐文件归类）
- CLI 帮助与子命令描述：`src/main.tsx:1321,5470,5573,5718,5740,5755,5881,5919,6218,6286`；提示 `main.tsx:1721`。
- 版本横幅：`main.tsx:5234` → `${MACRO.VERSION} (flash)`。
- 错误消息：`src/tools/WebFetchTool/utils.ts:23`；`src/tools/PowerShellTool/pathValidation.ts:1763,1876,1963,2016`。
- 工具描述：`src/tools/ConfigTool/ConfigTool.ts:69`、`src/tools/ConfigTool/prompt.ts:9,50-52`、`src/tools/ListPeersTool/ListPeersTool.ts:31`、`src/tools/RemoteTriggerTool/prompt.ts:4`、`src/commands.ts:193`。
- devtools 提示：`src/ink/devtools.ts:25,37`、`src/ink/reconciler.ts:42`。
- daemon 标题：`src/assistant/daemonBridge.ts:79` → `flash daemon`。
- 环境变量文档注释：`src/env.d.ts:2,5`、`src/setup.ts:75`。

### 5.4 面向模型的提示词
- Agent 前缀：`generalPurposeAgent.ts:3`、`planAgent.ts:21`、`exploreAgent.ts:24`、`statuslineSetup.ts:3,50,137`、`src/coordinator/workerAgent.ts:19`、`src/tools/shared/spawnMultiAgent.ts:399,606,1035`。
- 工具提示词：`FileReadTool/prompt.ts:40`、`ConfigTool/prompt.ts`、`RemoteTriggerTool/prompt.ts`。
- `claudeCodeGuideAgent.ts` 整文件排除（见第 4 节）。

### 5.5 发布产物与脚本
- `scripts/build-binary.ts:71-72`：产物名 `flash` / `flash.exe`；`:81` 归档名 `flash-v${version}-${platform}-${arch}.${ext}`；`:284` 测试隔离目录前缀 `flash-binary-home-`。
- `scripts/install.sh:5` `BINARY_NAME='flash'`；`:95,131` 临时目录前缀 `flash-install.XXXXXX` / `.flash.XXXXXX`；`:124,126,137` 消息文案。
- `.github/workflows/*`：无需变更（`release.yml` 工件名为 `binary-*`，产物名由 `build-binary.ts` 决定；grep 验证工作流无 `claude-code` 字面量）。

### 5.6 测试
- `tests/releasePackaging.test.ts`：`:109,114` 标题断言 `# flash`；`:206-212` 归档名 `flash-v1.2.3-…`、`flash.exe`；`:216-242` 路径片段。其余测试无 "Claude Code" 断言（grep 验证仅此 2+5 处）。

### 5.7 发布文档
- `docs/RELEASING.md:3,10,154-160`（双语）：产物命名规则与提取示例 → flash。
- `docs/RELEASE.md:21`：安装器描述 → 安装 `flash`。

## 6. 实施顺序

1. 产物命名链：`scripts/build-binary.ts` → `scripts/install.sh` → `package.json`（name/bin）。
2. `tests/releasePackaging.test.ts` 断言同步，跑打包测试。
3. 源码用户可见字符串 + 提示词（机械替换 + 规则 4 人工改写）。
4. README 与发布文档（描述步骤 1-3 的结果）。

机械替换流程：`grep -rl "Claude Code\|claude-code" src scripts` 按第 4 节排除清单过滤生成文件清单 → 逐文件定向 sed → `git diff` 人工复核每一处 hunk；规则 4 条目纯手工编辑。

## 7. 失败语义与风险

| 风险 | 场景 | 缓解 |
|---|---|---|
| 归档名与安装脚本不同步 | 新 Release 资产名与 `install.sh` 期望不符，安装失败 | 第 6 节步骤 1 在同一提交内同时改 `build-binary.ts` 与 `install.sh`；README 安装说明同批更新 |
| 排除项被误替换 | sed 误改 `claudeCodeGuideAgent` 或生成类型 | 替换前按文件级清单过滤；替换后全仓 grep 复核残留是否符合清单 |
| 提示词语义破坏 | 盲替换产生不通顺或错误的自我描述 | 规则 4 条目手工改写；diff 逐行审查；测试套件回归 |
| 外部引用旧资产名 | 已发布文档/链接指向 `claude-code-*` 资产 | 历史 Release 资产不回填；新文档只引用 flash 命名；legacy URL 保留 |

回滚：按第 6 节分步提交，任一步可独立 `git revert`。

## 8. 现状验收标准

1. `bun run build` 成功；`bun dist/main.js --version` 输出含 `(flash)`；`--help` 文本以 flash 自称。
2. `bun run test` 全绿，其中 `tests/releasePackaging.test.ts` 断言 flash 命名。
3. `bun scripts/build-binary.ts --validate-only`（与 CI 同参）通过。
4. 客观完成标准：`grep -rn "Claude Code\|claude-code" src scripts package.json README.md README.zh-CN.md docs/RELEASING.md docs/RELEASE.md` 的输出**仅包含**第 4 节排除清单条目。
5. README 安装示例中的归档名与 `build-binary.ts` 产出命名逐字符一致。

## 9. 代码与测试证据

- 产品名残留统计：`grep -rn "Claude Code" src --include="*.ts" --include="*.tsx" | wc -l` = 443；tests 中仅 `tests/releasePackaging.test.ts` 2+5 处。
- 产物命名单点：`scripts/build-binary.ts:71-81`；安装器：`scripts/install.sh:5,95-137`；CI 无硬编码名：`.github/workflows/release.yml:82-115`。
- 排除项证据：`claudeCodeGuideAgent.ts:30-100`（真实产品文档指引）、`BashTool.tsx:1038` / `PowerShellTool.tsx:745`（CLAUDECODE 协议）、`src/types/generated/events_mono/claude_code/v1/claude_code_internal_event.ts:76`（生成类型）、`src/constants/oauth.ts`。

### 未覆盖测试
- 端到端发布演练（打 tag → 资产名 → install.sh 安装）不在本仓库测试范围内，建议下次真实发布时人工核对资产名。
- `--help` 全量子命令文案无自动化断言，依赖人工 diff 审查。
