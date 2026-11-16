# CLAUDE.md

flash：Claude Code 的教学/研究快照（Bun + React/Ink 的 agentic CLI 与 Agent SDK）。

## 硬性规则

1. 产品名是 flash。源码/文档中 `Claude Code`、`claude-code` 字样按命名排除清单处理
   （claudeCodeGuideAgent、generated/**、github-app.ts、oauth.ts、CLAUDECODE 协议、
   小写外部标识符不改；README 归属句保留）→ 详见 flash-coding skill。
2. 测试：`bun run test`（scripts/test.ts 逐文件顺序执行，以退出码判断，勿只看 tail）。
   构建：`bun run build`；类型：`bun run typecheck`。
3. 行为或设计变更前，先用三层证据对齐上游 Claude Code（官方文档 → 本机上游二进制
   strings → 本仓库 external-stubs 契约），证据写入 spec 决策表 → 方法见 flash-coding skill。
4. 功能子系统的设计文档需登记 `docs/architecture/coverage/manifest.yaml` 并通过
   `bun scripts/check-design-docs.ts`；工程改造类不需要。
5. 设计文档：`docs/superpowers/specs|plans/YYYY-MM-DD-<topic>.md`，中文 + 决策表带证据。
6. README 与 docs 改动必须双语成对提交。
7. 提交信息以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。

其余工程惯例（bundled 形态、stubs 契约、发布命名单点、环境陷阱）：
调用 flash-coding skill。
