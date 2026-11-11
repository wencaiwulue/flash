---
commit: 9cd4c63193ded6eb916bf734f65a427da193faf0
title: Live 验证探针与 SkillHub 兼容的实施步骤
date: 2026-11-11
retrospective: true
---

# Live 验证探针与 SkillHub 兼容的实施步骤

> 按 `9cd4c63` 的实现重建。该 PLAN 同时列出必须暴露的设计缺口，不能把原提交中的所有写法当作当前最佳实践。

## 实施顺序

```text
SkillHub 字段归一化及离线测试
        │
        ├─→ 模型探针
        ├─→ SkillHub 探针
        ├─→ Cloud / desktop 探针
        └─→ 四 job workflow → 文档边界同步 → 分层验收
```

先固定客户端契约，再实现调用它的探针；workflow 最后接入，避免在脚本入口尚未确定时编写 CI。

## 1. 归一化 SkillHub 搜索记录

**修改：** `src/services/skillSearch/skillhubClient.ts` 的 `SkillHubClient.search()` 映射段。

使用以下优先级，保留现有请求、解包、slug 过滤和 shortId 逻辑：

```ts
const namespace =
  typeof value.namespace === 'string' && value.namespace
    ? value.namespace
    : 'global'
const latest = value.latestVersion as { version?: unknown } | undefined
const version =
  typeof value.version === 'string'
    ? value.version
    : typeof latest?.version === 'string'
      ? latest.version
      : typeof value.latestVersion === 'string'
        ? value.latestVersion
        : undefined

const normalized = {
  namespace,
  slug,
  name:
    typeof value.displayName === 'string'
      ? value.displayName
      : typeof value.name === 'string'
        ? value.name
        : slug,
  description:
    typeof value.summary === 'string'
      ? value.summary
      : typeof value.description === 'string'
        ? value.description
        : '',
  ...(version ? { version } : {}),
}
```

**先写确定性测试：** `tests/skillhubClient.test.ts`。通过 `fetchImpl` 注入响应，不访问网络：

```ts
import { expect, test } from 'bun:test'
import { SkillHubClient } from '../src/services/skillSearch/skillhubClient.ts'

test('normalizes public registry fields and legacy fallbacks', async () => {
  const payload = {
    items: [
      {
        slug: 'new-format',
        latestVersion: { version: '1.2.0' },
        displayName: 'New Format',
        summary: 'new summary',
      },
      {
        namespace: 'legacy',
        slug: 'legacy-format',
        latestVersion: '1.0.0',
        name: 'Legacy Format',
        description: 'legacy description',
      },
    ],
  }
  const client = new SkillHubClient({
    baseUrl: 'http://registry.invalid',
    fetchImpl: async () => new Response(JSON.stringify(payload)),
  })

  expect(await client.search('code')).toEqual([
    {
      namespace: 'global',
      slug: 'new-format',
      name: 'New Format',
      description: 'new summary',
      version: '1.2.0',
    },
    {
      namespace: 'legacy',
      slug: 'legacy-format',
      name: 'Legacy Format',
      description: 'legacy description',
      version: '1.0.0',
    },
  ])
})
```

另加两个输入：显式 `version` 必须覆盖 `latestVersion.version`；缺少 slug 的记录必须被过滤。

验收命令：

```bash
bun test tests/skillhubClient.test.ts
bun run typecheck
```

## 2. 实现模型探针

**创建：** `scripts/live-model-validation.ts`。

先建立 tool context，再严格按以下顺序调用生产入口。每项都必须有失败条件，不能只等待 Promise 返回：

| 顺序 | 调用 | 必须通过的断言 |
|---|---|---|
| 1 | `parseWorkflowDefinition()` + `startWorkflowTask()` | `done` 的最终状态为 `completed` |
| 2 | `activateProactive('command')` + `SleepTool.call({duration: 10})` | `SleepTool.isEnabled()` 且 `slept.data.interrupted` 为假 |
| 3 | `initContextCollapse({contextWindow: () => 100})` + 六条长消息 | `collapsedSpans === 1` 且 collapse 后剩五条消息 |
| 4 | `reactiveCompactOnPromptTooLong()` | 返回对象 `reactive.ok` 为真 |

workflow 只含一个 `respond` 步骤，提示模型返回固定文本。四个成功标记分别放在对应断言之后；外层必须保留：

```ts
try {
  await main()
} finally {
  await runCleanupFunctions()
}
```

验收时逐项制造失败：workflow 非 completed、Sleep interrupted、collapse 统计不符、reactive 非 ok。每种情况都必须非零退出，且不能输出后续成功标记。

## 3. 实现 SkillHub 探针

**创建：** `scripts/live-skillhub-validation.ts`。

实现下面的调用链，URL 的两个路径段必须分别编码：

```ts
const cacheDir = await mkdtemp(join('/tmp', 'flash-skillhub-live-'))
try {
  const matches = await client.search('code', { limit: 1 })
  const match = matches[0]
  if (!match) throw new Error('SkillHub returned no skills for the live query')

  const slug = `${match.namespace}/${match.slug}`
  const url = `${baseUrl}/api/v1/skills/${encodeURIComponent(match.namespace)}/${encodeURIComponent(match.slug)}`
  const loaded = await loadRemoteSkill(slug, url, { cacheDir })
  if (!loaded.content.includes('name') && !loaded.content.includes('#')) {
    throw new Error('Downloaded SKILL.md is empty or malformed')
  }

  const cached = await loadRemoteSkill(slug, url, { cacheDir })
  if (!cached.cacheHit) throw new Error('Versioned SkillHub cache did not hit')
  console.log('SKILLHUB_LIVE_OK')
} finally {
  await rm(cacheDir, { recursive: true, force: true })
}
```

`baseUrl` 默认为 `https://skill.xfyun.cn`，token 只从 `CLAUDE_SKILL_REGISTRY_TOKEN` 注入。验收必须分别覆盖：空搜索、非法下载内容、第二次未命中缓存，以及三条路径都删除临时目录。

## 4. 实现 Cloud 与 desktop 探针

### Cloud

**创建：** `scripts/live-cloud-validation.ts`。

使用同一个 `params(cwd)` 工厂保证两次 bridge 初始化的 `baseUrl`、`orgUUID`、`perpetual:true` 和 cwd 一致：

1. 创建第一个 bridge，写入带 `first.bridgeSessionId` 的 user message，调用 `first.teardown()`。
2. 用同一 cwd 创建第二个 bridge，断言两个 `bridgeSessionId` 完全相同。
3. 设置 `CLAUDE_CODE_REMOTE_SESSION_ID` 和 `CLAUDE_CODE_ENVIRONMENT_KIND=byoc`。
4. 创建 `nested/live.txt`，调用 `runFilePersistence(new Date(0), signal)`，要求至少一个文件。
5. 调用 `second.archive()`，最后执行 cleanup registry 并删除临时 cwd。

**必须显式记录并处理的顺序问题：** 原提交在 `enableConfigs()` 之前读取 `getClaudeAIOAuthTokens()`。验收要从未预加载配置的进程启动；如果 token 为空，应把 `enableConfigs()` 移到 token 读取之前，并将该调整列为后续修复，不能改写为原提交已有行为。

### Desktop

**创建：** `scripts/live-desktop-validation.ts`。

- 变量非 `1`：只输出 `DESKTOP_LIVE_SKIPPED`，不创建客户端。
- 变量为 `1`：调用 `getOpenComputerUseClient()` 和 `screenshot`，检查 `result.isError`。
- `finally` 始终调用 `closeOpenComputerUseClient()`。

## 5. 接入四个 CI job

**创建：** `.github/workflows/live-validation.yml`。

配置 `workflow_dispatch`、每日 `17 6 * * *` 和 `permissions: contents: read`，然后按下表接入脚本：

| job | runner | environment | 独立 HOME/CLAUDE_CONFIG_DIR 前缀 |
|---|---|---|---|
| model | ubuntu-latest | live-validation | `/tmp/flash-live-` |
| skillhub | ubuntu-latest | 无 | `/tmp/flash-skillhub-` |
| cloud | ubuntu-latest | live-validation | `/tmp/flash-cloud-` |
| desktop | self-hosted | live-validation | `/tmp/flash-desktop-` |

每个 job 都执行 checkout、Bun 1.3.14 setup、`bun install --frozen-lockfile`，再运行自己的脚本。

**门控缺陷必须保留在审查结论中：** 原提交给 model/cloud 写了下面的条件：

```yaml
if: github.event_name != 'pull_request' && secrets.ANTHROPIC_API_KEY != ''
```

`secrets` 不能直接用于 `jobs.<job_id>.if`，所以这两处不是可部署的缺配置跳过方案。验收必须使用 `actionlint` 或 GitHub Actions 实际条件求值识别该问题；修正前不得把 workflow 标为完整可用。后续实现应将可用输入经 `env` 传入条件，或把缺配置 guard 放进脚本，并分别验证 skip 与 failure。

## 6. 同步能力边界

**修改：** `docs/STATUS.md`、`docs/RELEASE.md`。

按四个环境分别列出脚本入口、所需配置、成功条件和清理责任。Cloud OAuth、私有 registry、self-hosted desktop 各自独立；不要让 model 或 SkillHub 的状态代替其他环境的状态。

## 7. 分层验收

按以下顺序执行，前一层失败时不进入需要外部服务的一层：

```bash
# 确定性代码契约
bun test tests/skillhubClient.test.ts
bun run typecheck

# workflow 静态检查；secrets job-if 问题必须被处理或明确保留为未达标项
actionlint .github/workflows/live-validation.yml

# 各授权环境分别执行，成功标记只在断言全部完成后出现
bun scripts/live-model-validation.ts
bun scripts/live-skillhub-validation.ts
bun scripts/live-cloud-validation.ts
CLAUDE_DESKTOP_LIVE=1 bun scripts/live-desktop-validation.ts
```

任一 live 脚本失败后，检查其临时目录、客户端和 cleanup 是否按设计释放。回滚时按依赖反向进行：先移除 workflow，再移除探针，最后回滚 SkillHub 映射；不要在客户端映射尚未验证时只删除离线测试来保留功能。
