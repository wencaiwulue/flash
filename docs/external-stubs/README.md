# External Stub 恢复设计

日期：2026-11-11。

本目录是 external 构建中显式 stub、固定失败和丢弃实现的**前瞻设计与执行规范**。它不是历史提交的重建，也不表示文档所列功能已经实现。总清单位于 [`docs/status/external-stubs-audit.md`](../status/external-stubs-audit.md)，实际证据位于 [`verification.md`](verification.md)。

## 目标

逐项完成“公开契约、生产实现、用户入口、自动测试、打包验证、状态证据”的闭环。恢复实现和启用 feature flag 是同一步骤的两个部分，不能只完成其中一个。

以下结果不算完成：

- 用 `throw new Error(...unavailable...)`、固定 `false`、空数组或忽略参数代替目标行为；
- 将 isolated Playwright 浏览器称为真实 Chrome 扩展连接，或将 Zavora 称为私有 Swift Computer Use；
- 只让 helper 可调用而 CLI、REPL、MCP 或 UI 入口仍不可达；
- 仅凭 source 单测、构建成功或 help 中出现命令，就宣称端到端功能可用；
- 将本仓库定义的开放协议描述为与私有内部协议兼容。

## 架构原则

1. **开放后端与兼容边界分离**：开放实现使用版本化、可测试的公开契约；私有协议兼容性必须另有真实环境证据。
2. **信任边界失败关闭**：webhook、权限分类、认证、SSH/runner 和危险权限模式不得因异常、超时或非法响应而自动放行。
3. **正常输入不因安全功能开启而回归**：普通 Remote Control 用户消息与 webhook 分流，合法普通消息必须继续入队。
4. **复用已有真实模块**：不重复实现现有 client、session storage、commit attribution、snapshot 文件操作、Bridge transport、Monitor local-shell、Playwright 或 Zavora 后端。
5. **入口与实现同时交付**：只有实现和对应 dist 入口测试均通过，才加入 external feature profile。
6. **公开行为可追踪**：新命令、协议、配置、迁移和隐私影响必须进入设计与发布文档。

## 契约索引

### 入站、消息与权限

- [Inbound envelope](contracts/inbound-envelope.md)
- [Peer messaging](contracts/peer-messaging.md)
- [Bash prompt rules](contracts/bash-prompt-rules.md)

### 浏览器与桌面

- [Open Chrome](contracts/open-chrome.md)
- [Computer Use backends](contracts/computer-use-backends.md)

### 服务、进程与任务

- [Direct Connect v1](contracts/direct-connect-v1.md)
- [Background sessions](contracts/background-sessions.md)
- [SSH v1](contracts/ssh-v1.md)
- [Local Template Jobs v1](contracts/local-template-jobs-v1.md)
- [Open Runner v1](contracts/open-runner-v1.md)

### 状态、归因与监控

- [Snapshot merge](contracts/snapshot-merge.md)
- [Commit attribution](contracts/commit-attribution.md)
- [MCP monitor](contracts/mcp-monitor.md)

### 命令与其他占位

- [Public commands](contracts/public-commands.md)
- [Remaining stubs](contracts/remaining-stubs.md)
- [Protocol and compatibility gates](protocol-gates.md)

## 实施顺序

1. **文档阶段**：完成总审计、全部契约和基线记录，冻结范围后再修改生产源码。
2. **Wave 1**：入站 sanitizer、webhook/cross-session/Fork renderer。
3. **Wave 2**：snapshot、attribution、Bash prompt 权限和 MCP monitor。
4. **Wave 3**：peer sessions、真实 Chrome 和 Computer Use 后端分层。
5. **Wave 4**：Direct Connect 和后台会话。
6. **Wave 5**：SSH、本地 Template Jobs 和 Open Runner。
7. **Wave 6**：18 个公开 slash command 及总审计中的其余占位。
8. **最终验证**：专项与全量测试、typecheck、build、dist、文档检查以及可用授权环境中的 live 验证。

每一波均保持构建可用；若实现未通过验收，不同时启用其入口。完成一波后更新审计、验证证据和 `docs/STATUS.md`。

## 状态定义

- **Not implemented**：仍存在固定失败、空实现或入口缺失。
- **Implemented, unverified**：实现与离线测试存在，但指定 live 环境尚未验证。
- **Verified (offline)**：契约、单元、集成和对应 dist 路径已在本地验证。
- **Verified (live)**：文档指定的真实外部或桌面环境已执行成功，并记录环境和日期。
- **Open implementation**：使用本目录公开契约的实现；可与上述验证状态组合，不代表私有兼容。

所有测试失败、跳过和环境缺失都必须如实记录。历史基线失败不得被写成由本次修改引入，也不得在最终报告中被省略。
