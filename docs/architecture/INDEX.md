# Subsystem design specs

本索引只负责导航。设计正文位于 spec，文件主归属位于 coverage；planned 条目在正文获批前不创建空文件或链接。

阅读建议：要理解实际对话执行、持久化和恢复设计，从 `query-core` 开始；`documentation-system` 只解释文档注册与校验基础设施，不是产品代码设计总览。

| Spec ID | Batch | Status | Design | Coverage |
|---|---:|---|---|---|
| `documentation-system` | 0 | draft | [文档系统注册、覆盖与校验设计](../superpowers/specs/2026-11-12-codebase-design-docs-design.md) | [coverage](coverage/documentation-system.yaml) |
| `query-core` | 0 | draft | [Query Core 对话与工具执行设计](../superpowers/specs/2026-11-12-query-core-design.md) | [coverage](coverage/query-core.yaml) |
| `sdk-type-generation` | 0 | planned | SDK schema 与类型生成 | 待对应 spec 批准后登记 |
| `telemetry` | 0 | planned | 遥测契约与 protobuf 生成边界 | 待对应 spec 批准后登记 |
