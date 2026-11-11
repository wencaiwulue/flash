---
commit: 17f52b5584441f3c937f3d927acad381852159b7
title: "Test live workflow without job conditions"
date: 2026-11-11T09:22:15+08:00
status: partial
kind: component
---

# 实施计划：Test live workflow without job conditions

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

提交主题说明要测试没有 job conditions 的 workflow，补丁确实删除两个 if。删除后 model 对声明的触发器不再有 job 级凭据判断，也没有对应的脚本缺省分支，因此未配置时同样会安装依赖并进入 live 探针；Cloud/desktop 仍保持上一步的 absent 状态，不能用后来的脚本 guard 或最终 CI 结果解释当前设计。

- 以 85028f74ed5ec110dcfd0a0933f615f88cc4600e 的二 job workflow 为基线，确认 Cloud/desktop 已 absent，且本步不负责恢复。
- 检查 model 与 SkillHub 脚本的缺省配置路径，区分公共无 token 探针和需要模型凭据的探针。

## 复用与兼容处理

### 复用现有实现

- 复用现有手动/定时触发、Bun 安装、隔离目录、公共 SkillHub 默认地址与模型清理流程。

### 兼容、迁移与生命周期

- workflow_dispatch 与 cron 仍是唯一触发器，删除非 pull_request 判断本身不增加 pull_request 触发。
- model 的无效 secrets if 文本被删除；当前对声明的触发器始终启动，无密钥时也没有脚本级 skip 兼容层，不能把父版本条件当作可靠的旧跳过行为。
- SkillHub 的公共默认路径保持，自定义 URL/token 映射不变；Cloud/desktop 的 CI absent 状态保持。
- 文件路径与 name: live-validation 不变，本提交没有 re-registration rename。

## 文件级实施步骤

### 1. 核对两个条件的实际组成

拆分 model 的事件与 secret 合取以及 skillhub 的事件条件，确认本步消除了不受支持的 secrets 判断，同时让无密钥运行明确进入脚本。

涉及位置：`.github/workflows/live-validation.yml`、`scripts/live-model-validation.ts`、`scripts/live-skillhub-validation.ts`

### 2. 删除 model 与 SkillHub job if

分别移除两行完整条件，让 runs-on 紧跟 job 名称；不改触发器、步骤或 env，也不向二 job 添加 Environment。

涉及位置：`.github/workflows/live-validation.yml`

### 3. 审视未配置执行与缺失覆盖

读取 model 脚本确认没有提前 skip，读取公共 SkillHub 默认配置，并再次确认 Cloud/desktop 只有脚本没有 job；对照 RELEASE 留下文档偏差，不用后续 guard 补齐当前记录。

涉及位置：`scripts/live-model-validation.ts`、`scripts/live-skillhub-validation.ts`、`scripts/live-cloud-validation.ts`、`scripts/live-desktop-validation.ts`、`docs/RELEASE.md`

## 风险与处理

- 无密钥 model 会消耗 runner 并进入真实探针，失败位置和错误形式取决于配置及外部请求，不能预设为固定 skip。
- 将当前二 job 与后续四 job 成功记录混合，会错误声称 Cloud/desktop 在此 revision 被验证。
- 旧文档仍描述四 job，可能掩盖中间态的覆盖缺口。

## 验证顺序

1. 比较父/当前 YAML，确认只有两行 if 删除，并检查当前 model 文件不存在后续 MODEL_LIVE_SKIPPED 分支。
2. 分别分析 model 与 SkillHub 的无配置路径，不把公共 SkillHub 可运行推广为 model 可跳过。
3. 若后续执行，应记录每个 job 的启动、脚本输出和外部请求结果；absent 的 Cloud/desktop 不列入 executed 或 skipped。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- model 与 SkillHub 的两个 job 条件已删除，其他 workflow 内容保持原样。
- 已确认当前模型脚本无 guard、公共 SkillHub 有默认地址，以及 Cloud/desktop job 仍缺失。

### 未完成或后续工作

- model 无配置行为尚未收敛为明确跳过，Cloud/desktop 编排和文档一致性未恢复，平台运行无证据。
