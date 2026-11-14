# Feature documentation policy

项目文档以**功能设计与实施**为单位，使用 Superpowers 的原生流程，不再按 commit 生成文档或维护 commit 映射。

## 文档位置

- `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`：经评审的功能设计，必须说明问题、**为什么这样设计**、备选方案及不采用原因、目标/非目标、架构、接口、数据流、失败语义、工程取舍和验收标准。
- `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`：经评审的实施计划，必须说明**为什么这样实施**，再提供文件级 TDD 步骤、测试、迁移与回滚。

## 编写原则

- 每个功能独立经历 brainstorming → design spec → user review → writing-plans。
- 功能可以属于产品运行时、SDK、构建、测试、CI/Live 验证或工程工具。纯状态更新、发布记录和 finalization 不单独作为功能。
- 每份 SPEC 必须有“设计理由与备选方案”：先写问题根因和约束，再写为什么选择当前架构、为什么不采用其他方案，最后才写模块与实现内容。
- 每份 PLAN 必须有“实施理由与步骤依据”：解释为什么按此依赖顺序、为什么修改这些文件/接口、为什么选择这些测试与回滚方式，不能只罗列操作步骤。
- 文档必须能独立回答“为什么这样设计”和“具体怎样实施”，不得从 commit 标题、diffstat 或文件名自动拼接正文。
- 不设置 SHA frontmatter、commit 附录、commit 索引或 finalization 文件。Git 历史只用于实现时查证，不进入交付结构。
- 不记录历史测试、命令、CI 或 live 执行结果；验收只写应满足的条件。

## 更新与验收

1. 先确定功能边界和用户价值，再设计模块、接口和失败语义。
2. spec 经用户审阅后，再编写具有准确路径、代码示例和命令的实施计划。
3. 每个实施任务执行对应测试，完成后再运行全量测试、typecheck 和 build。
4. 缺少设计理由、备选方案不采用原因或实施顺序依据的文档不得通过评审，即使章节齐全、命令可执行。
5. CI 不再运行 commit 级 `docs:check`。文档质量由逐功能评审和实际实施验证保证。

## 回溯性子系统设计档案

- 子系统 spec 必须具有 frontmatter `id`、`batch`、`status`，并使用九章模板。planned 只在 manifest 登记，不创建空 spec 或 coverage；draft/approved 必须有完整正文。
- `src/`、`tests/`、`scripts/` 中的每个手写文件恰有一个主 spec。功能专用入口、命令、UI、hook 与测试按运行时职责归属，跨域引用不复制正文或重复归属。
- `docs/architecture/coverage/manifest.yaml` 是 roots、spec 注册与排除规则的唯一来源；coverage YAML 显式列文件，`docs/architecture/INDEX.md` 只负责导航。
- 生成代码和二进制排除必须有有界 glob、原因与 `source_spec`。不得按文件名或扩展名猜测：`src/entrypoints/sdk/settingsTypes.generated.ts` 是手写 re-export，必须纳入覆盖。
- 关键行为使用路径与符号佐证。测试存在不等于通过，mock 不等于 live；实际结果只写入 `docs/STATUS.md` 或验证记录。
- 第 9 章必须使用统一七列表；模糊工作量（如 S/M/L 以外的值）、P0 无已证实证据、P1 仅设计推断均为结构错误。
- 每批同时运行结构检查和人工语义评审。自动检查通过不证明架构语义正确，也不能替代对“设计推断”和 P0/P1 建议证据的审查。
