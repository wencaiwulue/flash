---
id: file-tools
batch: 2
title: File Tools 文件读写、编辑与搜索设计
date: 2026-11-12
status: draft
---

# File Tools 文件读写、编辑与搜索设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理"、"提高可靠性"、"保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

文件工具系统需要解决以下具体问题：

当模型需要读取、写入或编辑文件时，必须：
1. 防止读取后文件被外部修改（如用户或 linter）后再写回导致数据丢失
2. 处理多种文件类型（文本、图片、PDF、Jupyter Notebook）的不同渲染逻辑
3. 避免重复读取相同未修改的文件浪费 context 预算
4. 在编辑时精确匹配 old_string 防止误替换
5. 提供安全边界防止访问系统敏感文件
6. 对大型文件进行分页和 token 预算控制

如果没有读取后修改检测机制，可能发生的场景：模型读取文件 → 用户在另一个编辑器修改文件 → 模型基于过时内容编辑 → 用户修改丢失。

如果没有文件类型分支处理，PDF 或图片的二进制内容会被误当作文本处理，导致乱码或模型误解。

如果没有去重机制，BQ 代理数据显示约 18% 的 FileRead 调用是重复读取同一文件，浪费 cache_creation tokens。

### 调用方与责任边界

调用方：
- 主 QueryEngine 通过 ToolRunner 调用各工具
- 工具之间通过 readFileState 共享文件读取缓存状态

责任边界：
- FileReadTool：文件读取、类型分发、缓存管理
- FileWriteTool：完整文件替换、创建新文件
- FileEditTool：精确字符串替换、局部编辑
- GlobTool：文件名模式匹配
- GrepTool：文件内容搜索
- NotebookEditTool：Jupyter Notebook 单元格编辑
- 权限系统（utils/permissions/filesystem.ts）：访问控制（不属于本 spec 核心，但工具会调用）

### 实际约束

平台与安全约束：
- Windows UNC 路径（\\server\share）不能在 validateInput 中做任何 fs 操作，防止 NTLM 凭据泄露
- /dev/zero、/dev/random、/dev/stdin 等设备文件必须被禁止读取，防止无限输出挂起进程
- macOS 截图文件名可能使用 thin space（U+202F）而非普通空格，需兼容两种格式

性能与体验约束：
- FileRead 去重机制有 killswitch 可通过 feature flag 禁用（tengu_read_dedup_killswitch）
- Grep 默认限制 250 行结果防止填满 context
- FileEdit 最大文件大小 1GiB（防止 OOM）
- PDF 内联阈值配置化（PDF_AT_MENTION_INLINE_THRESHOLD）

### 内部/外部差异

本系统在 CLI、SDK、离线/在线模式下行为一致，唯一差异是：
- SDK 模式下可通过 fileReadingLimits 配置覆盖默认读取限制
- 远程模式下 fetchSingleFileGitDiff 启用（受 tengu_quartz_lantern feature flag 控制）

## 2. 设计理由与备选方案

### 决策 1：基于 mtime + 内容比较的并发修改检测

**实际机制：**
- validateInput 检查：readFileState 必须有该文件记录，且当前文件 mtime ≤ 缓存 mtime
- call 时二次检查：进入临界区后再次 stat 文件并比较内容
- Windows 回退：如果 mtime 变了但完整读取比较内容相同（如云同步、杀毒软件 touch 文件），允许编辑继续

**为什么这样设计：**
- 仅 mtime 检查在 Windows 上会有大量误报（云同步、杀毒软件会更新 mtime 但不改内容）
- 仅内容检查对大文件太慢（1GiB 限制是为了防止这一点）
- 混合策略：先快路径（mtime），如果 mtime 变了再慢路径（内容比较）

**备选方案及不采用原因：**
- 方案 A：仅 mtime 检查 → 被否决，Windows 误报率太高
- 方案 B：仅内容检查 → 被否决，大文件性能不可接受
- 方案 C：文件锁 → 被否决，用户编辑体验差，且跨进程锁不可靠

**代价：**
- 增加实现复杂度，需要同步+异步两个 stat 路径
- Windows 上偶尔会做完整内容比较，有小的性能开销

**证据：**
- `src/tools/FileEditTool/FileEditTool.ts:289-311` validateInput 中的 mtime 检查
- `src/tools/FileEditTool/FileEditTool.ts:451-468` call 中的二次检查+内容比较回退
- `src/tools/FileWriteTool/FileWriteTool.ts:198-237` 类似逻辑

### 决策 2：FileRead 去重基于精确 range 匹配 + mtime，返回 file_unchanged stub

**实际机制：**
- 仅对 FileRead 本身缓存的条目去重（offset 必须存在，即来自 Read 而非 Edit/Write）
- 检查 mtime 完全相等（Math.floor 到毫秒级一致性）
- 返回 `{type: 'file_unchanged', file: {filePath}}` 而非完整内容
- 有 killswitch：tengu_read_dedup_killswitch 可禁用

**为什么这样设计：**
- BQ 代理数据显示约 18% 的 Read 调用是重复读取
- 模型仍能在 context 中看到之前的 Read 结果，stub 只是避免重复发送
- offset/limit 必须精确匹配，因为不同 range 的读取结果不同

**备选方案及不采用原因：**
- 方案 A：完全不检测，总是重读 → 被否决，浪费 tokens
- 方案 B：基于内容 hash 去重 → 被否决，需要读取文件才能 hash，反而失去意义
- 方案 C：Edit/Write 后也允许去重 → 被否决，Edit/Write 的 readFileState 条目没有 offset，指向 post-edit 内容但 context 中还是 pre-edit

**代价：**
- 增加状态管理复杂度（需要区分 Read 产生的条目和 Edit/Write 产生的条目）
- 模型可能困惑为什么有时返回 stub（但 prompt 中有说明）

**证据：**
- `src/tools/FileReadTool/FileReadTool.ts:524-573` 去重逻辑
- `src/tools/FileReadTool/FileReadTool.ts:162-173` registerFileReadListener（用于其他模块监听读取事件）
- `src/tools/FileReadTool/FileReadTool.ts:536-539` killswitch 检查

### 决策 3：文件类型基于扩展名分支，而非内容检测

**实际机制：**
- 按 `.ipynb` → 图片扩展名（png/jpg/jpeg/gif/webp）→ `.pdf` → 文本的优先级判断
- 二进制扩展名检查：hasBinaryExtension 排除非文本、非 PDF、非图片的文件
- PDF 进一步分支：有 pages 参数 → 提取页面；无 pages 参数但页数多 → 报错要求 pages；否则内联

**为什么这样设计：**
- 扩展名检测是 O(1) 字符串操作，不需要读取文件
- 误报率低：用户很少把图片命名为 .txt 或反之
- 安全：防止尝试把二进制当作文本读取导致乱码

**备选方案及不采用原因：**
- 方案 A：magic number 内容检测 → 被否决，需要先读取文件，违反 UNC 路径安全约束
- 方案 B：总是尝试文本读取，失败再回退 → 被否决，可能触发错误且效率低

**代价：**
- 偶尔会误判（如用户重命名文件）
- 需要维护扩展名列表

**证据：**
- `src/tools/FileReadTool/FileReadTool.ts:518-521` 扩展名判断
- `src/tools/FileReadTool/FileReadTool.ts:822-862` Notebook 分支
- `src/tools/FileReadTool/FileReadTool.ts:866-891` Image 分支
- `src/tools/FileReadTool/FileReadTool.ts:894-1017` PDF 分支
- `src/tools/FileReadTool/FileReadTool.ts:1020-1085` Text 分支

### 决策 4：FileEdit 使用 findActualString 做引号规范化，而非要求 old_string 精确匹配

**实际机制：**
- `findActualString(file, old_string)` 在文件中查找 old_string，但允许：
  - 单引号与双引号互换（' → "）
  - 反引号与引号互换（` → "）
- 如果找到匹配但引号不同，使用实际文件中的字符串作为 old_string 进行替换
- preserveQuoteStyle 会保持文件中原有的引号风格

**为什么这样设计：**
- 模型输出时经常混用引号样式（受训练数据影响）
- 精确匹配会导致很多编辑失败，用户体验差
- 规范化只发生在字符串边界，不会误改字符串中间的内容

**备选方案及不采用原因：**
- 方案 A：严格精确匹配 → 被否决，编辑成功率太低
- 方案 B：让模型重新读取文件 → 被否决，浪费 tokens 且增加延迟
- 方案 C：编辑前自动格式化文件 → 被否决，可能引入大量无关变更

**代价：**
- 存在极小概率误匹配（两个字符串只有引号不同且都存在）
- 实现复杂度增加

**证据：**
- `src/tools/FileEditTool/utils.ts` findActualString 实现
- `src/tools/FileEditTool/utils.ts` preserveQuoteStyle 实现
- `src/tools/FileEditTool/FileEditTool.ts:315-317` validateInput 中的应用
- `src/tools/FileEditTool/FileEditTool.ts:471-479` call 中的应用

### 决策 5：Grep 基于 ripgrep 后端，而非 Node.js 实现

**实际机制：**
- 调用外部 `rg` 命令
- 默认排除 VCS 目录（.git/.svn/.hg/.bzr/.jj/.sl）
- 结果按 mtime 降序排序（最新修改的文件在前）
- 支持三种输出模式：files_with_matches（默认）、content、count
- 默认限制 250 行结果（head_limit），显式传 0 为无限

**为什么这样设计：**
- ripgrep 性能远好于 Node.js 实现（特别是大代码库）
- ripgrep 自动处理 .gitignore，符合用户预期
- mtime 排序让用户首先看到最相关的结果

**备选方案及不采用原因：**
- 方案 A：纯 Node.js 实现 → 被否决，性能差且需要自己处理 ignore
- 方案 B：直接用 `grep` → 被否决，性能不如 ripgrep，且没有 ignore 支持

**代价：**
- 需要依赖外部二进制（在某些环境可能不可用）
- 参数传递需要小心避免 shell 注入（当前实现使用 execFile，无 shell 注入风险）

**证据：**
- `src/tools/GrepTool/GrepTool.ts:329-441` ripgrep 调用逻辑
- `src/tools/GrepTool/GrepTool.ts:94-108` VCS 目录排除
- `src/tools/GrepTool/GrepTool.ts:529-553` mtime 排序
- `src/utils/ripgrep.ts` 底层实现

## 3. 目标与非目标

### 状态与生命周期

**目标：**
- readFileState 跨工具共享，记录文件路径 → {content, timestamp, offset, limit}
- offset/limit 存在表示来自 FileRead，可用于去重
- offset/limit undefined 表示来自 FileEdit/FileWrite，仅用于并发修改检测
- timestamp 使用 Math.floor(mtimeMs) 确保跨平台一致性

**非目标：**
- 不负责持久化 readFileState（仅内存中）
- 不做文件变更监听（轮询 mtime 已足够）

### 接口与数据

**目标：**
- 所有工具输入输出有 zod schema 验证
- FileRead 输出是 tagged union：text/image/notebook/pdf/parts/file_unchanged
- FileEdit/FileWrite 输出包含 structuredPatch、original_file、updated_file
- mapToolResultToToolResultBlockParam 将工具输出转换为模型可见的消息

**非目标：**
- 不保证向后兼容旧 schema（但会通过 lazySchema 延迟求值）
- 不提供通用的 diff/patch 库（仅内部使用 getPatchForDisplay）

### 执行与环境

**目标：**
- validateInput 在权限检查前执行，无 fs 操作（除 UNC 路径跳过）
- 权限检查由 utils/permissions/filesystem.ts 负责
- call 中的临界区（读取-修改-写入）尽量短，避免 async 操作
- writeTextContent 直接使用模型输出的换行符，不自动规范化

**非目标：**
- 不做自动格式化（如 Prettier）
- 不做冲突解决（如 Git merge）
- 不支持撤销/重做（但有 fileHistoryTrackEdit 用于文件历史）

### 依赖边界

- **权限系统**（`src/utils/permissions/filesystem.ts`）：本 spec 描述调用契约，主设计由权限 spec 负责
- **工具框架**（`src/Tool.ts`）：本 spec 仅描述各工具的 buildTool 使用，不描述 Tool 接口本身
- **分析事件**（`src/services/analytics/index.ts`）：logEvent 调用仅用于遥测，不影响核心行为

## 4. 架构、模块与数据流

### 4.1 模块设计卡片

#### 模块：FileReadTool

**真实输入 Schema（从源码提取）：**
```typescript
{
  file_path: string;           // 绝对路径，通过 expandPath 规范化
  offset?: number;             // 起始行（1-indexed，默认 1）
  limit?: number;              // 行数限制
  pages?: string;              // PDF 页面范围（如 "1-5", "3", "10-20"）
}
```
*校验规则：pages 解析为 1-indexed，单页范围不能超过 PDF_MAX_PAGES_PER_READ*

**真实输出 Schema（从源码提取）：**
```typescript
// discriminated union by type
| { type: 'text'; file: { filePath: string; content: string; numLines: number; startLine: number; totalLines: number }}
| { type: 'image'; file: { base64: string; type: 'image/jpeg'|'image/png'|'image/gif'|'image/webp'; originalSize: number; dimensions?: { originalWidth?: number; originalHeight?: number; displayWidth?: number; displayHeight?: number }}}
| { type: 'notebook'; file: { filePath: string; cells: NotebookCell[] }}
| { type: 'pdf'; file: { filePath: string; base64: string; originalSize: number }}
| { type: 'parts'; file: { filePath: string; originalSize: number; count: number; outputDir: string }}
| { type: 'file_unchanged'; file: { filePath: string }}
```

**文件状态 / mtime 处理：**
- readFileState 条目结构：`{ content: string; timestamp: number; offset?: number; limit?: number }`
- timestamp 使用 `Math.floor(mtimeMs)` 确保跨平台一致性（避免亚毫秒精度问题）
- 去重检查：仅当条目存在 offset/limit（来自 FileRead 而非 Edit/Write）、且 mtime 完全匹配时生效
- 去重 killswitch：`tengu_read_dedup_killswitch` 可禁用（默认启用）

**完整读写编辑流程：**
```
FileRead.call()
  ├─ expandPath 规范化路径
  ├─ 去重检查
  │   ├─ readFileState 有该文件条目？
  │   ├─ offset/limit 精确匹配？
  │   └─ mtime 完全一致？
  │       └─ 是 → 返回 file_unchanged
  ├─ 类型分支（按扩展名优先级）
  │   ├─ .ipynb → Notebook 分支
  │   ├─ 图片扩展名 → Image 分支
  │   ├─ .pdf → PDF 分支
  │   └─ 其他 → Text 分支
  ├─ 读取内容
  ├─ 存入 readFileState（带 offset/limit）
  ├─ 触发 fileReadListeners（如果有）
  └─ 返回完整输出
```

**并发修改检测：**
- FileRead 本身不做并发检测（只读操作）
- 但会将 mtime 存入 readFileState，供后续 Edit/Write 校验使用
- 去重时会再次 stat 文件确认 mtime 未变

**二进制 / PDF / Notebook 分支：**

| 分支 | 扩展名 | 处理逻辑 | 外部依赖 |
|------|--------|----------|----------|
| Notebook | `.ipynb` | jsonParse 解析，检查大小限制，返回 cells | 无 |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | readFileBytes 读取，detectImageFormatFromBuffer 检测格式，maybeResizeAndDownsampleImageBuffer 调整大小，超限时 compressImageBufferWithTokenLimit 压缩 | sharp（可选，用于压缩降级） |
| PDF | `.pdf` | pages 参数存在 → extractPDFPages 拆分页面；无 pages → getPDFPageCount 检查页数；页数 ≤ PDF_AT_MENTION_INLINE_THRESHOLD 且 isPdfSupported → readPDF 返回 base64 | poppler-utils（pdftoppm, pdfinfo，可选但推荐） |
| Text | 其他（非 hasBinaryExtension） | readFileInRange 按 offset/limit 读取，addLineNumbers 加行号，validateContentTokens 检查 token 限制 | 无 |

**错误与权限边界：**
- UNC 路径：跳过所有 fs 操作，仅做路径检查（防止 Windows NTLM 凭据泄露）
- 设备文件：`/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/full`, `/dev/stdin`, `/dev/tty`, `/dev/console`, `/dev/stdout`, `/dev/stderr`, `/proc/*/fd/0-2` 拒绝读取
- 二进制扩展名：hasBinaryExtension 返回 true 且非图片/PDF → 拒绝
- ENOENT 处理：尝试 macOS 截图替代路径（普通空格 ↔ thin space），再尝试 suggestPathUnderCwd
- token 超限：MaxFileReadTokenExceededError

**设计取舍与备选：**
- 去重仅对精确 offset/limit 生效 → 备选：支持包含关系（先读全文件再读部分）→ 被否决：模型可能需要行号保持一致
- 基于扩展名而非内容检测 → 备选：magic number 检测 → 被否决：需要先读文件，违反 UNC 路径安全约束
- killswitch 模式 → 取舍：增加复杂度，但支持灰度发布和快速回滚

**源码测试证据：**
- 输入 Schema：`src/tools/FileReadTool/FileReadTool.ts:227-242`
- 输出 Schema：`src/tools/FileReadTool/FileReadTool.ts:248-332`
- 去重逻辑：`src/tools/FileReadTool/FileReadTool.ts:524-573`
- 类型分支：`src/tools/FileReadTool/FileReadTool.ts:822-1085`
- 设备文件检查：`src/tools/FileReadTool/FileReadTool.ts:96-128`
- macOS 截图路径处理：`src/tools/FileReadTool/FileReadTool.ts:130-159`

---

#### 模块：FileWriteTool

**真实输入 Schema（从源码提取）：**
```typescript
{
  file_path: string;           // 绝对路径，通过 expandPath 规范化
  content: string;             // 完整内容，直接使用模型输出的换行符
}
```

**真实输出 Schema（从源码提取）：**
```typescript
{
  type: 'create' | 'update';   // create=新文件，update=已存在
  filePath: string;
  content: string;
  structuredPatch: PatchHunk[];
  originalFile: string | null; // null 表示新文件
  gitDiff?: ToolUseDiff;       // 仅远程模式且 tengu_quartz_lantern 启用
}
```

**文件状态 / mtime 处理：**
- validateInput 阶段：检查 readFileState 有该文件条目（新文件除外），且当前 mtime ≤ 缓存 mtime
- call 阶段临界区：readFileSyncWithMetadata 再次读取，二次检查 mtime，Windows 上内容比较回退
- 写入后更新 readFileState：`{ content: string; timestamp: number; offset: undefined; limit: undefined }`，offset undefined 防止 FileRead 去重匹配（模型看到的是旧内容）

**完整读写编辑流程：**
```
FileWrite.call()
  ├─ expandPath 规范化路径
  ├─ mkdir 父目录（临界区外！）
  ├─ fileHistoryTrackEdit 备份（临界区外！）
  ├─ 临界区开始（避免 async 操作）
  │   ├─ readFileSyncWithMetadata 同步读取
  │   ├─ 二次检查 mtime ≤ 缓存
  │   │   └─ Windows：mtime 变了但内容相同 → 允许继续
  │   ├─ writeTextContent（直接使用模型换行符，不保留原文件换行符）
  │   └─ 临界区结束
  ├─ LSP 通知：didChange + didSave
  ├─ notifyVscodeFileUpdated
  ├─ 更新 readFileState（offset: undefined）
  ├─ 远程模式：fetchSingleFileGitDiff（可选）
  └─ 返回输出
```

**并发修改检测：**
- validateInput 阶段：async stat 获取 mtime，与 readFileState 比较
- call 阶段临界区：readFileSyncWithMetadata 同步读取，再次 getFileModificationTime 检查
- Windows 回退：mtime 变了但内容相同（比较完整内容）→ 允许继续
- 临界区不包含 async 操作：避免在检查和写入之间让出事件循环

**错误与权限边界：**
- 未读先写：拒绝（需先 FileRead）
- team memory secrets：checkTeamMemSecrets 检查
- UNC 路径：跳过 fs 操作
- writeTextContent：先尝试原子写入（临时文件 + rename），失败则回退到直接写入
- 权限：checkWritePermissionForTool

**设计取舍与备选：**
- 直接使用模型换行符，不保留原文件换行符 → 取舍：跨平台编辑可能换行符不一致，但避免了静默把 LF 改成 CRLF 破坏 Linux 脚本 → 证据：`src/tools/FileWriteTool/FileWriteTool.ts:300-308`
- 临界区不包含 async 操作 → 取舍：mkdir 和 fileHistoryTrackEdit 需要提前，但避免了并发修改窗口
- 原子写入 + 回退 → 取舍：增加复杂度，但提升可靠性

**源码测试证据：**
- 输入 Schema：`src/tools/FileWriteTool/FileWriteTool.ts:56-65`
- 输出 Schema：`src/tools/FileWriteTool/FileWriteTool.ts:68-88`
- validateInput mtime 检查：`src/tools/FileWriteTool/FileWriteTool.ts:186-221`
- 临界区二次检查：`src/tools/FileWriteTool/FileWriteTool.ts:279-294`
- writeTextContent：`src/tools/FileWriteTool/FileWriteTool.ts:300-308`
- 原子写入逻辑：`src/utils/file.ts:362-478`

---

#### 模块：FileEditTool

**真实输入 Schema（从源码提取）：**
```typescript
{
  file_path: string;           // 绝对路径，通过 expandPath 规范化
  old_string: string;          // 要替换的字符串
  new_string: string;          // 替换后的字符串
  replace_all?: boolean;       // 默认 false，是否替换所有匹配
}
```

**真实输出 Schema（从源码提取）：**
```typescript
{
  filePath: string;
  oldString: string;           // 实际匹配的字符串（可能引号已规范化）
  newString: string;
  originalFile: string;
  structuredPatch: PatchHunk[];
  userModified: boolean;       // 是否被用户修改
  replaceAll: boolean;
  gitDiff?: ToolUseDiff;       // 仅远程模式且 tengu_quartz_lantern 启用
}
```

**文件状态 / mtime 处理：**
- validateInput 阶段：check readFileState 存在，getFileModificationTime ≤ 缓存，Windows 内容比较回退
- call 阶段临界区：readFileSyncWithMetadata，二次检查 mtime，getPatchForEdit 生成 patch，writeTextContent
- 写入后更新 readFileState：`{ content: string; timestamp: number; offset: undefined; limit: undefined }`

**完整读写编辑流程：**
```
FileEdit.call()
  ├─ expandPath 规范化路径
  ├─ mkdir 父目录（临界区外！）
  ├─ fileHistoryTrackEdit 备份（临界区外！）
  ├─ 临界区开始
  │   ├─ readFileSyncWithMetadata 同步读取
  │   ├─ 二次检查 mtime ≤ 缓存
  │   │   └─ Windows：内容比较回退
  │   ├─ findActualString 引号规范化
  │   ├─ preserveQuoteStyle 保持文件引号风格
  │   ├─ getPatchForEdit 生成 patch
  │   └─ writeTextContent（保持原文件换行符）
  ├─ LSP 通知：didChange + didSave
  ├─ notifyVscodeFileUpdated
  ├─ 更新 readFileState（offset: undefined）
  ├─ countLinesChanged 统计变更
  ├─ 远程模式：fetchSingleFileGitDiff（可选）
  └─ 返回输出
```

**并发修改检测：**
- validateInput 阶段：async stat → getFileModificationTime
- call 阶段临界区：sync readFileSyncWithMetadata → sync getFileModificationTime
- Windows 回退：mtime > 缓存但 isFullRead（offset/limit 均 undefined）且内容相同 → 允许继续
- 最大文件限制：1 GiB（防止 OOM，因为 V8 字符串长度限制约 2^30）

**精确替换与 Windows 内容比较回退：**
- findActualString：允许单引号 ↔ 双引号 ↔ 反引号互换，查找实际匹配的字符串
- preserveQuoteStyle：保持文件中原有的引号风格
- old_string 多匹配：replace_all=false 时拒绝，要求更精确的上下文
- Windows 内容比较：mtime 变了但完整内容相同 → 允许编辑（云同步/杀毒软件 touch 文件不报错）

**错误与权限边界：**
- 文件不存在：拒绝，除非 old_string 为空
- .ipynb 文件：拒绝，要求用 NotebookEditTool
- old_string 未找到：拒绝
- old_string 多匹配且 replace_all=false：拒绝
- 文件 > 1 GiB：拒绝
- settings 文件额外校验：validateInputForSettingsFileEdit
- 权限：checkWritePermissionForTool

**设计取舍与备选：**
- findActualString 引号规范化 → 取舍：极小概率误匹配（两个字符串只有引号不同且都存在），但大幅提升编辑成功率
- 1 GiB 限制 → 取舍：防止 OOM，但大文件无法编辑
- 仅对完整读取条目做内容比较回退 → 取舍：部分读取条目无法回退，但避免了读取全文件的开销

**源码测试证据：**
- 输入 Schema：`src/tools/FileEditTool/types.ts`
- 输出 Schema：`src/tools/FileEditTool/types.ts`
- validateInput 逻辑：`src/tools/FileEditTool/FileEditTool.ts:137-361`
- call 临界区：`src/tools/FileEditTool/FileEditTool.ts:428-491`
- findActualString/preserveQuoteStyle：`src/tools/FileEditTool/utils.ts`
- MAX_EDIT_FILE_SIZE：`src/tools/FileEditTool/FileEditTool.ts:84-88`
- Windows 内容比较回退：`src/tools/FileEditTool/FileEditTool.ts:294-310, 454-466`

---

#### 模块：GlobTool

**真实输入 Schema（从源码提取）：**
```typescript
{
  pattern: string;             // glob 模式
  path?: string;               // 搜索目录，默认 cwd
}
```

**真实输出 Schema（从源码提取）：**
```typescript
{
  durationMs: number;          // 执行耗时（毫秒）
  numFiles: number;            // 匹配文件数
  filenames: string[];         // 相对路径
  truncated: boolean;          // 是否被截断（globLimits.maxResults，默认 100）
}
```

**完整流程：**
```
GlobTool.call()
  ├─ 确定搜索目录（path || cwd）
  ├─ glob(pattern, dir, { limit, offset: 0 }, signal, permissionContext)
  ├─ toRelativePath 转换为相对路径
  ├─ 计算 durationMs
  └─ 返回输出
```

**参数与结果限制：**
- 默认 limit：100（可通过 globLimits.maxResults 覆盖）
- 结果：相对路径（节省 token）

**错误与权限边界：**
- path 不存在：ENOENT 处理，suggestPathUnderCwd
- path 不是目录：拒绝
- UNC 路径：跳过 fs 操作
- 权限：checkReadPermissionForTool

**源码测试证据：**
- 输入 Schema：`src/tools/GlobTool/GlobTool.ts:26-36`
- 输出 Schema：`src/tools/GlobTool/GlobTool.ts:39-52`
- call 逻辑：`src/tools/GlobTool/GlobTool.ts:154-176`

---

#### 模块：GrepTool

**真实输入 Schema（从源码提取）：**
```typescript
{
  pattern: string;                         // 正则表达式
  path?: string;                           // 搜索路径，默认 cwd
  glob?: string;                           // 文件过滤 glob
  output_mode?: 'content' | 'files_with_matches' | 'count'; // 默认 files_with_matches
  '-B'?: number;                           // 前几行上下文
  '-A'?: number;                           // 后几行上下文
  '-C'?: number;                           // 前后上下文（优先于 -B/-A）
  context?: number;                        // 同 -C
  '-n'?: boolean;                          // 显示行号，默认 true
  '-i'?: boolean;                          // 忽略大小写
  type?: string;                           // 文件类型（rg --type）
  head_limit?: number;                     // 结果限制，默认 250，0=无限
  offset?: number;                         // 跳过行数，默认 0
  multiline?: boolean;                     // 多行模式（. 匹配换行）
}
```

**真实输出 Schema（从源码提取）：**
```typescript
// output_mode = 'content'
{
  mode: 'content';
  numFiles: 0;
  filenames: string[];
  content: string;            // 带行号/路径的匹配内容
  numLines: number;
  appliedLimit?: number;      // 仅截断时存在
  appliedOffset?: number;     // 仅 offset>0 时存在
}

// output_mode = 'files_with_matches'（默认）
{
  mode: 'files_with_matches';
  numFiles: number;
  filenames: string[];        // 按 mtime 降序（最新在前），测试环境按文件名
  appliedLimit?: number;
  appliedOffset?: number;
}

// output_mode = 'count'
{
  mode: 'count';
  numFiles: number;
  filenames: string[];
  content: string;            // filename:count 格式
  numMatches: number;         // 总匹配数
  appliedLimit?: number;
  appliedOffset?: number;
}
```

**完整流程：**
```
GrepTool.call()
  ├─ 构建 ripgrep args
  │   ├─ --hidden
  │   ├─ --glob !.git, !.svn, !.hg, !.bzr, !.jj, !.sl（排除 VCS 目录）
  │   ├─ --max-columns 500（避免长行污染）
  │   ├─ multiline → -U --multiline-dotall
  │   ├─ -i（如果指定）
  │   ├─ -l（files_with_matches）或 -c（count）
  │   ├─ -n（content 且 show_line_numbers）
  │   ├─ -C/-B/-A（content 且指定上下文）
  │   ├─ -e（pattern 以 - 开头时）
  │   ├─ --type（如果指定）
  │   ├─ --glob（如果指定 glob）
  │   └─ --glob !...（权限 ignore patterns）
  ├─ ripGrep(args, absolutePath, signal) 执行
  ├─ output_mode 分支
  │   ├─ content
  │   │   ├─ applyHeadLimit（先限制，再 relativize，避免无用工作）
  │   │   ├─ toRelativePath 逐行转换路径
  │   │   └─ 返回
  │   ├─ count
  │   │   ├─ applyHeadLimit
  │   │   ├─ toRelativePath 逐行转换
  │   │   ├─ 解析并累加 numMatches
  │   │   └─ 返回
  │   └─ files_with_matches（默认）
  │       ├─ Promise.allSettled(stat)（单个 ENOENT 不拒绝整个批次）
  │       ├─ 按 mtime 降序排序（测试环境按文件名）
  │       ├─ applyHeadLimit
  │       ├─ toRelativePath 转换
  │       └─ 返回
  └─ 返回输出
```

**ripgrep 参数与结果限制：**
- 默认 head_limit：250（防止填满 context）
- head_limit=0：无限（慎用）
- applyHeadLimit 在 relativize 之前：避免处理会被丢弃的行
- VCS 目录自动排除：`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`
- max-columns：500（截断长行）

**错误与权限边界：**
- path 不存在：ENOENT 处理，suggestPathUnderCwd
- UNC 路径：跳过 fs 操作
- ripgrep 超时：RipGrepTimeoutError
- 权限：checkReadPermissionForTool

**设计取舍与备选：**
- 基于 ripgrep 而非纯 Node.js 实现 → 取舍：依赖外部二进制，但性能远好于 Node.js，且自动处理 .gitignore
- files_with_matches 按 mtime 降序 → 取舍：用户首先看到最新文件，更相关
- applyHeadLimit 在 relativize 之前 → 取舍：避免无用工作，提升性能
- Promise.allSettled(stat) → 取舍：单个文件被删除不拒绝整个批次

**源码测试证据：**
- 输入 Schema：`src/tools/GrepTool/GrepTool.ts:33-90`
- 输出 Schema：`src/tools/GrepTool/GrepTool.ts:144-159`
- ripgrep args 构建：`src/tools/GrepTool/GrepTool.ts:329-434`
- applyHeadLimit：`src/tools/GrepTool/GrepTool.ts:110-128`
- mtime 排序：`src/tools/GrepTool/GrepTool.ts:529-553`
- VCS 目录排除：`src/tools/GrepTool/GrepTool.ts:94-108`

---

#### 模块：NotebookEditTool

**真实输入 Schema（从源码提取）：**
```typescript
{
  notebook_path: string;       // 绝对路径
  cell_id?: string;            // 单元格 ID 或 cell-N 格式（N 为 0-indexed）
  new_source: string;          // 新的源代码
  cell_type?: 'code' | 'markdown'; // 单元格类型，insert 时必须
  edit_mode?: 'replace' | 'insert' | 'delete'; // 默认 replace
}
```

**真实输出 Schema（从源码提取）：**
```typescript
{
  new_source: string;
  cell_id?: string;            // 可能是新生成的随机 ID
  cell_type: 'code' | 'markdown';
  language: string;            // notebook.metadata.language_info?.name || 'python'
  edit_mode: string;
  error?: string;              // 错误信息
  notebook_path: string;
  original_file: string;
  updated_file: string;
}
```

**文件状态 / mtime 处理：**
- validateInput 阶段：check readFileState 存在，getFileModificationTime ≤ 缓存
- call 阶段：readFileSyncWithMetadata 读取，更新后 writeTextContent，更新 readFileState（offset: undefined）

**完整流程：**
```
NotebookEditTool.call()
  ├─ expandPath/resolve 规范化路径
  ├─ fileHistoryTrackEdit 备份（如果启用）
  ├─ readFileSyncWithMetadata 同步读取
  ├─ jsonParse 解析（非 memoized，因为要原地修改）
  ├─ 解析 cell_id：先找实际 ID，失败则 parseCellId 为数字索引
  ├─ edit_mode 分支
  │   ├─ delete：cells.splice(cellIndex, 1)
  │   ├─ insert：
  │   │   ├─ nbformat ≥ 4.5 → 生成随机 cell_id（Math.random().toString(36).slice(2,15)）
  │   │   ├─ markdown：{ cell_type: 'markdown', id: ?, source: new_source, metadata: {} }
  │   │   ├─ code：{ cell_type: 'code', id: ?, source: new_source, metadata: {}, execution_count: null, outputs: [] }
  │   │   └─ cells.splice(cellIndex, 0, new_cell)
  │   └─ replace（默认）：
  │       ├─ cellIndex === cells.length → 自动切换为 insert
  │       ├─ targetCell.source = new_source
  │       ├─ code cell：execution_count = null, outputs = []（重置）
  │       └─ cell_type 指定：targetCell.cell_type = cell_type
  ├─ jsonStringify(notebook, null, 1)（IPYNB_INDENT = 1）
  ├─ writeTextContent（保持原文件编码和换行符）
  ├─ 更新 readFileState（offset: undefined）
  └─ 返回输出
```

**Notebook cell 索引与输出保留：**
- cell_id 解析优先级：实际 cell.id → parseCellId（cell-N → N）
- edit_mode=insert 在 cell_id 之后插入
- edit_mode=replace 且 cellIndex === cells.length → 自动切换为 insert
- code cell 被替换：execution_count 设为 null，outputs 清空（因为内容已变）
- nbformat ≥ 4.5 且 insert：生成随机 cell_id

**错误与权限边界：**
- 非 .ipynb 文件：拒绝
- edit_mode 不是 replace/insert/delete：拒绝
- edit_mode=insert 且 cell_type 未指定：拒绝
- 未读先写：拒绝
- 文件不存在：拒绝
- 无效 JSON：拒绝
- cell_id 不存在：拒绝
- UNC 路径：跳过 fs 操作
- 权限：checkWritePermissionForTool

**设计取舍与备选：**
- 非 memoized jsonParse → 取舍：safeParseJSON 缓存会被原地修改污染
- nbformat 版本判断 → 取舍：旧版本不需要 cell_id
- code cell 重置 execution_count/outputs → 取舍：内容已变，旧的执行结果无意义

**源码测试证据：**
- 输入 Schema：`src/tools/NotebookEditTool/NotebookEditTool.ts:30-57`
- 输出 Schema：`src/tools/NotebookEditTool/NotebookEditTool.ts:60-85`
- validateInput：`src/tools/NotebookEditTool/NotebookEditTool.ts:176-293`
- call 逻辑：`src/tools/NotebookEditTool/NotebookEditTool.ts:295-489`
- parseCellId：`src/utils/notebook.ts`
- cell_id 生成：`src/tools/NotebookEditTool/NotebookEditTool.ts:381-389`

---

#### 共享辅助模块：readFileState 缓存填充/失效

**数据结构：**
```typescript
// ToolUseContext 中的 readFileState
Map<string, {
  content: string;
  timestamp: number;      // Math.floor(mtimeMs)
  offset?: number;        // FileRead 时有，用于去重
  limit?: number;
  isPartialView?: boolean;
}>
```

**缓存填充：**
- FileRead：存入完整 content + timestamp + offset + limit
- FileWrite：存入新 content + 当前 mtime + offset: undefined + limit: undefined
- FileEdit：存入新 content + 当前 mtime + offset: undefined + limit: undefined
- NotebookEdit：存入新 content + 当前 mtime + offset: undefined + limit: undefined

**缓存失效（去重匹配条件）：**
- offset 不存在（来自 Edit/Write）→ 不能去重
- offset/limit 不精确匹配 → 不能去重
- mtime !== 缓存 timestamp → 不能去重
- killswitch 启用 → 不能去重

**设计取舍与备选：**
- Edit/Write 后 offset: undefined → 取舍：模型看到的是旧内容，不能去重匹配，避免混淆
- 精确 offset/limit 匹配 → 取舍：不能处理先读全文件再读部分的情况，但行号保持一致

**源码测试证据：**
- FileRead 填充：`src/tools/FileReadTool/FileReadTool.ts:1032-1037`
- FileWrite 填充：`src/tools/FileWriteTool/FileWriteTool.ts:332-337`
- FileEdit 填充：`src/tools/FileEditTool/FileEditTool.ts:520-525`
- NotebookEdit 填充：`src/tools/NotebookEditTool/NotebookEditTool.ts:437-442`

---

#### 共享辅助模块：PDF 页码与图像处理路径

**PDF 读取分支完整逻辑：**
```
FileRead PDF 分支
  ├─ pages 参数存在？
  │   └─ 是 → extractPDFPages
  │       ├─ 检查 pdftoppm 可用
  │       ├─ mkdir 输出目录（uuid 命名）
  │       ├─ pdftoppm -jpeg -r 100 [-f firstPage] [-l lastPage]
  │       ├─ 检查是否密码保护/损坏
  │       ├─ readdir + sort 图像文件
  │       ├─ 返回 { type: 'parts', count, outputDir }
  │       └─ mapToolResultToAPIMessage 读取图像并发送
  │
  └─ 否 → getPDFPageCount
      ├─ pdfinfo 读取页数（如果可用）
      ├─ 页数 > PDF_AT_MENTION_INLINE_THRESHOLD？
      │   └─ 是 → 报错要求 pages 参数
      ├─ 页数 ≤ 阈值？
      │   ├─ isPdfSupported()？
      │   │   └─ 否 → 报错要求 pages + poppler-utils
      │   └─ 是 → readPDF
      │       ├─ stat 检查大小（≤ PDF_TARGET_RAW_SIZE）
      │       ├─ 检查 %PDF- magic bytes
      │       ├─ base64 编码
      │       └─ 返回 { type: 'pdf', base64 }
      └─ pdfinfo 不可用 → 假设页数 ≤ 阈值，直接 readPDF
```

**PDF 相关常量（从源码提取）：**
- PDF_AT_MENTION_INLINE_THRESHOLD：内联页数阈值
- PDF_TARGET_RAW_SIZE：内联 PDF 最大原始大小（base64 后约 33% 更大）
- PDF_MAX_EXTRACT_SIZE：extractPDFPages 最大文件大小
- PDF_MAX_PAGES_PER_READ：单次 pages 参数最大页数

**图像处理路径（Image 分支）：**
```
readImageWithTokenBudget()
  ├─ getFsImplementation().readFileBytes 读取（一次，不重读）
  ├─ detectImageFormatFromBuffer 检测格式
  ├─ maybeResizeAndDownsampleImageBuffer 尝试标准调整
  ├─ estimatedTokens > maxTokens？
  │   └─ 是 → compressImageBufferWithTokenLimit 激进压缩
  │       └─ 失败 → sharp 降级（resize 400x400 + jpeg quality 20）
  │           └─ 失败 → 返回原始
  └─ 返回 { type: 'image', base64, type, originalSize, dimensions? }
```

**设计取舍与备选：**
- 一次读取不重读 → 取舍：避免 I/O，但需要在内存中保留 buffer
- 先标准调整再激进压缩 → 取舍：尽量保留质量
- poppler-utils 可选但推荐 → 取舍：不安装时只能读小 PDF inline

**源码测试证据：**
- PDF 分支：`src/tools/FileReadTool/FileReadTool.ts:894-1017`
- pdf.ts：`src/utils/pdf.ts`
- readImageWithTokenBudget：`src/tools/FileReadTool/FileReadTool.ts:1097-1183`
- imageResizer.ts：`src/utils/imageResizer.ts`

---

### 4.2 入口与公共契约

#### FileReadTool 入口

```typescript
type Input = {
  file_path: string;           // 绝对路径
  offset?: number;             // 起始行（默认 1）
  limit?: number;              // 行数限制
  pages?: string;              // PDF 页面范围（如 "1-5"）
};

type Output = 
  | { type: 'text'; file: { filePath: string; content: string; numLines: number; startLine: number; totalLines: number }}
  | { type: 'image'; file: { base64: string; type: 'image/jpeg'|'image/png'|...; originalSize: number; dimensions?: {...}}}
  | { type: 'notebook'; file: { filePath: string; cells: NotebookCell[] }}
  | { type: 'pdf'; file: { filePath: string; base64: string; originalSize: number }}
  | { type: 'parts'; file: { filePath: string; originalSize: number; count: number; outputDir: string }}
  | { type: 'file_unchanged'; file: { filePath: string }};
```

执行流程：
1. backfillObservableInput：expandPath 规范化路径
2. validateInput：检查 deny rule、UNC 路径跳过、二进制扩展名、设备路径
3. preparePermissionMatcher：matchWildcardPattern
4. checkPermissions：checkReadPermissionForTool
5. call：去重检查 → 类型分支 → 读取 → 缓存 → 返回
6. mapToolResultToToolResultBlockParam：根据 type 渲染不同消息

#### FileWriteTool 入口

```typescript
type Input = {
  file_path: string;           // 绝对路径
  content: string;             // 完整内容
};

type Output = {
  type: 'create' | 'update';
  filePath: string;
  content: string;
  structuredPatch: PatchHunk[];
  originalFile: string | null;
  gitDiff?: ToolUseDiff;
};
```

执行流程：
1. backfillObservableInput：expandPath
2. validateInput：检查 team memory secrets、deny rule、UNC 跳过、readFileState 存在且 mtime ≤ 缓存
3. preparePermissionMatcher：matchWildcardPattern
4. checkPermissions：checkWritePermissionForTool
5. call：mkdir 父目录 → fileHistoryTrackEdit → 临界区：readFileSyncWithMetadata + 二次 mtime 检查 + writeTextContent → LSP 通知 → 更新 readFileState
6. mapToolResultToToolResultBlockParam：简单确认消息

#### FileEditTool 入口

```typescript
type Input = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;       // 默认 false
};

type Output = {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch: PatchHunk[];
  userModified: boolean;
  replaceAll: boolean;
  gitDiff?: ToolUseDiff;
};
```

执行流程类似 FileWrite，关键差异：
- validateInput 中先读取文件验证 old_string 存在
- 使用 findActualString 做引号规范化
- 使用 getPatchForEdit 生成 patch
- 1GiB 文件大小限制

#### GlobTool 入口

```typescript
type Input = {
  pattern: string;
  path?: string;
};

type Output = {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
};
```

#### GrepTool 入口

```typescript
type Input = {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-B'?: number;
  '-A'?: number;
  '-C'?: number;
  context?: number;
  '-n'?: boolean;
  '-i'?: boolean;
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
};
```

#### NotebookEditTool 入口

```typescript
type Input = {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
};
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|------|-----------|---------|------------|----------------|
| FileReadTool | readFileState（添加条目） | 读取各类文件、去重检查 | 权限裁决 | readFileState: Map&lt;path, {content, timestamp, offset, limit}&gt; |
| FileWriteTool | readFileState（更新条目） | 完整替换、创建文件 | Git 合并冲突 | readFileState: Map |
| FileEditTool | readFileState（更新条目） | 精确替换、生成 patch | 自动格式化 | readFileState: Map |
| GlobTool | 无 | 文件名匹配 | 内容搜索 | getGlobExclusionsForPluginCache |
| GrepTool | 无 | 内容搜索、mtime 排序 | 替换功能 | ripGrep() 函数 |
| NotebookEditTool | readFileState（更新条目） | 单元格编辑 | Notebook 执行 | jsonParse/jsonStringify |
| utils/file.ts | 无 | getFileModificationTime、writeTextContent | 权限检查 | 纯函数 |
| utils/fileRead.ts | fileReadCache | readFileSyncWithMetadata | 路径解析 | 纯函数 + 缓存 |
| utils/permissions/filesystem.ts | toolPermissionContext | checkReadPermissionForTool、checkWritePermissionForTool | 文件读取/写入本身 | check*PermissionForTool(toolDef, input, context) |

**readFileState 设计说明：**
- 放在 ToolUseContext 中，跨工具共享
- timestamp 使用 Math.floor(mtimeMs) 避免子毫秒级精度问题（不同文件系统精度不同）
- offset/limit 是可选的：存在表示来自 FileRead，可去重；不存在表示来自 Edit/Write，仅用于并发检测
- 不持久化，仅会话内存中存在

### 4.3 主控制流

#### 完整的读取-编辑流程

```
模型调用 FileRead
  → backfillObservableInput: expandPath
  → validateInput: 检查路径合法性（无 fs 操作，除 UNC 跳过）
  → checkPermissions: 权限检查
  → call:
    → 去重检查：readFileState 有条目且 mtime 相等 → 返回 file_unchanged
    → 否则读取文件（按类型分支）
    → 存入 readFileState: {content, timestamp, offset, limit}
    → 返回完整输出
  → mapToolResultToToolResultBlockParam: 渲染给模型

...（模型处理）...

模型调用 FileEdit
  → backfillObservableInput: expandPath
  → validateInput:
    → 检查 readFileState 有该文件条目
    → 检查 mtime ≤ 缓存 mtime（如果 mtime >，Windows 上回退内容比较）
    → 读取文件验证 old_string 存在（用 findActualString 规范化）
  → checkPermissions: 权限检查
  → call:
    → mkdir 父目录（在临界区外！）
    → fileHistoryTrackEdit（在临界区外！）
    → 临界区开始（避免 async 操作）：
      → readFileSyncWithMetadata（同步读，避免并发变更）
      → 二次检查 mtime ≤ 缓存（如果 mtime >，Windows 回退内容比较）
      → findActualString + preserveQuoteStyle
      → getPatchForEdit 生成 patch
      → writeTextContent（直接用模型换行符）
    → LSP 通知（didChange + didSave）
    → 更新 readFileState（offset: undefined, limit: undefined）
    → countLinesChanged（统计变更行数）
  → mapToolResultToToolResultBlockParam: 渲染确认消息
```

#### PDF 读取分支

```
FileRead 检测到 .pdf
  → 有 pages 参数？
    → 是 → extractPDFPages → 返回 type: 'parts' → 新消息中包含页面图片
    → 否 → getPDFPageCount
      → 页数 > PDF_AT_MENTION_INLINE_THRESHOLD？
        → 是 → 报错要求 pages 参数
        → 否 → isPDFSupported？
          → 否 → 报错（要求 pages + poppler-utils）
          → 是 → readPDF → 返回 type: 'pdf' → 新消息中包含 document block
```

#### Grep 执行分支

```
GrepTool.call
  → 构建 ripgrep args：
    → --hidden（包含隐藏文件）
    → --glob '!.git' --glob '!.svn'...（排除 VCS 目录）
    → --max-columns 500（避免长行污染）
    → -i/-A/-B/-C/-n 等（按输入参数）
  → ripGrep(args, path, signal) 执行
  → output_mode 分支：
    → content → applyHeadLimit → relativize 路径 → 返回
    → count → applyHeadLimit → relativize → 解析计数 → 返回
    → files_with_matches → Promise.allSettled(stat) → 按 mtime 排序 → applyHeadLimit → relativize → 返回
```

### 4.4 数据结构与持久化

#### 核心数据结构

```typescript
// readFileState 条目
type ReadFileStateEntry = {
  content: string;
  timestamp: number;          // Math.floor(mtimeMs)
  offset?: number;            // FileRead 才有，用于去重
  limit?: number;
  isPartialView?: boolean;    // 是否是部分视图（来自其他来源）
};

// ToolUseContext 中的 readFileState
type ReadFileState = Map<string, ReadFileStateEntry>;

// FileEdit 输入（简化）
type FileEditInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

// Grep 输出
type GrepOutput = {
  mode: 'content' | 'files_with_matches' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
};
```

#### 持久化与恢复

- **readFileState**：不持久化，仅内存中存在，会话结束丢失
- **文件历史**：fileHistoryTrackEdit 有自己的持久化（本 spec 不负责）
- **写入策略**：writeTextContent 直接写入，不使用临时文件+原子 rename（简单，但崩溃时可能有不完整文件）
- **mtime 回退**：Windows 上 mtime 变了但内容相同时，不报错，继续编辑

### 4.5 跨子系统依赖

| 依赖 | 用途 | 本 spec 中的使用点 | 负责的 spec |
|-----|------|------------------|------------|
| checkReadPermissionForTool | 读取权限检查 | FileRead.validateInput 后调用 | 权限 spec |
| checkWritePermissionForTool | 写入权限检查 | FileWrite/FileEdit/NotebookEdit.validateInput 后调用 | 权限 spec |
| getFsImplementation | 文件系统抽象 | 所有文件操作都通过它 | 工具框架 spec |
| jsonParse/jsonStringify | JSON 解析/序列化 | NotebookEditTool | 慢操作 spec |
| fileHistoryTrackEdit | 文件历史备份 | FileWrite/FileEdit/NotebookEdit.call | 文件历史 spec |
| ripGrep | ripgrep 封装 | GrepTool.call | 本 spec |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|---------------|--------------|-------------|
| 文件不存在（ENOENT） | FileRead.call（外层 try/catch） | 尝试替代截图路径 → 失败后 throw Error | 否（替代路径是一次额外尝试） | 无 | "File does not exist. Did you mean ...?" |
| 文件不存在（ENOENT） | FileEdit.validateInput | return {result: false, message: ..., errorCode: 4} | 否 | 无 | 工具被拒绝，显示错误消息 |
| 并发修改检测失败（mtime > 缓存） | FileWrite.validateInput | return {result: false, message: ..., errorCode: 3} | 否 | 无 | 工具被拒绝，要求重新读取 |
| 并发修改检测失败（二次检查） | FileEdit.call | throw Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR) | 否 | 未写入（临界区先检查后写） | 工具执行失败，显示错误 |
| old_string 未找到 | FileEdit.validateInput | return {result: false, message: ..., errorCode: 8} | 否 | 无 | 工具被拒绝，显示未找到 |
| old_string 多个匹配且 replace_all=false | FileEdit.validateInput | return {result: false, message: ..., errorCode: 9} | 否 | 无 | 工具被拒绝，要求更精确的 old_string |
| 文件超过 1GiB | FileEdit.validateInput | return {result: false, message: ..., errorCode: 10} | 否 | 无 | 工具被拒绝 |
| PDF 页数超过阈值且无 pages 参数 | FileRead.call | throw Error | 否 | 无 | "This PDF has N pages, which is too many to read at once. Use the pages parameter..." |
| ripgrep 超时 | GrepTool.call | throw RipGrepTimeoutError | 否 | 无 | 工具执行失败 |
| Notebook 不是有效 JSON | NotebookEdit.validateInput | return {result: false, message: ..., errorCode: 6} | 否 | 无 | 工具被拒绝 |
| 设备文件（/dev/zero 等） | FileRead.validateInput | return {result: false, message: ..., errorCode: 9} | 否 | 无 | 工具被拒绝 |
| UNC 路径安全检查 | 所有工具 validateInput | 跳过 fs 操作，仅做路径检查 | 不适用 | 无 | validateInput 返回 {result: true} 提前 |
| 图片 token 超限 | FileRead.readImageWithTokenBudget | 先尝试压缩 → 仍超限则 fallback | 压缩是一次重试 | 无 | 返回压缩后的图片 |

### 工程取舍说明

**取舍 1：临界区不包含 async 操作**
- 理由：async 操作会让出事件循环，允许并发变更在检查和写入之间发生
- 代价：需要把 mkdir、fileHistoryTrackEdit 等移到临界区外
- 证据：`src/tools/FileEditTool/FileEditTool.ts:428-442` 注释说明

**取舍 2：FileWrite 直接用模型输出换行符，不保留原文件换行符**
- 理由：之前实现会静默把 LF 改成 CRLF，破坏 Linux 上的 bash 脚本
- 代价：跨平台编辑可能导致换行符不一致
- 证据：`src/tools/FileWriteTool/FileWriteTool.ts:300-308` 注释 + writeTextContent 实现

**取舍 3：Grep 默认限制 250 行，head_limit=0 为无限**
- 理由：无限制搜索可能填满整个 context
- 代价：模型可能需要多次调用（用 offset 分页）
- 证据：`src/tools/GrepTool/GrepTool.ts:107-128` applyHeadLimit 实现

**取舍 4：FileRead 去重仅对精确 offset/limit 匹配生效**
- 理由：不同 range 的读取结果不同，不能去重
- 代价：可能漏掉部分可去重的场景（如先读 1-100，再读 1-50）
- 证据：`src/tools/FileReadTool/FileReadTool.ts:548-552` rangeMatch 检查

## 6. 现状验收标准

### FileRead 验收

1. 给定已读取过且未修改的文件，当调用 FileRead 相同 offset/limit 时，系统必须返回 file_unchanged stub，且不得重复发送完整内容。
2. 给定 macOS 截图路径，当文件不存在时，系统必须尝试替代空格格式（thin space ↔ 普通空格）。
3. 给定 PDF 文件，当页数超过阈值且无 pages 参数时，系统必须报错并要求指定页面范围。
4. 给定设备文件（/dev/zero、/dev/random 等），当尝试读取时，系统必须在 validateInput 阶段拒绝。
5. 给定 UNC 路径（\\server\share\file.txt），当验证输入时，系统必须跳过所有 fs 操作。

### FileEdit 验收

1. 给定文件在读取后被外部修改（mtime 更新），当尝试编辑时，系统必须在 validateInput 阶段拒绝。
2. 给定 Windows 上文件 mtime 更新但内容未变，当尝试编辑时，系统必须允许继续（内容比较回退）。
3. 给定 old_string 使用单引号但文件中是双引号，当尝试编辑时，系统必须找到匹配并正确替换。
4. 给定 old_string 在文件中出现多次且 replace_all=false，当尝试编辑时，系统必须拒绝并要求更精确的上下文。
5. 给定文件超过 1GiB，当尝试编辑时，系统必须在 validateInput 阶段拒绝。

### FileWrite 验收

1. 给定文件未被读取过，当尝试写入时，系统必须在 validateInput 阶段拒绝。
2. 给定新文件创建（不存在），当写入时，系统必须创建父目录并正常完成。
3. 给定写入 CLAUDE.md，当完成时，系统必须记录 tengu_write_claudemd 分析事件。

### Grep 验收

1. 给定搜索有多个匹配文件，当返回结果时，系统必须按 mtime 降序排序（最新修改在前）。
2. 给定未指定 head_limit，当返回结果时，系统必须限制为 250 行。
3. 给定 head_limit=0，当返回结果时，系统必须不限制结果行数。
4. 给定搜索 .git 目录中的文件，当执行时，系统必须自动排除（不返回结果）。

### NotebookEdit 验收

1. 给定 Notebook 文件未被读取过，当尝试编辑时，系统必须在 validateInput 阶段拒绝。
2. 给定 replace 模式且 cellIndex === cells.length，当编辑时，系统必须自动切换到 insert 模式。
3. 给定 nbformat >= 4.5，当插入新单元格时，系统必须生成随机 cell_id。
4. 给定代码单元格被编辑，当保存时，系统必须重置 execution_count 并清空 outputs。

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| FileRead 基于 mtime 去重，返回 file_unchanged stub | `src/tools/FileReadTool/FileReadTool.ts:524-573` | 无直接测试（功能通过遥测验证：tengu_file_read_dedup） | killswitch 可禁用此功能 |
| FileEdit 先 mtime 检查，Windows 回退内容比较 | `src/tools/FileEditTool/FileEditTool.ts:289-311, 451-468` | 无直接测试 | 仅对完整读取（offset/limit undefined）的条目做内容比较回退 |
| FileEdit 使用 findActualString 做引号规范化 | `src/tools/FileEditTool/utils.ts` | 无直接测试 | 仅匹配边界引号，不匹配字符串中间 |
| FileWrite/FileEdit 临界区不含 async 操作 | `src/tools/FileEditTool/FileEditTool.ts:428-442` 注释 | 无直接测试 | mkdir、fileHistoryTrackEdit 明确在临界区外 |
| Grep 按 mtime 降序排序结果 | `src/tools/GrepTool/GrepTool.ts:529-553` | 测试中按文件名排序（NODE_ENV=test 分支） | 测试环境行为与生产不同 |
| Grep 默认限制 250 行 | `src/tools/GrepTool/GrepTool.ts:107-128` | 无直接测试 | head_limit=0 显式请求无限 |
| UNC 路径跳过 fs 操作 | `src/tools/FileReadTool/FileReadTool.ts:463-467`，其他工具类似 | 无直接测试 | 仅 skip fs 操作，权限检查仍执行 |
| 设备文件被禁止读取 | `src/tools/FileReadTool/FileReadTool.ts:96-128` | 无直接测试 | 仅 path-based 检查，不打开文件 |
| NotebookEdit 重置 execution_count 并清空 outputs | `src/tools/NotebookEditTool/NotebookEditTool.ts:420-424` | 无直接测试 | 仅对代码单元格生效 |
| PDF 分支处理：pages、页数阈值、内联/提取 | `src/tools/FileReadTool/FileReadTool.ts:894-1017` | 无直接测试 | 依赖 poppler-utils 进行页面提取 |
| 图片 token 预算压缩 | `src/tools/FileReadTool/FileReadTool.ts:1097-1183` | 无直接测试 | 仅一次压缩尝试，失败则用原始 |
| writeTextContent 不自动规范化换行符 | `src/utils/file.ts:84-98` | 无直接测试 | 之前实现相反，此为修复 |
| readFileState 条目区分 Read 与 Edit/Write（offset 是否存在） | `src/tools/FileReadTool/FileReadTool.ts:549-551`，`src/tools/FileEditTool/FileEditTool.ts:537-542` | 无直接测试 | Edit/Write 设置 offset: undefined 以防止 Read 去重匹配 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/file-tools.yaml)

### 覆盖分组职责说明

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|------|-----------|------------------|----------------|
| file-read-tool | FileReadTool 实现、类型分支、去重 | 无直接测试 | 权限系统（utils/permissions/filesystem.ts） |
| file-write-tool | FileWriteTool 实现、并发检测 | 无直接测试 | Git 集成（fetchSingleFileGitDiff） |
| file-edit-tool | FileEditTool 实现、精确替换、引号规范化 | 无直接测试 | 通用 diff 库 |
| glob-tool | GlobTool 实现、文件名匹配 | 无直接测试 | 权限系统 |
| grep-tool | GrepTool 实现、ripgrep 集成、mtime 排序 | 无直接测试 | ripgrep 二进制本身 |
| notebook-edit-tool | NotebookEditTool 实现、单元格操作 | 无直接测试 | Jupyter 执行引擎 |
| file-utils | 共享文件操作、mtime 处理、换行符 | 无直接测试 | 路径解析（utils/path.ts） |
| notebook-pdf-image-utils | 特殊文件类型处理 | 无直接测试 | poppler-utils、sharp 等外部依赖 |
| search-utils | glob 匹配、ripgrep 封装 | 无直接测试 |  |
| permission-utils | 文件权限检查（仅描述调用契约） | 无直接测试 | 权限裁决逻辑（由权限 spec 主拥有） |

### 相关子系统

- **权限系统**：负责文件访问控制，本 spec 仅描述工具如何调用 checkReadPermissionForTool/checkWritePermissionForTool
- **查询核心**：readFileState 在 ToolUseContext 中传递，由 QueryEngine 管理
- **文件历史**：fileHistoryTrackEdit 用于备份，本 spec 仅描述调用点
- **LSP 集成**：文件编辑后通知 LSP 服务器，本 spec 仅描述通知调用

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|---------|-------|-------|
| P2 | FileEdit 当前一次只能编辑一个块，模型经常需要多次调用才能完成重构 | 支持批量 edits 输入（数组形式） | 中等：需要确保所有 edits 都匹配才执行 | 给定多个 old_string/new_string 对，当全部匹配时执行，否则拒绝 | M | 已证实（模型行为模式） |
| P2 | Grep 仅能搜索，不能替换，模型经常需要 Grep → Read → FileEdit 循环 | 添加 sed-style 替换功能（可选） | 低：作为新工具添加 | 给定 pattern 和 replacement，当执行时替换所有匹配 | M | 设计推断 |
| P2 | FileRead 去重仅对精确 offset/limit 生效，无法处理先读全文件再读部分的情况 | 扩展去重逻辑支持包含关系（读取范围在缓存范围内时返回 stub） | 中等：需要正确处理行号 | 给定先读 1-100 再读 1-50，当文件未修改时返回 stub | S | 设计推断 |
| P3 | 当前无单元测试覆盖并发修改检测逻辑 | 添加针对并发修改检测的测试 | 低：仅添加测试 | 测试模拟 mtime 更新但内容不变、mtime 更新且内容改变等场景 | M | 已证实（代码存在但无测试） |
| P3 | Grep 测试环境按文件名排序而非 mtime，与生产不一致 | 统一测试与生产行为，或显式注入排序函数 | 低：仅测试相关 | 测试可以验证结果顺序正确 | S | 已证实（代码中有 NODE_ENV=test 分支） |
| P2 | 跨层：ReviewArtifact 权限委托边界缺陷（主修复见 review-analysis spec） | - | - | 遵循 review-analysis spec 验收标准，确保与权限系统集成正确 | S | 跨层说明 |

### 优先级说明

- **P2**：局部可维护性、体验改进、测试缺口。不影响核心正确性，但能提升效率。
- **P3**：可选体验、测试完善。明确非紧急，可延后处理。
