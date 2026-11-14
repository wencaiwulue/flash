# README Language Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make English the default root README, add a complete Simplified Chinese counterpart, and package and verify both documents with every standalone binary.

**Architecture:** Use two manually maintained, structurally aligned Markdown files with bidirectional relative language links. Export one release-document manifest from `scripts/build-binary.ts` and derive staging, archive members, and post-extraction assertions from it; use offline Markdown tests for structure and links, then use the existing native binary build for real archive verification.

**Tech Stack:** Markdown, Bun 1.3+, TypeScript, Node filesystem/path APIs, `bun:test`, platform `tar`, existing Bun standalone-binary build and release packaging.

## Global Constraints

- Design reference: `docs/superpowers/specs/2026-11-14-readme-language-split-design.md`.
- Installer security reference: `docs/superpowers/specs/2026-11-14-sh-installer-design.md`; this plan adds shared user instructions but does not implement or redefine installer internals.
- `README.md` is English-only except for the necessary Chinese language-selector label. `README.zh-CN.md` is a complete Simplified Chinese counterpart, not a quick-start excerpt.
- Use exactly `[简体中文](README.zh-CN.md)` and `[English](README.md)` for bidirectional relative links.
- Keep heading-level sequences, the fixed English/Chinese H2 title mapping, code-fence info-string sequences, table shapes, and non-language link destinations aligned. Code-fence bodies and comments may be translated; semantic command parity and translation accuracy remain manual review responsibilities.
- Keep install commands, manual archive steps, version/directory overrides, PATH requirements, supported platforms, and capability limitations aligned.
- Export `RELEASE_DOCUMENTS = ['README.md', 'README.zh-CN.md'] as const`; each archive contains exactly one binary plus those two files.
- Use the same manifest for copying, tar/zip members, extracted-member checks, and extracted-document content checks.
- Do not add the installer or the full `docs/` tree to platform archives. Do not change six-target naming, native-build restrictions, or checksum aggregation.
- Do not claim that repository-relative `docs/` links are packaged offline targets. Only the two language links are self-contained in the archive.
- Do not add test/CI success claims to the documents. Actual results belong in the appropriate verification record after execution.

## 实施理由与步骤依据

1. **先建立可读的结构契约**：拆分前先把逻辑章节、代码块和链接写成测试，防止“中文文件已创建”替代“中文内容完整”。初始 RED 应来自缺少中文文件或双向链接，而不是人为跳过断言。
2. **再写两份用户文档**：测试只消费 Markdown，不需要等待构建代码。先完成内容与人工对照，可让后续打包工作只处理已审阅的源文件。
3. **随后收敛发布文档清单**：复制、打包和解包检查共享一个常量，避免三处列表漂移。清单单元测试先 RED，真实 `build:binary` 再证明 tar 和 extraction 路径确实使用该常量。
4. **安装说明与安装器设计解耦**：README 必须告诉用户如何安装，但不应复制临时文件、信号和 symlink 算法。这样本功能可独立交付，安装器安全修改也不会要求重写两种语言的算法说明。
5. **最后更新维护者指南并做真实构建**：`docs/RELEASING.md` 需要与归档成员一致；本机完整构建用于发现单元测试无法覆盖的 tar 参数、Windows 成员构造共享路径和文档内容差异。其余平台仍由原生 Release runner 验证。
6. **回滚按文档发布功能整体处理**：恢复混排 README、删除中文文件、恢复单文档归档和测试必须一致。若安装器已经落地，回滚不能顺手删除安装器或八资产发布逻辑，只把其用户说明恢复到恢复后的 README 中。

## File Structure

- Modify `README.md`: English-only default documentation, Chinese selector, aligned installation and capability scope.
- Create `README.zh-CN.md`: full Simplified Chinese counterpart and English selector.
- Modify `scripts/build-binary.ts`: export `RELEASE_DOCUMENTS`; derive staging, archive, and extraction verification from it.
- Modify `tests/releasePackaging.test.ts`: Markdown section/code/link tests and release-document manifest tests.
- Modify `docs/RELEASING.md`: state that every platform archive contains the binary and both root READMEs.
- Reference `docs/superpowers/specs/2026-11-14-sh-installer-design.md`: installer behavior remains a separate feature contract.
- Create `docs/superpowers/specs/2026-11-14-readme-language-split-design.md`: approved rationale and behavior contract.
- Create `docs/superpowers/plans/2026-11-14-readme-language-split.md`: this file-level TDD, acceptance, migration, and rollback plan.

---

### Task 1: Define Failing Markdown Structure and Link Tests

**Files:**
- Modify: `tests/releasePackaging.test.ts`
- Test: `tests/releasePackaging.test.ts`

**Interfaces:**
- Consumes: repository-root `README.md` and future `README.zh-CN.md` as UTF-8 Markdown.
- Produces: offline assertions for language links, local file links, heading levels, fixed H2 titles, code-fence info strings, table shapes, non-language link destinations, and English-only prose.

- [ ] **Step 1: Add Markdown parsers with narrow, explicit responsibilities**

Add filesystem imports and helpers to the existing test file. Do not add a Markdown dependency for these stable root-file conventions:

```ts
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')

type MarkdownSection = {
  heading: string
  codeBlocks: string[]
}

function sections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n')
  const result: MarkdownSection[] = []
  let current: MarkdownSection | undefined
  let fence: { marker: string; lines: string[] } | undefined

  for (const line of lines) {
    const fenceStart = /^```(.*)$/.exec(line)
    if (fenceStart && !fence) {
      fence = { marker: fenceStart[1], lines: [] }
      continue
    }
    if (line === '```' && fence) {
      current?.codeBlocks.push(`\`\`\`${fence.marker}\n${fence.lines.join('\n')}\n\`\`\``)
      fence = undefined
      continue
    }
    if (fence) {
      fence.lines.push(line)
      continue
    }
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      current = { heading: heading[1], codeBlocks: [] }
      result.push(current)
    }
  }
  expect(fence).toBeUndefined()
  return result
}

function localLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/(?<!!)\[[^]]*\]\(([^)]+)\)/g)]
    .map(match => match[1].split('#')[0])
    .filter(target => target && !/^[a-z][a-z0-9+.-]*:/i.test(target))
}
```

The parser intentionally handles the root README’s simple fenced-block and inline-link forms rather than claiming full CommonMark parsing. If those documents later adopt nested fences or titled links, extend the fixture and parser together.

- [ ] **Step 2: Write the failing language and alignment tests**

Use a fixed bilingual heading map so same-count but reordered or omitted sections fail:

```ts
describe('root README language counterparts', () => {
  test('link to each other and keep aligned sections and code', async () => {
    const english = await readFile('README.md', 'utf8')
    const chinese = await readFile('README.zh-CN.md', 'utf8')

    expect(english).toContain('[简体中文](README.zh-CN.md)')
    expect(chinese).toContain('[English](README.md)')
    expect(english).not.toContain('[English](README.md)')
    expect(chinese).not.toContain('[简体中文](README.zh-CN.md)')

    const expectedHeadings = [
      ['Overview', '概述'],
      ['Quick Start', '快速开始'],
      ['Standalone Binaries', '独立二进制'],
      ['Agent SDK', 'Agent SDK'],
      ['Development', '开发'],
      ['Repository Layout', '仓库结构'],
      ['Documentation', '文档'],
    ]
    const englishSections = sections(english)
    const chineseSections = sections(chinese)
    expect(englishSections.map(section => section.heading)).toEqual(
      expectedHeadings.map(([heading]) => heading),
    )
    expect(chineseSections.map(section => section.heading)).toEqual(
      expectedHeadings.map(([, heading]) => heading),
    )
    const infoStrings = (markdown: string) =>
      [...markdown.matchAll(/^```([^\s`]+)\s*$/gm)].map(match => match[1])
    expect(infoStrings(chinese)).toEqual(infoStrings(english))
    // The complete test also compares heading levels, table shapes, and
    // non-language link destinations. It deliberately does not compare
    // code-fence bodies or comments byte-for-byte.
  })

  test('resolves local links without network access', async () => {
    for (const name of ['README.md', 'README.zh-CN.md']) {
      const markdown = await readFile(name, 'utf8')
      for (const target of localLinkTargets(markdown)) {
        expect(
          existsSync(resolve(dirname(resolve(repositoryRoot, name)), target)),
          `${name} links to missing ${target}`,
        ).toBe(true)
      }
    }
  })

  test('does not retain bilingual prose in the English default', async () => {
    const english = await readFile('README.md', 'utf8')
    const withoutLanguageSelector = english
      .split('\n')
      .filter(line => !line.includes('[简体中文](README.zh-CN.md)'))
      .join('\n')
    expect(withoutLanguageSelector).not.toMatch(/[㐀-鿿]/u)
  })
})
```

This test does not assert that Chinese is a perfect translation. Add a review checklist for equivalent claims rather than inventing an unreliable CJK-percentage test.

- [ ] **Step 3: Run the focused test and verify RED**

```bash
bun run test tests/releasePackaging.test.ts
```

Expected: FAIL because `README.zh-CN.md` does not yet exist and the English file still has bilingual headings/prose. Existing checksum and target tests should remain unchanged; do not delete them to isolate the new behavior.

---

### Task 2: Write the English Default and Complete Chinese Counterpart

**Files:**
- Modify: `README.md`
- Create: `README.zh-CN.md`
- Test: `tests/releasePackaging.test.ts`

**Interfaces:**
- Consumes: current product scope in `docs/STATUS.md`, release behavior in `docs/RELEASING.md`, and the approved installer user contract.
- Produces: two aligned root documents with no generated translation artifacts.

- [ ] **Step 1: Establish the shared document skeleton and selectors**

Start `README.md` with:

```md
# Claude Code

[简体中文](README.zh-CN.md)

Educational/research snapshot of Claude Code: an agentic coding CLI and TypeScript Agent SDK built with Bun, React, and Ink.

## Overview
```

Start `README.zh-CN.md` with:

```md
# Claude Code

[English](README.md)

Claude Code 的教学/研究快照：使用 Bun、React 和 Ink 构建的智能体编程 CLI 与 TypeScript Agent SDK。

## 概述
```

Use the seven logical sections in the test map. Translate prose and table labels in the Chinese file; keep product names, API symbols, paths, filenames, and commands identical. Remove `/ English...` suffixes and `标题 | Title` patterns rather than retaining two paragraphs per concept.

- [ ] **Step 2: Carry over identical build, SDK, and repository examples**

Keep the existing source-build commands unchanged in both files:

```bash
bun install --frozen-lockfile
bun run build

bun dist/main.js --version
bun dist/main.js --help
```

Copy every SDK import, API symbol, development command, manual tar/PowerShell example, and checksum example to both files with equivalent command semantics. Code-fence bodies and comments need not match byte-for-byte: repository-tree and checksum comments may be translated. The automated comparison covers info-string sequences, not bodies; manually review every command and comment for semantic parity.

- [ ] **Step 3: Add the shared installer instructions without copying security internals**

In both Standalone Binaries sections, describe the installer as available for macOS/Linux x64 and ARM64 in Releases that publish `install.sh`:

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://github.com/wencaiwulue/flash/releases/latest/download/install.sh -o "$installer"
  sh "$installer"
)
claude-code --version
```

Document the default `$HOME/.local/bin` and the strict override form:

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://github.com/wencaiwulue/flash/releases/latest/download/install.sh -o "$installer"
  VERSION=v1.0.0 INSTALL_DIR="$HOME/.local/bin" sh "$installer"
)
```

Use an actual existing version only when documenting a concrete installed release; `v1.0.0` is the intended first-release example and must not be presented as a published historical fact before publication. Explain that the installer downloads the matching archive and `SHA256SUMS`, verifies the selected archive, and prints PATH guidance when needed. Do not say it signs/notarizes the binary, updates automatically, supports Windows, or works from Releases that predate the installer.

Keep manual downloads for all six targets and retain the scoped statement that release checks do not validate model providers or every optional native integration. Link detailed security behavior to the approved design only in maintainer documentation if needed; user README should remain task-oriented.

- [ ] **Step 4: Align claims and repository links manually**

Compare each section against `docs/STATUS.md` and the release guide. Preserve these boundaries in both languages:

- assets appear only after an applicable Release is published;
- source build/version/help/import checks do not prove a live model connection;
- external builds excluding a feature do not prove that feature is implemented;
- no signing, notarization, or GitHub-Releases-based automatic update is promised;
- only the two root README language links are guaranteed to resolve offline inside the three-member archive; other guides use GitHub `main` URLs so they also open from an extracted README when online.

Check that relative language links resolve and that the two languages use identical non-language destinations. Use absolute GitHub guide links rather than archive-broken `docs/...` relative links.

- [ ] **Step 5: Run the Markdown tests and review semantic parity**

```bash
bun run test tests/releasePackaging.test.ts
git diff --check -- README.md README.zh-CN.md tests/releasePackaging.test.ts
```

Expected: the new document tests PASS. Review the rendered English and Chinese files side by side for omissions, mistranslated limitations, and broken tables. The release-manifest test has not been added yet, so this step does not prove packaging.

- [ ] **Step 6: Commit the document split and its regression tests**

```bash
git add README.md README.zh-CN.md tests/releasePackaging.test.ts
git commit -m "Split English and Chinese root READMEs"
```

---

### Task 3: Drive Archive Staging and Verification from `RELEASE_DOCUMENTS`

**Files:**
- Modify: `tests/releasePackaging.test.ts`
- Modify: `scripts/build-binary.ts`
- Test: `tests/releasePackaging.test.ts`

**Interfaces:**
- Produces: `export const RELEASE_DOCUMENTS: readonly ['README.md', 'README.zh-CN.md']`.
- Consumes: existing `buildBinary()`, `getBinaryName()`, `stageDir`, `extractDir`, and platform-specific tar flags.
- Preserves: six-target archive names, native target checks, executable-bit checks, binary smoke tests, and six-archive checksum sidecars.

- [ ] **Step 1: Add the failing release-manifest test**

Import `RELEASE_DOCUMENTS` with the existing build-script imports, then add:

```ts
describe('release documents', () => {
  test('packages both root language counterparts exactly once', () => {
    expect(RELEASE_DOCUMENTS).toEqual(['README.md', 'README.zh-CN.md'])
    expect(new Set(RELEASE_DOCUMENTS).size).toBe(2)
    for (const name of RELEASE_DOCUMENTS) {
      expect(name).not.toMatch(/^[\\/]/)
      expect(name).not.toContain('/')
      expect(name).not.toContain('\\')
      expect(existsSync(resolve(repositoryRoot, name))).toBe(true)
    }
  })
})
```

Run:

```bash
bun run test tests/releasePackaging.test.ts
```

Expected: FAIL because the export does not exist. Do not satisfy this test with a test-local duplicate list.

- [ ] **Step 2: Export the manifest and use it for staging**

At the build metadata declarations in `scripts/build-binary.ts` add:

```ts
export const RELEASE_DOCUMENTS = [
  'README.md',
  'README.zh-CN.md',
] as const
```

Replace the single README copy with a sequential loop so source-copy errors retain their file context:

```ts
await copyFile(binaryPath, join(stageDir, binaryName))
for (const document of RELEASE_DOCUMENTS) {
  await copyFile(document, join(stageDir, document))
}
const archiveMembers = [binaryName, ...RELEASE_DOCUMENTS]
```

Use paths relative to the repository root consistently with the existing script invocation. Do not silently skip a missing translation or fall back to `README.md`.

- [ ] **Step 3: Use the same members for tar and exact extraction checks**

Replace the hard-coded tar member and expected-file arrays:

```ts
const archive = spawn(
  ['tar', ...archiveFlags.split(' '), archivePath, ...archiveMembers],
  { cwd: stageDir },
)
assertCommandSucceeded(archive, `Create ${basename(archivePath)}`)

const extract = spawn(['tar', '-xf', archivePath, '-C', extractDir])
assertCommandSucceeded(extract, `Extract ${basename(archivePath)}`)
const archivedFiles = (await readdir(extractDir)).toSorted()
const expectedFiles = archiveMembers.toSorted()
if (
  archivedFiles.length !== expectedFiles.length ||
  archivedFiles.some((name, index) => name !== expectedFiles[index])
) {
  throw new Error(`Unexpected archive contents: ${archivedFiles.join(', ')}`)
}

for (const document of RELEASE_DOCUMENTS) {
  const [source, extracted] = await Promise.all([
    readFile(document),
    readFile(join(extractDir, document)),
  ])
  if (!source.equals(extracted)) {
    throw new Error(`Extracted release document differs: ${document}`)
  }
}
```

Keep the archive output path outside `stageDir` as before, so an old archive cannot accidentally include itself. Do not use `tar ... .` or a wildcard; explicit members are the security and correctness boundary.

- [ ] **Step 4: Run focused tests and a real native archive build**

```bash
bun run test tests/releasePackaging.test.ts
bun run typecheck
bun run build:binary
```

Expected: focused tests and typecheck PASS; the native build compiles and smokes the binary, then extracts an archive whose only members are the binary and two byte-identical READMEs. Inspect the actual output with a host-appropriate command, for example on the current macOS/Linux host:

```bash
archive=$(bun -e "import { getArchiveName, getHostTarget } from './scripts/build-binary.ts'; process.stdout.write('build/release/' + getArchiveName(getHostTarget()))")
tar -tzf "$archive"
```

The archive name comes from the current `package.json` and host target rather than a hard-coded historical version. If another archive already occupies that path, inspect its modification time and compare it with the path printed by the just-completed build before drawing a conclusion.

- [ ] **Step 5: Commit the packaging change**

```bash
git add scripts/build-binary.ts tests/releasePackaging.test.ts
git commit -m "Package bilingual READMEs with standalone binaries"
```

---

### Task 4: Align the Release Guide and Complete Acceptance/Rollback Review

**Files:**
- Modify: `docs/RELEASING.md`
- Create: `docs/superpowers/specs/2026-11-14-readme-language-split-design.md`
- Create: `docs/superpowers/plans/2026-11-14-readme-language-split.md`

**Interfaces:**
- Consumes: implemented three-member archive behavior and the independent installer release contract.
- Produces: maintainer instructions and independently understandable design/implementation records.

- [ ] **Step 1: Update the release guide without expanding its claims**

Where the guide describes compilation, extraction, and workflow artifacts, state that each archive contains the platform binary, `README.md`, and `README.zh-CN.md`, and that extraction checks the exact three-member set. Keep six archives and six `SHA256SUMS` entries unchanged. Do not say the full documentation tree is included or that all repository links work offline.

If the installer feature is implemented in the same release, link to its eight-asset release guidance rather than duplicating installer security steps here.

- [ ] **Step 2: Verify the design and plan are independently reviewable**

Confirm the spec explains the reader problem, constraints, why two files and one manifest were chosen, alternatives, interfaces, data flow, failure semantics, and acceptance criteria. Confirm this plan includes exact files, representative test/implementation code, RED/GREEN commands, ordering rationale, and rollback. Do not add commit mappings or historical test/CI claims.

- [ ] **Step 3: Run the complete local acceptance sequence**

```bash
bun install --frozen-lockfile
bun run test tests/releasePackaging.test.ts
bun run typecheck
bun run build
bun run build:binary
bun run test
bun dist/main.js --version
bun dist/main.js --help
git diff --check
```

Inspect the newly printed archive and its extraction output. Confirm two language links work from the extraction directory and that the only files are the expected binary and two documents. Do not interpret the current-host build as validation of the other five targets or as a live model/integration test.

- [ ] **Step 4: Review migration behavior**

No user-data, SDK, CLI, or lockfile migration is required. Existing source links to `README.md` remain valid; add/update direct Chinese navigation only through the new selector. Published historical archives are immutable and remain single-document artifacts; this feature applies only to newly built archives and must not retroactively describe old Releases as bilingual.

- [ ] **Step 5: Review and rehearse rollback scope**

Rollback must revert the build manifest and staging/extraction changes, restore the previous bilingual `README.md`, remove `README.zh-CN.md`, revert the release-guide wording, and revert the associated tests as one coherent change. After rollback, run:

```bash
bun run test tests/releasePackaging.test.ts
bun run typecheck
bun run build:binary
```

Expected rollback behavior: the archive returns to its prior exact binary + `README.md` contract. Do not delete or rewrite historical Release assets.

If `scripts/install.sh` or its Release workflow changes have already landed, keep them intact. Restore their shared installation instructions in the rolled-back bilingual README and retain the independent installer tests; a language-layout rollback must never disable checksum verification or remove the eighth Release asset.

- [ ] **Step 6: Commit the maintainer and feature documentation**

```bash
git add docs/RELEASING.md docs/superpowers/specs/2026-11-14-readme-language-split-design.md docs/superpowers/plans/2026-11-14-readme-language-split.md
git commit -m "Document README language split design"
```
