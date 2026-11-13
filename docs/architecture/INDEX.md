# Subsystem design specs

本索引由实际 spec 和 coverage 生成，只负责导航。设计正文位于 spec，文件主归属位于 coverage；draft 表示正文已完成初稿但仍待事实与用户复审。

阅读建议：要理解实际对话执行、持久化和恢复设计，从 `query-core` 开始；`documentation-system` 只解释文档注册与校验基础设施，不是产品代码设计总览。

| Spec ID | Batch | Status | Design | Coverage |
|---|---:|---|---|---|
| `documentation-system` | 0 | draft | [文档系统注册、覆盖与校验设计](../superpowers/specs/2026-11-12-codebase-design-docs-design.md) | [coverage](coverage/documentation-system.yaml) |
| `plugins` | 0 | draft | [Plugins 插件发现、加载与生命周期设计](../superpowers/specs/2026-11-12-plugins-design.md) | [coverage](coverage/plugins.yaml) |
| `query-core` | 0 | draft | [Query Core 对话与工具执行设计](../superpowers/specs/2026-11-12-query-core-design.md) | [coverage](coverage/query-core.yaml) |
| `sdk-query-sessions` | 0 | draft | [SDK Query、Session、控制面与 Checkpoint 设计](../superpowers/specs/2026-11-12-sdk-query-sessions-design.md) | [coverage](coverage/sdk-query-sessions.yaml) |
| `sdk-type-generation` | 0 | draft | [SDK Type Generation Schema 驱动类型生成设计](../superpowers/specs/2026-11-12-sdk-type-generation-design.md) | [coverage](coverage/sdk-type-generation.yaml) |
| `cli-startup` | 1 | draft | [CLI Startup 启动、快速路径与执行模式设计](../superpowers/specs/2026-11-12-cli-startup-design.md) | [coverage](coverage/cli-startup.yaml) |
| `context-compaction` | 1 | draft | [Context Compaction 历史压缩与溢出恢复设计](../superpowers/specs/2026-11-12-context-compaction-design.md) | [coverage](coverage/context-compaction.yaml) |
| `model-api` | 1 | draft | [Model API 模型配置、请求与响应设计](../superpowers/specs/2026-11-12-model-api-design.md) | [coverage](coverage/model-api.yaml) |
| `attachments` | 2 | draft | [Attachments 附件、图片与上下文注入设计](../superpowers/specs/2026-11-12-attachments-design.md) | [coverage](coverage/attachments.yaml) |
| `bridge` | 2 | draft | [Bridge 环境桥接与远程工作生命周期设计](../superpowers/specs/2026-11-12-bridge-design.md) | [coverage](coverage/bridge.yaml) |
| `buddy` | 2 | draft | [Buddy 伙伴会话与通知设计](../superpowers/specs/2026-11-12-buddy-design.md) | [coverage](coverage/buddy.yaml) |
| `computer-use` | 2 | draft | [Computer Use 浏览器与桌面自动化后端设计](../superpowers/specs/2026-11-12-computer-use-design.md) | [coverage](coverage/computer-use.yaml) |
| `file-tools` | 2 | draft | [File Tools 文件读写、编辑与搜索设计](../superpowers/specs/2026-11-12-file-tools-design.md) | [coverage](coverage/file-tools.yaml) |
| `lsp` | 2 | draft | [LSP 语言服务生命周期与工具集成设计](../superpowers/specs/2026-11-12-lsp-design.md) | [coverage](coverage/lsp.yaml) |
| `mcp` | 2 | draft | [MCP 连接、能力聚合与生命周期设计](../superpowers/specs/2026-11-12-mcp-design.md) | [coverage](coverage/mcp.yaml) |
| `onboarding-ui` | 2 | draft | [Onboarding UI: 首次引导、信任与设置确认设计](../superpowers/specs/2026-11-12-onboarding-ui-design.md) | [coverage](coverage/onboarding-ui.yaml) |
| `permissions` | 2 | draft | [Permissions 工具权限裁决与审批设计](../superpowers/specs/2026-11-12-permissions-design.md) | [coverage](coverage/permissions.yaml) |
| `session-persistence` | 2 | draft | [Session Persistence 会话记录、恢复与文件历史设计](../superpowers/specs/2026-11-12-session-persistence-design.md) | [coverage](coverage/session-persistence.yaml) |
| `shell-tools` | 2 | draft | [Shell Tools 命令执行、沙箱与进程生命周期设计](../superpowers/specs/2026-11-12-shell-tools-design.md) | [coverage](coverage/shell-tools.yaml) |
| `tool-framework` | 2 | draft | [Tool Framework 工具契约、组合与执行上下文设计](../superpowers/specs/2026-11-12-tool-framework-design.md) | [coverage](coverage/tool-framework.yaml) |
| `auth` | 3 | draft | [Auth OAuth 与安全凭据存储设计](../superpowers/specs/2026-11-12-auth-design.md) | [coverage](coverage/auth.yaml) |
| `commit-attribution` | 3 | draft | [Commit Attribution 提交归因与提交元数据设计](../superpowers/specs/2026-11-12-commit-attribution-design.md) | [coverage](coverage/commit-attribution.yaml) |
| `git-integration` | 3 | draft | [Git Integration 仓库状态、分支与 GitHub 集成设计](../superpowers/specs/2026-11-12-git-integration-design.md) | [coverage](coverage/git-integration.yaml) |
| `memory` | 3 | draft | [Memory 记忆加载、提取与同步设计](../superpowers/specs/2026-11-12-memory-design.md) | [coverage](coverage/memory.yaml) |
| `notifications` | 3 | draft | [Notifications 后台通知、折叠与用户可见性设计](../superpowers/specs/2026-11-12-notifications-design.md) | [coverage](coverage/notifications.yaml) |
| `session-search-recovery` | 3 | draft | [Session Search & Recovery 会话发现与跨项目恢复设计](../superpowers/specs/2026-11-12-session-search-recovery-design.md) | [coverage](coverage/session-search-recovery.yaml) |
| `sessions-share` | 3 | draft | [Session Sharing 会话导出、共享与恢复设计](../superpowers/specs/2026-11-12-sessions-share-design.md) | [coverage](coverage/sessions-share.yaml) |
| `settings` | 3 | draft | [Settings 设置来源、合并与变更生命周期设计](../superpowers/specs/2026-11-12-settings-design.md) | [coverage](coverage/settings.yaml) |
| `skills` | 3 | draft | [Skills 技能发现、加载与执行设计](../superpowers/specs/2026-11-12-skills-design.md) | [coverage](coverage/skills.yaml) |
| `app-state` | 4 | draft | [App State 应用状态、订阅与生命周期设计](../superpowers/specs/2026-11-12-app-state-design.md) | [coverage](coverage/app-state.yaml) |
| `assistant-ui` | 4 | draft | [Assistant UI 助手会话与历史交互设计](../superpowers/specs/2026-11-12-assistant-ui-design.md) | [coverage](coverage/assistant-ui.yaml) |
| `commands-framework` | 4 | draft | [Commands Framework 命令聚合、解析与执行设计](../superpowers/specs/2026-11-12-commands-framework-design.md) | [coverage](coverage/commands-framework.yaml) |
| `cost-tracking` | 4 | draft | [Cost Tracking 用量、成本与限额展示设计](../superpowers/specs/2026-11-12-cost-tracking-design.md) | [coverage](coverage/cost-tracking.yaml) |
| `ide-integration` | 4 | draft | [IDE Integration 编辑器连接与状态同步设计](../superpowers/specs/2026-11-12-ide-integration-design.md) | [coverage](coverage/ide-integration.yaml) |
| `ink-platform` | 4 | draft | [Ink Platform 终端渲染与原生边界设计](../superpowers/specs/2026-11-12-ink-platform-design.md) | [coverage](coverage/ink-platform.yaml) |
| `repl-input` | 4 | draft | [REPL Input 输入、补全与键盘交互设计](../superpowers/specs/2026-11-12-repl-input-design.md) | [coverage](coverage/repl-input.yaml) |
| `text-formatting` | 4 | draft | [Text Formatting 文本、ANSI 与显示格式化设计](../superpowers/specs/2026-11-12-text-formatting-design.md) | [coverage](coverage/text-formatting.yaml) |
| `ui-rendering` | 4 | draft | [UI Rendering 消息、工具结果与终端展示设计](../superpowers/specs/2026-11-12-ui-rendering-design.md) | [coverage](coverage/ui-rendering.yaml) |
| `voice-assistant` | 4 | draft | [Voice Assistant 语音输入与生命周期设计](../superpowers/specs/2026-11-12-voice-assistant-design.md) | [coverage](coverage/voice-assistant.yaml) |
| `workspace-ui` | 4 | draft | [Workspace UI 工作区、差异与对话框交互设计](../superpowers/specs/2026-11-12-workspace-ui-design.md) | [coverage](coverage/workspace-ui.yaml) |
| `agent-swarms` | 5 | draft | [Agent Swarms 子代理、团队与协调执行设计](../superpowers/specs/2026-11-12-agent-swarms-design.md) | [coverage](coverage/agent-swarms.yaml) |
| `help-feedback` | 5 | draft | [Help & Feedback 帮助、提示与用户反馈设计](../superpowers/specs/2026-11-12-help-feedback-design.md) | [coverage](coverage/help-feedback.yaml) |
| `plan-worktree` | 5 | draft | [Plan & Worktree 计划执行与隔离工作区设计](../superpowers/specs/2026-11-12-plan-worktree-design.md) | [coverage](coverage/plan-worktree.yaml) |
| `review-analysis` | 5 | draft | [Review & Analysis 代码审查与上下文分析设计](../superpowers/specs/2026-11-12-review-analysis-design.md) | [coverage](coverage/review-analysis.yaml) |
| `scheduling` | 5 | draft | [Scheduling 定时任务、模板作业与主动唤醒设计](../superpowers/specs/2026-11-12-scheduling-design.md) | [coverage](coverage/scheduling.yaml) |
| `task-system` | 5 | draft | [Task System 任务状态、后台执行与生命周期设计](../superpowers/specs/2026-11-13-task-system-design.md) | [coverage](coverage/task-system.yaml) |
| `workflow` | 5 | draft | [Workflow DAG 编排与失败传播设计](../superpowers/specs/2026-11-12-workflow-design.md) | [coverage](coverage/workflow.yaml) |
| `daemon-background` | 6 | draft | [Daemon & Background 守护进程与后台会话设计](../superpowers/specs/2026-11-12-daemon-background-design.md) | [coverage](coverage/daemon-background.yaml) |
| `deep-link` | 6 | draft | [Deep Link 协议解析与目标路由设计](../superpowers/specs/2026-11-12-deep-link-design.md) | [coverage](coverage/deep-link.yaml) |
| `open-runner` | 6 | draft | [Open Runner 环境执行与 Worker 协议设计](../superpowers/specs/2026-11-12-open-runner-design.md) | [coverage](coverage/open-runner.yaml) |
| `platform-integrations` | 6 | draft | [Platform Integrations 桌面、移动与协作平台集成设计](../superpowers/specs/2026-11-12-platform-integrations-design.md) | [coverage](coverage/platform-integrations.yaml) |
| `remote-control` | 6 | draft | [Remote Control 远程会话、传输与重连设计](../superpowers/specs/2026-11-12-remote-control-design.md) | [coverage](coverage/remote-control.yaml) |
| `ssh` | 6 | draft | [SSH 远程执行、认证与重连设计](../superpowers/specs/2026-11-12-ssh-design.md) | [coverage](coverage/ssh.yaml) |
| `teleport` | 6 | draft | [Teleport 会话迁移与恢复设计](../superpowers/specs/2026-11-12-teleport-design.md) | [coverage](coverage/teleport.yaml) |
| `build-feature-profile` | 7 | draft | [Build & Feature Profile 构建与功能裁剪设计](../superpowers/specs/2026-11-12-build-feature-profile-design.md) | [coverage](coverage/build-feature-profile.yaml) |
| `data-structures` | 7 | draft | [Data Structures 通用数据结构与解析契约设计](../superpowers/specs/2026-11-12-data-structures-design.md) | [coverage](coverage/data-structures.yaml) |
| `diagnostics` | 7 | draft | [Diagnostics 诊断采集、调试与导出设计](../superpowers/specs/2026-11-12-diagnostics-design.md) | [coverage](coverage/diagnostics.yaml) |
| `experimental-features` | 7 | draft | [Experimental Features 实验功能与内部测试辅助设计](../superpowers/specs/2026-11-12-experimental-features-design.md) | [coverage](coverage/experimental-features.yaml) |
| `external-stubs` | 7 | draft | [External Stubs 外部依赖边界与禁用契约设计](../superpowers/specs/2026-11-12-external-stubs-design.md) | [coverage](coverage/external-stubs.yaml) |
| `hooks-system` | 7 | draft | [Hooks System 事件钩子配置与执行设计](../superpowers/specs/2026-11-12-hooks-system-design.md) | [coverage](coverage/hooks-system.yaml) |
| `magic-docs` | 7 | draft | [Magic Docs 文档生成与同步设计](../superpowers/specs/2026-11-12-magic-docs-design.md) | [coverage](coverage/magic-docs.yaml) |
| `messaging-primitives` | 7 | draft | [Messaging Primitives 消息寻址、队列与兼容设计](../superpowers/specs/2026-11-12-messaging-primitives-design.md) | [coverage](coverage/messaging-primitives.yaml) |
| `native-installer` | 7 | draft | [Native Installer 原生安装与更新恢复设计](../superpowers/specs/2026-11-12-native-installer-design.md) | [coverage](coverage/native-installer.yaml) |
| `network-security` | 7 | draft | [Network Security 网络安全、证书与云凭据适配设计](../superpowers/specs/2026-11-12-network-security-design.md) | [coverage](coverage/network-security.yaml) |
| `runtime-lifecycle` | 7 | draft | [Runtime Lifecycle 取消、清理与进程退出设计](../superpowers/specs/2026-11-12-runtime-lifecycle-design.md) | [coverage](coverage/runtime-lifecycle.yaml) |
| `telemetry` | 7 | draft | [Telemetry 事件契约、导出与隐私边界设计](../superpowers/specs/2026-11-12-telemetry-design.md) | [coverage](coverage/telemetry.yaml) |
| `test-validation` | 7 | draft | [Test Validation 测试运行、Live 验证与证据边界设计](../superpowers/specs/2026-11-12-test-validation-design.md) | [coverage](coverage/test-validation.yaml) |
| `web-tools` | 7 | draft | [Web Tools 搜索、抓取与内容处理设计](../superpowers/specs/2026-11-12-web-tools-design.md) | [coverage](coverage/web-tools.yaml) |
