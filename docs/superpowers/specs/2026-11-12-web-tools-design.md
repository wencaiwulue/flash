---
id: web-tools
batch: 7
title: Web Tools 搜索、抓取与内容处理设计
date: 2026-11-12
status: draft
---

# Web Tools 搜索、抓取与内容处理设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理"、"提高可靠性"、"保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

Web 工具系统需要解决以下具体问题：

当模型需要搜索网络或抓取网页时，必须：
1. 处理搜索查询与结果格式，确保模型正确引用来源
2. 安全地抓取 URL 内容，处理重定向、超时、域名黑名单
3. 将 HTML 转换为 Markdown，限制内容长度避免 token 超限
4. 使用小型快速模型对内容进行摘要，平衡质量与速度
5. 区分预批准域名与普通域名，应用不同的内容使用准则
6. 缓存已抓取内容，避免重复请求
7. 处理二进制内容（PDF、图片等）并持久化
8. 防止数据泄露，限制 URL 长度和用户名/密码

如果没有来源引用机制，模型可能使用搜索结果但不注明来源，违反用户信任和版权要求。

如果没有域名安全检查，模型可能尝试抓取内网或恶意域名，带来安全风险。

如果没有内容长度限制，大型网页会填满整个 context，导致后续工具无法使用。

### 调用方与责任边界

调用方：
- 主 QueryEngine 通过 ToolRunner 调用各工具
- WebSearchTool 内部使用 queryModelWithStreaming 执行实际搜索
- WebFetchTool 内部使用 queryHaiku 进行内容摘要

责任边界：
- WebSearchTool：搜索查询、结果处理、来源引用要求
- WebFetchTool：URL 抓取、重定向处理、内容转换、模型摘要
- BriefTool：用户消息传递（本 spec 简要提及，非核心）
- 权限系统（utils/permissions/）：访问控制

### 实际约束

安全与隐私约束：
- URL 最大长度 2000 字符（防止数据泄露）
- 禁止包含用户名/密码的 URL
- 禁止单段主机名（内网）
- 域名黑名单检查通过 api.anthropic.com
- 预批准域名仅适用于 WebFetch，不适用于 sandbox 网络访问

性能与体验约束：
- 抓取超时 60 秒
- 域名检查超时 10 秒
- 最大 10 次同主机重定向
- 最大 HTTP 内容长度 10MB
- Markdown 内容截断为 100,000 字符
- URL 缓存 15 分钟 TTL，最大 50MB
- 域名检查缓存 5 分钟 TTL，最大 128 条目

平台与可用性约束：
- WebSearch 仅在美国可用
- WebSearch 仅在 firstParty、Vertex（Claude 4+）、Foundry 模式启用
- WebFetch 优先使用 MCP 工具（如果可用）

### 内部/外部差异

WebSearchTool 在不同 provider 下的启用逻辑不同：
- firstParty：总是启用
- Vertex：仅 Claude 4+ 模型
- Foundry：总是启用
- 其他：禁用

WebFetchTool 在所有模式下行为一致，但预批准域名列表在内外 build 相同（通过 PREAPPROVED_HOSTS）。

## 2. 设计理由与备选方案

### 决策 1：WebSearch 通过 server_tool_use 委托给 Anthropic API，而非直接调用搜索引擎

**实际机制：**
- WebSearchTool.call 构造 queryModelWithStreaming，传入 extraToolSchemas: [makeToolSchema(input)]
- makeToolSchema 返回 {type: 'web_search_20250305', name: 'web_search', allowed_domains, blocked_domains, max_uses: 8}
- 流式监听 content_block_start、content_block_delta、content_block_stop 事件
- 从 input_json_delta 中提取查询用于进度更新
- 从 web_search_tool_result 中提取结果
- 最终通过 makeOutputFromSearchResponse 组装输出

**为什么这样设计：**
- 避免自己管理搜索引擎 API 密钥、配额、缓存
- 利用 API 端已有的搜索质量优化、来源验证、内容安全过滤
- max_uses: 8 限制单次工具调用中的搜索次数，防止滥用

**备选方案及不采用原因：**
- 方案 A：直接调用 Bing/Google Search API → 被否决，需要管理密钥、配额、缓存，且内容安全过滤复杂
- 方案 B：让用户自己配置搜索 API → 被否决，用户体验差，增加配置负担

**代价：**
- 依赖 API 端功能，无法灵活调整搜索行为
- 需要解析流式事件而非简单的请求-响应
- 搜索逻辑部分在 API 端黑盒中，不可见

**证据：**
- `src/tools/WebSearchTool/WebSearchTool.ts:76-83` makeToolSchema
- `src/tools/WebSearchTool/WebSearchTool.ts:268-388` call 中的流式处理
- `src/tools/WebSearchTool/WebSearchTool.ts:178-193` isEnabled 中的 provider 判断

### 决策 2：WebFetch 仅自动跟随同主机（或仅 www 差异）重定向，跨主机重定向返回提示让模型重新调用

**实际机制：**
- getWithPermittedRedirects 递归跟随重定向，但仅当 isPermittedRedirect 返回 true
- isPermittedRedirect 检查：协议相同、端口相同、无用户名密码、主机名 strip www 后相同
- 如果不允许但有重定向，返回 {type: 'redirect', originalUrl, redirectUrl, statusCode}
- WebFetchTool.call 检测到 redirect 类型，返回人类可读的消息，提示使用 WebFetch 重新调用 redirectUrl

**为什么这样设计：**
- 安全：防止攻击者构造 open redirect 让 Claude 访问内网域名（如 `https://trusted.com → https://internal/admin`）
- 透明：让模型知道发生了重定向，可以决定是否继续
- 权限一致：新域名需要重新经过权限检查

**备选方案及不采用原因：**
- 方案 A：自动跟随所有重定向 → 被否决，安全风险高
- 方案 B：完全禁止重定向 → 被否决，太多合法网站使用重定向（如 http→https、www 与非 www）
- 方案 C：询问用户 → 被否决，交互繁琐，影响体验

**代价：**
- 模型需要多一轮工具调用才能获取内容
- 增加实现复杂度（需要检测和返回重定向信息）

**证据：**
- `src/tools/WebFetchTool/utils.ts:212-243` isPermittedRedirect
- `src/tools/WebFetchTool/utils.ts:262-329` getWithPermittedRedirects
- `src/tools/WebFetchTool/WebFetchTool.ts:217-248` 重定向检测与返回

### 决策 3：预批准域名列表与沙箱网络隔离分离，WebFetch 自动允许但 sandbox 仍需权限

**实际机制：**
- PREAPPROVED_HOSTS 包含大量技术文档域名（docs.python.org、developer.mozilla.org、react.dev 等）
- isPreapprovedHost(pathname) 精确匹配或路径前缀匹配（如 github.com/anthropics）
- WebFetch.checkPermissions 检测到预批准域名直接返回 {behavior: 'allow'}
- 但 sandbox 网络限制**不**继承此列表（有测试验证：test/utils/sandbox/webfetch-preapproved-separated.test.ts）

**为什么这样设计：**
- 预批准域名都是技术文档，抓取风险低，用户体验优先
- 但 sandbox 允许任意网络请求（POST、上传等），不能自动允许，防止数据泄露
- 职责分离：WebFetch 是只读 GET，风险低；sandbox 是任意网络，风险高

**备选方案及不采用原因：**
- 方案 A：无预批准列表，所有域名都需要用户授权 → 被否决，太繁琐，技术文档是高频场景
- 方案 B：sandbox 也继承预批准列表 → 被否决，安全风险太高（如 huggingface.co 允许上传）
- 方案 C：预批准列表同时允许 GET 和 POST → 被否决，POST 风险高

**代价：**
- 需要维护两个独立的安全策略
- 用户可能困惑为什么 WebFetch 可以访问某域名但 sandbox 不行

**证据：**
- `src/tools/WebFetchTool/preapproved.ts:14-131` PREAPPROVED_HOSTS
- `src/tools/WebFetchTool/preapproved.ts:136-166` isPreapprovedHost（路径前缀匹配）
- `src/tools/WebFetchTool/WebFetchTool.ts:110-118` 预批准域名检查
- `src/tools/WebFetchTool/prompt.ts:28-46` 预批准与非预批准域名的不同指南

### 决策 4：内容缓存按原始 URL 键，域名检查缓存按主机名键，TTL 不同

**实际机制：**
- URL_CACHE: LRUCache<string, CacheEntry>，键是原始 URL，TTL 15 分钟，最大 50MB
- DOMAIN_CHECK_CACHE: LRUCache<string, true>，键是主机名，TTL 5 分钟，最大 128 条目
- 缓存命中时直接返回，不重新请求
- 缓存条目包含转换后的 Markdown、HTTP 状态码、持久化二进制路径等

**为什么这样设计：**
- URL_CACHE 避免重复抓取相同内容，节省时间和网络
- DOMAIN_CHECK_CACHE 避免同一主机多个路径时重复调用 api.anthropic.com
- 域名检查 TTL 更短（5 分钟 vs 15 分钟），因为黑名单可能更新更频繁
- LRU 自动驱逐旧条目，防止内存泄漏

**备选方案及不采用原因：**
- 方案 A：无缓存 → 被否决，太慢且浪费网络
- 方案 B：两个缓存 TTL 相同 → 被否决，域名检查 TTL 应该更短
- 方案 C：持久化缓存到磁盘 → 被否决，隐私顾虑，且实现复杂

**代价：**
- 内存占用（最多 50MB）
- 可能返回略过时的内容（15 分钟窗口）

**证据：**
- `src/tools/WebFetchTool/utils.ts:51-83` 缓存定义与 clearWebFetchCache
- `src/tools/WebFetchTool/utils.ts:356-366` URL_CACHE 命中检查
- `src/tools/WebFetchTool/utils.ts:479-481` URL_CACHE 写入

### 决策 5：非预批准域名强制使用 Haiku 摘要并限制引用长度，预批准域名允许完整返回且更宽松的引用

**实际机制：**
- isPreapproved 检查域名
- 如果是预批准 && 内容类型是 text/markdown && 长度 < MAX_MARKDOWN_LENGTH → 直接返回内容
- 否则调用 applyPromptToMarkdown → queryHaiku
- makeSecondaryModelPrompt 传递不同指南：
  - 预批准：简洁响应，包含相关细节、代码示例、文档摘录
  - 非预批准：仅基于内容，引用最大 125 字符，使用引号，不评论合法性，不复制歌词

**为什么这样设计：**
- 安全：非预批准域名可能有版权敏感内容，限制直接复制
- 质量：预批准域名都是技术文档，直接返回更准确
- 成本：Haiku 比主模型便宜且快

**备选方案及不采用原因：**
- 方案 A：所有域名都直接返回 → 被否决，版权风险
- 方案 B：所有域名都摘要 → 被否决，技术文档场景质量下降
- 方案 C：让用户选择 → 被否决，增加交互负担

**代价：**
- 需要维护预批准域名列表
- 非预批准域名的摘要可能丢失细节

**证据：**
- `src/tools/WebFetchTool/WebFetchTool.ts:264-278` 分支逻辑
- `src/tools/WebFetchTool/prompt.ts:28-46` makeSecondaryModelPrompt
- `src/tools/WebFetchTool/utils.ts:484-530` applyPromptToMarkdown

### 决策 6：二进制内容（PDF 等）同时保存到磁盘并尝试文本摘要，两者都返回给模型

**实际机制：**
- isBinaryContentType 检测二进制内容
- persistBinaryContent 保存到临时目录，返回路径
- 同时仍然执行 rawBuffer.toString('utf-8') → Turndown → Haiku 摘要
- 结果中附加：`[Binary content (${contentType}, ${formatFileSize(...)} also saved to ${persistedPath}]`

**为什么这样设计：**
- 鲁棒性：PDF 等二进制的 UTF-8 解码可能仍有可提取文本（如 /Title、文本流）
- 补充：如果摘要不够，模型可以使用其他工具（如 FileRead）读取持久化的二进制文件
- 用户体验：持久化文件允许用户直接查看原始内容

**备选方案及不采用原因：**
- 方案 A：仅保存文件，不摘要 → 被否决，模型无法直接使用内容
- 方案 B：仅摘要，不保存 → 被否决，模型可能需要查看原始二进制（如 PDF 页面）
- 方案 C：尝试用专门的 PDF 解析库 → 被否决，增加依赖复杂度

**代价：**
- 磁盘占用（临时文件）
- 有时摘要质量低（如果二进制 UTF-8 解码乱码）

**证据：**
- `src/tools/WebFetchTool/utils.ts:440-449` 二进制持久化
- `src/tools/WebFetchTool/utils.ts:451-466` 仍然解码为文本并转换
- `src/tools/WebFetchTool/WebFetchTool.ts:283-285` 结果中附加持久化路径

### 决策 7：URL 最大长度从 250 增加到 2000，保留其他安全检查

**实际机制：**
- validateURL 检查：长度 ≤ 2000、无用户名密码、主机名至少两段（不是单段内网名）
- 注释说明：250 太严格，某些合法场景需要长 URL（如 JWT 签名的云服务 URL）
- 仍然需要每个域名的用户批准，这是主要安全边界

**为什么这样设计：**
- 250 太严格，用户反馈合法 URL 被拒绝
- 主要安全边界是域名权限检查，不是 URL 长度
- 其他数据泄露渠道存在，URL 长度限制不是主要防线

**备选方案及不采用原因：**
- 方案 A：保持 250 → 被否决，用户体验差
- 方案 B：完全移除长度限制 → 被否决，仍有一定风险（如非常长的查询参数用于数据泄露）
- 方案 C：根据域名动态调整 → 被否决，太复杂

**代价：**
- 略微增加数据泄露风险（但主要防线仍是域名权限）

**证据：**
- `src/tools/WebFetchTool/utils.ts:99-106` 注释说明
- `src/tools/WebFetchTool/utils.ts:139-170` validateURL 实现

### 决策 8：WebSearch 要求模型必须在响应末尾包含 Sources 部分，列出所有相关 URL

**实际机制：**
- WebSearchTool.prompt() 返回的指南明确要求：
  - "After answering the user's question, you MUST include a 'Sources:' section at the end of your response"
  - "In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](https://example.com)"
  - "This is MANDATORY - never skip including sources in your response"
- mapToolResultToToolResultBlockParam 返回的结果中也提醒："REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks."

**为什么这样设计：**
- 透明度：用户知道信息来源
- 版权：尊重内容创作者
- 可信度：可以验证信息准确性

**备选方案及不采用原因：**
- 方案 A：不要求来源 → 被否决，透明度和版权问题
- 方案 B：自动在工具结果中附加来源，不依赖模型 → 被否决，模型可能不使用所有结果，自动附加会混乱

**代价：**
- 依赖模型遵循指令，可能偶尔失败

**证据：**
- `src/tools/WebSearchTool/prompt.ts:14-33` getWebSearchPrompt
- `src/tools/WebSearchTool/WebSearchTool.ts:426-428` mapToolResultToToolResultBlockParam 中的提醒

### 决策 9：使用 Turndown 懒加载单例转换 HTML→Markdown，避免重复初始化

**实际机制：**
- getTurndownService() 返回一个 Promise<InstanceType<TurndownCtor>>
- 第一次调用时动态 import('turndown')，后续返回缓存的实例
- 注释说明：懒加载避免在不需要 WebFetch 时加载 1.4MB 的 domino 依赖

**为什么这样设计：**
- 性能：Turndown + domino 较大，懒加载减少启动时间和内存占用
- 简洁：单例避免重复创建 Turndown 实例（初始化会构建 15 个规则对象）

**备选方案及不采用原因：**
- 方案 A：启动时加载 → 被否决，影响启动时间
- 方案 B：每次调用创建新实例 → 被否决，浪费内存且慢

**代价：**
- 第一次调用有轻微延迟（动态 import）

**证据：**
- `src/tools/WebFetchTool/utils.ts:88-97` getTurndownService
- `src/tools/WebFetchTool/utils.ts:457` 使用处

## 3. 目标与非目标

### 状态与生命周期

**目标：**
- URL_CACHE 15 分钟 TTL，50MB 限制，LRU 自动驱逐
- DOMAIN_CHECK_CACHE 5 分钟 TTL，128 条目限制，仅缓存允许的域名
- Turndown 单例懒加载，会话期间复用
- 持久化二进制文件保存到临时目录，由 mcpOutputStorage 管理生命周期

**非目标：**
- 不持久化 URL_CACHE 到磁盘（仅内存）
- 不提供缓存失效 API（仅 TTL 和 LRU）
- 不负责临时文件的长期持久化（由 mcpOutputStorage 管理）

### 接口与数据

**目标：**
- 所有工具输入输出有 zod schema 验证
- WebSearch 输入：query、allowed_domains、blocked_domains（但两者不能同时使用）
- WebSearch 输出：query、results（混合 SearchResult 对象和字符串注释）、durationSeconds
- WebFetch 输入：url、prompt
- WebFetch 输出：bytes、code、codeText、result、durationMs、url
- mapToolResultToToolResultBlockParam 将工具输出转换为模型可见的消息

**非目标：**
- 不保证向后兼容旧 schema（但会通过 lazySchema 延迟求值）
- 不提供通用的 HTML 解析库（仅内部使用 Turndown）

### 执行与环境

**目标：**
- validateInput 在权限检查前执行，无网络操作
- 权限检查：WebSearch 总是 passthrough 但建议 addRules；WebFetch 检查预批准或域名规则
- call 中的网络请求带超时：抓取 60 秒，域名检查 10 秒
- 同主机重定向最多 10 跳

**非目标：**
- 不做网页交互（如点击按钮、填写表单）
- 不执行 JavaScript（仅获取静态 HTML）
- 不处理认证页面（cookies、登录等）

### 依赖边界

- **权限系统**：本 spec 描述调用契约，主设计由权限 spec 负责
- **工具框架**（`src/Tool.ts`）：本 spec 仅描述各工具的 buildTool 使用，不描述 Tool 接口本身
- **Claude API**（`src/services/api/claude.ts`）：queryModelWithStreaming、queryHaiku 是外部依赖
- **分析事件**（`src/services/analytics/index.ts`）：logEvent 调用仅用于遥测，不影响核心行为
- **MCP 输出存储**（`src/utils/mcpOutputStorage.ts`）：二进制内容持久化，本 spec 仅描述调用点

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

#### WebSearchTool 入口

```typescript
type Input = {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
};

type SearchResult = {
  tool_use_id: string;
  content: Array<{title: string; url: string}>;
};

type Output = {
  query: string;
  results: Array<SearchResult | string>;
  durationSeconds: number;
};
```

执行流程：
1. validateInput：检查 query 非空，allowed_domains 与 blocked_domains 不同时使用
2. checkPermissions：返回 passthrough，建议添加规则
3. call：
   - 构造 userMessage: "Perform a web search for the query: " + query
   - 构造 extraToolSchemas: [{type: 'web_search_20250305', ...}]
   - queryModelWithStreaming 流式调用
   - 监听 server_tool_use 事件，从 input_json_delta 提取查询用于进度更新
   - 监听 web_search_tool_result 事件，收集结果
   - makeOutputFromSearchResponse 组装输出
4. mapToolResultToToolResultBlockParam：格式化结果，提醒必须包含 Sources

#### WebFetchTool 入口

```typescript
type Input = {
  url: string;
  prompt: string;
};

type Output = {
  bytes: number;
  code: number;
  codeText: string;
  result: string;
  durationMs: number;
  url: string;
};
```

执行流程：
1. validateInput：检查 URL 可解析
2. checkPermissions：检查预批准域名 → 检查域名规则
3. call：
   - getURLMarkdownContent(url, abortController)
     - validateURL(url)
     - 检查 URL_CACHE 命中
     - 升级 http→https
     - 检查域名黑名单（除非 skipWebFetchPreflight）
     - getWithPermittedRedirects 跟随同主机重定向
     - 检测二进制内容，持久化到磁盘
     - HTML→Markdown 转换（Turndown）或直接使用文本
     - 存入 URL_CACHE
   - 如果是 redirect → 返回提示信息
   - 否则：检查预批准+markdown+长度 → 直接返回或 applyPromptToMarkdown
   - 如果有持久化二进制 → 附加路径信息
4. mapToolResultToToolResultBlockParam：返回摘要结果

#### BriefTool 入口（简要提及）

```typescript
type Input = {
  message: string;
  attachments?: string[];
  status: 'normal' | 'proactive';
};
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|------|-----------|---------|------------|----------------|
| WebSearchTool | 无 | 搜索查询、流式事件解析、结果组装 | 实际搜索执行（API 端） | queryModelWithStreaming |
| WebFetchTool | URL_CACHE、DOMAIN_CHECK_CACHE | URL 抓取、重定向处理、HTML→Markdown、模型摘要 | 网页交互、JavaScript 执行 | queryHaiku、isPreapprovedHost |
| WebFetchTool/utils | Turndown 单例（模块级变量） | validateURL、checkDomainBlocklist、getWithPermittedRedirects、getURLMarkdownContent、applyPromptToMarkdown | 权限裁决 | getWebFetchUserAgent、isBinaryContentType |
| WebFetchTool/preapproved | PREAPPROVED_HOSTS（模块级常量） | isPreapprovedHost | 沙箱网络控制 | 纯函数 |
| BriefTool | 无 | 用户消息传递、附件解析 | 对话管理 | resolveAttachments |

**缓存设计说明：**
- URL_CACHE: LRUCache，键是原始 URL，值包含转换后的 Markdown、HTTP 状态、持久化路径等
- DOMAIN_CHECK_CACHE: LRUCache，键是主机名，仅缓存 `{status: 'allowed'}` 的结果（blocked/check_failed 不缓存）
- 两者都是模块级变量，会话期间持久化，重启丢失
- clearWebFetchCache 可清空两者（供测试或用户手动使用）

### 4.3 主控制流

#### WebSearch 完整流程

```
模型调用 WebSearch
  → validateInput:
    → query 非空检查
    → allowed_domains 与 blocked_domains 不同时使用检查
  → checkPermissions:
    → 返回 {behavior: 'passthrough', suggestions: [{type: 'addRules', ...}]}
  → call:
    → 构造 userMessage + extraToolSchemas
    → queryModelWithStreaming 流式调用
    → 事件循环：
      → content_block_start:
        → 如果是 server_tool_use → 记录 currentToolUseId
        → 如果是 web_search_tool_result → 提取结果，触发进度更新
      → content_block_delta:
        → 如果 currentToolUseId 存在且是 input_json_delta → 提取 query 用于进度更新
      → content_block_stop:
        → 重置 currentToolUseId
    → makeOutputFromSearchResponse 组装结果：
      → 遍历 content blocks，聚合文本和搜索结果
  → mapToolResultToToolResultBlockParam:
    → 格式化结果为可读文本
    → 追加 REMINDER 要求包含 Sources
```

#### WebFetch 完整流程

```
模型调用 WebFetch
  → validateInput:
    → 尝试 new URL(url)，失败则拒绝
  → checkPermissions:
    → 检查预批准域名 → 是 → allow
    → 否则检查域名规则 → 有 allow/deny → 相应返回
    → 否则 ask
  → call:
    → getURLMarkdownContent(url, abortController):
      → validateURL(url):
        → 长度 ≤ 2000
        → 无用户名密码
        → 主机名至少两段
      → URL_CACHE 命中？→ 是 → 直接返回
      → http→https 升级
      → 域名黑名单检查（除非 skipWebFetchPreflight）:
        → DOMAIN_CHECK_CACHE 命中？→ 是 → allow
        → 否则请求 api.anthropic.com
        → 成功且 can_fetch=true → 存入 DOMAIN_CHECK_CACHE
      → getWithPermittedRedirects(upgradedUrl, signal, isPermittedRedirect, 0):
        → axios.get 不带自动重定向
        → 3xx 响应？
          → 是 → 解析 location
            → isPermittedRedirect(originalUrl, redirectUrl)？
              → 是 → 递归调用（depth+1），depth>10 报错
              → 否 → 返回 {type: 'redirect', ...}
          → 否 → 返回响应
      → 响应处理：
        → isBinaryContentType(content-type)？
          → 是 → persistBinaryContent → 记录 persistedPath
        → rawBuffer.toString('utf-8')
        → content-type 是 text/html？
          → 是 → getTurndownService().turndown(html) → markdownContent
          → 否 → markdownContent = htmlContent
        → markdownContent 截断到 100,000 字符
        → 存入 URL_CACHE
    → 结果是 redirect？
      → 是 → 返回提示信息，要求重新调用 WebFetch with redirectUrl
      → 否 → 继续：
        → isPreapproved && content-type is markdown && length < 100,000？
          → 是 → result = markdownContent
          → 否 → applyPromptToMarkdown(prompt, markdownContent, signal, ...):
            → makeSecondaryModelPrompt（区分预批准/非预批准指南）
            → queryHaiku
        → 有 persistedPath？→ 追加到 result
  → mapToolResultToToolResultBlockParam:
    → 返回 result
```

### 4.4 数据结构与持久化

#### 核心数据结构

```typescript
// WebFetch URL 缓存条目
type CacheEntry = {
  bytes: number;
  code: number;
  codeText: string;
  content: string;
  contentType: string;
  persistedPath?: string;
  persistedSize?: number;
};

// 预批准主机路径前缀
type PreapprovedHost = {
  host: string;
  pathPrefix?: string;  // 如 github.com/anthropics
};

// WebSearch 流式事件处理中的临时状态
type StreamState = {
  allContentBlocks: BetaContentBlock[];
  currentToolUseId: string | null;
  currentToolUseJson: string;
  progressCounter: number;
  toolUseQueries: Map<string, string>;  // tool_use_id -> query
};

// WebFetch 重定向信息
type RedirectInfo = {
  type: 'redirect';
  originalUrl: string;
  redirectUrl: string;
  statusCode: number;
};
```

#### 持久化与恢复

- **URL_CACHE、DOMAIN_CHECK_CACHE**：不持久化，仅内存中，会话结束丢失
- **Turndown 单例**：不持久化，会话期间懒加载并复用
- **持久化二进制文件**：保存到 mcpOutputStorage 管理的临时目录，生命周期由其负责
- **域名检查缓存策略**：仅缓存 `{status: 'allowed'}`，blocked/check_failed 不缓存，以便下次重试

### 4.5 跨子系统依赖

| 依赖 | 用途 | 本 spec 中的使用点 | 负责的 spec |
|-----|------|------------------|------------|
| queryModelWithStreaming | WebSearch 内部调用 | WebSearchTool.call | 查询核心 spec |
| queryHaiku | WebFetch 内容摘要 | WebFetchTool.call → applyPromptToMarkdown | 查询核心 spec |
| getMainLoopModel、getSmallFastModel | 模型选择 | WebSearchTool.call（根据 feature flag 选择 Haiku 或主模型） | 模型配置 spec |
| getWebFetchUserAgent | User-Agent 头 | WebFetchTool/utils.ts: axios.get headers | HTTP 工具 spec |
| isBinaryContentType、persistBinaryContent | 二进制内容处理 | WebFetchTool/utils.ts:440-449 | MCP 输出存储 spec |
| getSettings_DEPRECATED | skipWebFetchPreflight 检查 | WebFetchTool/utils.ts:386-398 | 设置 spec |
| getRuleByContentsForTool | 权限规则匹配 | WebFetchTool.checkPermissions | 权限 spec |
| getFeatureValue_CACHED_MAY_BE_STALE | tengu_plum_vx3 flag | WebSearchTool.call:262-265 | 分析/feature flag spec |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|---------------|--------------|-------------|
| URL 长度超过 2000 | WebFetch.validateURL → getURLMarkdownContent 内联检查 | throw Error("Invalid URL") | 否 | 无 | 工具执行失败 |
| URL 包含用户名密码 | validateURL | throw Error("Invalid URL") | 否 | 无 | 工具执行失败 |
| 单段主机名（内网） | validateURL | throw Error("Invalid URL") | 否 | 无 | 工具执行失败 |
| 域名黑名单拦截 | checkDomainBlocklist | throw DomainBlockedError | 否 | 无 | "Claude Code is unable to fetch from ${domain}" |
| 域名检查失败（网络问题） | checkDomainBlocklist | throw DomainCheckFailedError | 否 | 无 | "Unable to verify if domain ${domain} is safe..." |
| 域名检查超时 | axios timeout（10 秒） | throw AxiosError | 否 | 无 | 工具执行失败 |
| 抓取超时 | axios timeout（60 秒） | throw AxiosError | 否 | 无 | 工具执行失败 |
| 超过 10 次同主机重定向 | getWithPermittedRedirects depth 检查 | throw Error("Too many redirects...") | 否 | 无 | 工具执行失败 |
| 跨主机重定向 | isPermittedRedirect 返回 false | 返回 RedirectInfo → WebFetch.call 返回提示消息 | 否（需要模型重新调用） | 无 | "REDIRECT DETECTED: The URL redirects to a different host... Use WebFetch again with ${redirectUrl}" |
| HTTP 错误状态码（4xx/5xx） | axios 正常返回（非 throw） | 返回 code/codeText，内容仍尝试处理 | 否 | 无 | result 包含错误页面内容（如果有） |
| 内容长度超过 10MB | axios maxContentLength | throw AxiosError | 否 | 无 | 工具执行失败 |
| 模型摘要超时/中止 | signal.abort 检查 | throw AbortError | 否 | 无 | 工具执行失败 |
| WebSearch allowed_domains 与 blocked_domains 同时使用 | WebSearch.validateInput | return {result: false, ..., errorCode: 2} | 否 | 无 | 工具被拒绝 |
| WebSearch query 为空 | WebSearch.validateInput | return {result: false, ..., errorCode: 1} | 否 | 无 | 工具被拒绝 |
| WebSearch provider 不支持 | WebSearch.isEnabled | 工具不可用 | 不适用 | 无 | 工具不显示给模型 |

### 工程取舍说明

**取舍 1：域名检查仅缓存 'allowed' 结果，blocked/check_failed 不缓存**
- 理由：blocked 可能是临时的，check_failed 可能是网络问题，下次应该重试
- 代价：同一 blocked 域名可能重复检查
- 证据：`src/tools/WebFetchTool/utils.ts:189`（仅 allowed 时 setCache）

**取舍 2：二进制内容仍然尝试 UTF-8 解码+摘要，同时保存文件**
- 理由：PDF 等二进制的 UTF-8 解码可能仍有可提取文本，补充文件提供后备
- 代价：有时摘要质量低，浪费 Haiku tokens
- 证据：`src/tools/WebFetchTool/utils.ts:451-466`（同时执行两个路径）

**取舍 3：URL 最大长度从 250 增加到 2000**
- 理由：250 太严格，合法场景（JWT 签名 URL）需要更长长度，主要安全防线是域名权限
- 代价：略微增加数据泄露风险
- 证据：`src/tools/WebFetchTool/utils.ts:99-106` 注释

**取舍 4：预批准域名 WebFetch 自动允许，但沙箱网络不继承**
- 理由：WebFetch 是只读 GET，风险低；沙箱允许任意网络，风险高
- 代价：用户可能困惑为什么行为不一致
- 证据：`src/tools/WebFetchTool/WebFetchTool.ts:110-118` + 测试验证分离

**取舍 5：跨主机重定向不自动跟随，返回提示让模型重新调用**
- 理由：安全防止 open redirect，权限一致（新域名重新检查）
- 代价：模型需要多一轮工具调用
- 证据：`src/tools/WebFetchTool/utils.ts:262-329` + `WebFetchTool.ts:217-248`

**取舍 6：Turndown 懒加载单例**
- 理由：避免启动时加载 1.4MB 依赖，单例避免重复初始化
- 代价：第一次调用有轻微延迟
- 证据：`src/tools/WebFetchTool/utils.ts:88-97`

**取舍 7：WebSearch max_uses 硬编码为 8**
- 理由：防止单次工具调用中的搜索滥用
- 代价：无法灵活调整
- 证据：`src/tools/WebSearchTool/WebSearchTool.ts:82`

## 6. 现状验收标准

### WebSearchTool 验收

1. 给定同时传入 allowed_domains 和 blocked_domains，当调用 WebSearch 时，系统必须在 validateInput 阶段拒绝（errorCode: 2）。
2. 给定 firstParty provider，当检查 WebSearch.isEnabled 时，系统必须返回 true。
3. 给定 Vertex provider 且模型是 Claude 3，当检查 WebSearch.isEnabled 时，系统必须返回 false。
4. 给定 Vertex provider 且模型是 Claude 4，当检查 WebSearch.isEnabled 时，系统必须返回 true。
5. 给定搜索完成，当返回结果给模型时，系统必须在工具结果中追加 REMINDER 要求包含 Sources。

### WebFetchTool 验收

1. 给定 URL 长度 2500 字符，当调用 WebFetch 时，系统必须在 validateURL 阶段拒绝。
2. 给定 URL 包含用户名密码（https://user:pass@example.com），当调用 WebFetch 时，系统必须在 validateURL 阶段拒绝。
3. 给定单段主机名（https://router），当调用 WebFetch 时，系统必须在 validateURL 阶段拒绝。
4. 给定预批准域名（https://docs.python.org），当调用 WebFetch 时，系统必须在 checkPermissions 阶段自动 allow。
5. 给定 http://example.com（非 https），当调用 WebFetch 时，系统必须自动升级到 https。
6. 给定 https://example.com → https://www.example.com 重定向，当调用 WebFetch 时，系统必须自动跟随。
7. 给定 https://example.com → https://other.com 重定向，当调用 WebFetch 时，系统必须返回提示信息要求重新调用 WebFetch with https://other.com。
8. 给定同一 URL 15 分钟内第二次调用，当调用 WebFetch 时，系统必须从缓存返回，不重新请求。
9. 给定 PDF URL，当调用 WebFetch 时，系统必须同时保存文件到磁盘并尝试文本摘要，两者都返回给模型。
10. 给定非预批准域名，当调用 WebFetch 时，系统必须使用 Haiku 摘要，且引用限制为 125 字符。
11. 给定预批准域名且内容是 Markdown 且长度 < 100,000，当调用 WebFetch 时，系统必须直接返回内容，不经过 Haiku。
12. 给定 skipWebFetchPreflight=true 设置，当调用 WebFetch 时，系统必须跳过域名黑名单检查。

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| WebSearch 通过 server_tool_use 委托给 API，max_uses=8 | `src/tools/WebSearchTool/WebSearchTool.ts:76-83, 268-388` | 无直接测试 | 流式事件解析逻辑复杂，依赖 API 端行为 |
| WebFetch 仅自动跟随同主机/www 重定向，跨主机返回提示 | `src/tools/WebFetchTool/utils.ts:212-243, 262-329`; `WebFetchTool.ts:217-248` | test/utils/sandbox/webfetch-preapproved-separated.test.ts（测试预批准与沙箱分离，不是重定向本身） | 仅 strip www 比较，不处理其他子域名差异 |
| 预批准域名列表与沙箱网络隔离 | `src/tools/WebFetchTool/preapproved.ts:14-166`; `WebFetchTool.ts:110-118` | test/utils/sandbox/webfetch-preapproved-separated.test.ts | 沙箱网络控制不在本 spec 覆盖范围内 |
| URL_CACHE 15 分钟 TTL、50MB、LRU；DOMAIN_CHECK_CACHE 5 分钟、128 条目、仅 allowed | `src/tools/WebFetchTool/utils.ts:51-83, 179-203, 356-366, 479-481` | 无直接测试 | clearWebFetchCache 存在但很少调用 |
| 非预批准域名强制 Haiku 摘要且限制引用，预批准域名宽松 | `src/tools/WebFetchTool/WebFetchTool.ts:264-278`; `prompt.ts:28-46` | 无直接测试 | 仅当 content-type 是 text/markdown 且长度足够才跳过摘要 |
| 二进制内容同时保存到磁盘并尝试文本摘要 | `src/tools/WebFetchTool/utils.ts:440-466`; `WebFetchTool.ts:283-285` | 无直接测试 | 仅 isBinaryContentType 检测的类型才持久化 |
| URL 最大长度 2000 字符，注释说明从 250 增加 | `src/tools/WebFetchTool/utils.ts:99-106, 139-170` | 无直接测试 | 2000 是硬编码常量 |
| WebSearch prompt 要求必须包含 Sources，工具结果也提醒 | `src/tools/WebSearchTool/prompt.ts:14-33`; `WebSearchTool.ts:426-428` | 无直接测试 | 仅提醒，不强制验证模型是否实际包含 |
| Turndown 懒加载单例 | `src/tools/WebFetchTool/utils.ts:88-97` | 无直接测试 | 仅在需要 HTML→Markdown 时才 import |
| 域名检查仅缓存 allowed 结果 | `src/tools/WebFetchTool/utils.ts:189` | 无直接测试 | blocked/check_failed 不调用 setCache |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/web-tools.yaml)

### 覆盖分组职责说明

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|------|-----------|------------------|----------------|
| web-search-tool | WebSearchTool 实现、流式事件解析、结果组装 | 无直接测试 | API 端搜索逻辑（黑盒） |
| web-fetch-tool | WebFetchTool 实现、权限检查、重定向处理 | test/utils/sandbox/webfetch-preapproved-separated.test.ts | 沙箱网络控制 |
| web-fetch-utils | URL 验证、域名检查、抓取、缓存、HTML→Markdown、摘要应用 | 无直接测试 | Turndown 库本身 |
| web-fetch-preapproved | 预批准域名列表、路径前缀匹配 | test/utils/sandbox/webfetch-preapproved-separated.test.ts | 沙箱网络允许列表 |
| web-fetch-ui | 工具使用摘要、进度渲染 | 无直接测试 | UI 框架集成 |
| web-search-ui | 搜索工具使用摘要、进度渲染 | 无直接测试 | UI 框架集成 |
| web-search-prompt | WebSearch 系统提示 | 无直接测试 | 模型提示工程 |
| web-fetch-prompt | WebFetch 系统提示、次级模型提示 | 无直接测试 | 模型提示工程 |
| brief-tool | BriefTool 实现、消息传递、附件 | 无直接测试 | 对话管理 |

### 相关子系统

- **权限系统**：负责 WebFetch 域名访问控制，本 spec 仅描述工具如何调用 getRuleByContentsForTool
- **查询核心**：queryModelWithStreaming、queryHaiku 是外部依赖，本 spec 仅描述调用点
- **MCP 输出存储**：负责二进制内容持久化，本 spec 仅描述调用点
- **Feature Flag 系统**：tengu_plum_vx3 控制 WebSearch 是否使用 Haiku，本 spec 仅描述调用点
- **设置系统**：skipWebFetchPreflight 控制是否跳过域名检查，本 spec 仅描述调用点

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|---------|-------|-------|
| P2 | WebFetch 当前对非预批准域名总是截断到 100,000 字符再摘要，可能丢失重要信息 | 支持分块摘要（如先摘要前 100k，再摘要后 100k，合并结果） | 中等：需要正确处理分块边界 | 给定 200k 字符页面，当调用 WebFetch 时，摘要应包含两部分信息 | M | 已证实（长页面常见） |
| P2 | 当前无单元测试覆盖重定向逻辑、缓存逻辑、域名检查逻辑 | 添加针对这些核心逻辑的测试 | 低：仅添加测试 | 测试模拟同主机重定向、跨主机重定向、缓存命中/未命中、域名 blocked/allowed/check_failed | M | 已证实（代码存在但无测试） |
| P2 | WebFetch 无法处理需要认证的页面（GitHub 私有仓库等），即使有专用 MCP 工具也可能被模型忽略 | 增强 prompt 明确提醒优先使用专用 MCP 工具（如果可用） | 低：仅 prompt 变更 | 给定 GitHub URL，当有 MCP GitHub 工具时，模型应优先使用 MCP 工具而非 WebFetch | S | 已证实（prompt 已有提示但可更强） |
| P3 | WebSearch 来源引用仅依赖模型遵循指令，无强制验证 | 在后处理中验证响应是否包含 Sources，不包含则提示模型补充 | 中等：需要解析模型响应 | 给定模型响应未包含 Sources，当后处理检测到时，自动提示模型补充 | M | 设计推断 |
| P3 | URL_CACHE 无法手动失效（除了 clearWebFetchCache 清空所有） | 添加按 URL 或域名失效的功能 | 低：新增 API | 给定特定 URL，当调用失效 API 时，该 URL 从缓存移除，其他保留 | S | 设计推断 |
| P3 | 预批准域名列表需要手动更新 | 添加定期从远程更新的机制（可选） | 中等：需要网络请求和更新逻辑 | 给定新版本，当启动时检查更新预批准列表 | L | 设计推断 |

### 优先级说明

- **P2**：局部可维护性、体验改进、测试缺口。不影响核心正确性，但能提升效率。
- **P3**：可选体验、测试完善。明确非紧急，可延后处理。
