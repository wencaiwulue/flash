# 发布指南 | Release Guide

本文定义 `flash` 独立二进制和 GitHub Release 的发布流程。历史版本说明继续记录在 [RELEASE.md](RELEASE.md)，本文不记录单次发布结果。

This guide defines the release process for standalone `flash` binaries and GitHub Releases. Version-specific notes remain in [RELEASE.md](RELEASE.md); this guide is not a release-history log.

## 发布契约 | Release Contract

- 版本唯一来源是 `package.json`；标签必须采用严格的 `vX.Y.Z` 格式并与该版本完全一致。/ `package.json` is the single version source. Tags must use strict `vX.Y.Z` semver and match it exactly.
- 发布产物命名为 `flash-vX.Y.Z-<platform>-<arch>.tar.gz`，Windows 使用 `.zip`。/ Assets follow `flash-vX.Y.Z-<platform>-<arch>.tar.gz`, with `.zip` on Windows.
- Release 恰好包含八个资产：六个平台归档、覆盖六个归档的 `SHA256SUMS`，以及独立的 `install.sh`。安装器强制校验归档，但自身不纳入 `SHA256SUMS`。/ A Release contains exactly eight assets: six platform archives, `SHA256SUMS` covering those archives, and a standalone `install.sh`. The installer always verifies archives but is not itself listed in `SHA256SUMS`.
- 首发目标为 macOS ARM64/x64、Linux ARM64/x64、Windows ARM64/x64。/ Targets are macOS ARM64/x64, Linux ARM64/x64, and Windows ARM64/x64.
- 每个目标在对应原生 OS/架构上编译并执行，不能使用未运行验证的交叉产物。/ Every target is compiled and executed on its native OS/architecture; unexecuted cross-compiled assets are not allowed.
- 每个平台归档恰好包含二进制、`README.md` 和 `README.zh-CN.md`；解包检查同时验证成员集合及两份文档与源文件逐字节一致。/ Each platform archive contains exactly the binary, `README.md`, and `README.zh-CN.md`. Extraction checks verify both the exact member set and byte-for-byte equality of the documents with their sources.
- 标签发布先复用完整 CI，再验证六个归档、解包执行结果和 SHA-256。/ Tagged releases reuse the full CI, then verify all six archives, post-extraction execution, and SHA-256 checksums.
- 手动运行只上传保留七天的 workflow artifacts，不创建 Release。/ Manual runs upload workflow artifacts retained for seven days and never create a Release.
- 本次发布形式不包含 npm 包、签名、公证或自动更新器变更。/ This release channel does not include npm publishing, signing, notarization, or updater changes.

## 1. 准备版本 | Prepare the Version

从最新默认分支创建发布分支，选择新的严格 SemVer 版本并更新 `package.json`。如有用户可见变更，在同一次 PR 中更新 [RELEASE.md](RELEASE.md)；不要修改历史条目。

Create a release branch from the latest default branch, choose a new strict semantic version, and update `package.json`. Add user-visible changes to [RELEASE.md](RELEASE.md) in the same PR without rewriting historical entries.

发布版本必须与最终标签一致，例如 `package.json` 为 `1.1.0` 时只能使用 `v1.1.0`。版本不一致会在任何平台构建开始前失败。

The package version must equal the final tag: for example, package version `1.1.0` requires tag `v1.1.0`. A mismatch fails before any platform build starts.

## 2. 本地验证 | Verify Locally

在干净工作区执行与 CI 相同的顺序：

Run the same sequence as CI in a clean workspace:

```bash
sh -n scripts/install.sh
bun install --frozen-lockfile
bun run generate:sdk-types
bun run typecheck
bun run build
bun run test
bun dist/main.js --version
bun dist/main.js --help
bun -e "const sdk = await import('./dist/sdk.mjs'); if (typeof sdk.query !== 'function' || typeof sdk.createSdkMcpServer !== 'function') throw new Error('Invalid SDK exports')"
```

检查 SDK 类型生成是否产生了预期 diff，再为当前主机执行真实二进制验证：

Review any generated SDK-type diff, then exercise a real standalone binary for the current host:

```bash
bun run build:binary
```

该命令会在暂时隐藏并恢复 `node_modules` 的环境中直接执行及解包后执行 `--version`、`--help`，防止 runner 依赖目录掩盖独立运行问题；随后在 `build/release/` 生成归档和对应的 `.sha256` 文件。若需要显式指定目标，目标必须与当前主机一致：

This command runs `--version` and `--help` directly and after extraction with `node_modules` temporarily hidden and restored, preventing runner dependencies from masking standalone runtime failures. It writes the archive and its `.sha256` sidecar to `build/release/`. An explicit target must match the current host:

```bash
bun run build:binary -- --target bun-darwin-arm64
bun scripts/build-binary.ts --release-tag vX.Y.Z --validate-only
```

最后一条只检查标签与版本，不编译；将 `vX.Y.Z` 替换为实际版本。

The final command validates tag/version consistency without compiling; replace `vX.Y.Z` with the actual version.

## 3. 合并并检查 CI | Merge and Check CI

通过 PR 审查并合并版本变更，确认默认分支上的 `ci` 工作流成功。普通 CI 在构建后使用仓库的逐文件隔离测试运行器，并执行 CLI/SDK smoke。

Review and merge the version PR, then confirm the `ci` workflow passes on the default branch. Normal CI builds before running the repository's isolated per-file test runner and finishes with CLI/SDK smoke checks.

如果 CI 失败，先读取实际日志并做窄修复，不要通过跳过测试或上传旧 `dist/` 来绕过：

If CI fails, inspect the real logs and make a focused fix. Do not bypass it by skipping tests or uploading stale `dist/` output:

```bash
gh run list --workflow=ci.yml
gh run view <run-id> --log-failed
```

凭据型 `live-checks.yml` 属于独立环境验证；计划发布的变更影响其覆盖范围时，应在具备授权环境的 runner 上单独确认，不能把跳过状态当作验证成功。

Credentialed `live-checks.yml` is a separate environment validation. When release changes affect its scope, run it in the appropriate authorized environment; a skipped check is not a successful validation.

## 4. 手动试运行 | Run a Release Dry Run

在创建标签前，从默认分支手动运行 `release` 工作流：

Before tagging, manually run the `release` workflow from the default branch:

```bash
gh workflow run release.yml --ref main
gh run list --workflow=release.yml
```

也可以在 GitHub Actions 页面选择 **release → Run workflow**。确认以下结果：

Alternatively, select **release → Run workflow** in GitHub Actions. Confirm that:

1. `validate` 接受 package 版本并通过 `sh -n` 检查安装器语法。/ `validate` accepts the package version and checks installer syntax with `sh -n`.
2. `verify` 完整复用普通 CI。/ `verify` reuses the complete normal CI.
3. 六个 `build` 矩阵任务全部在原生 runner 上成功。/ All six native `build` matrix jobs pass.
4. 每个 `binary-*` artifact 包含一个归档和对应 `.sha256`。/ Each `binary-*` artifact contains one archive and its `.sha256` sidecar.
5. `publish` 被跳过，GitHub Release 没有被创建。/ `publish` is skipped and no GitHub Release is created.

试运行中的二进制已经过直接执行和解包复验，但仍只是 workflow artifacts，不是正式发布渠道。

Dry-run binaries have passed direct and post-extraction execution checks, but they remain workflow artifacts rather than published releases.

## 5. 创建并推送标签 | Create and Push the Tag

只有在试运行成功、版本内容已审查且仓库所有者明确同意对外发布后，才创建标签。标签必须指向刚验证的合并提交，而不是本地旧提交：

Create a tag only after a successful dry run, content review, and explicit owner authorization for the public release. It must point to the verified merge commit, not a stale local commit:

```bash
git switch main
git pull --ff-only
git rev-parse HEAD
git tag vX.Y.Z <verified-merge-commit>
git push origin vX.Y.Z
```

标签推送会自动触发 `release`。不要在标签创建前手动创建同名 GitHub Release。

Pushing the tag automatically triggers `release`. Do not manually create a GitHub Release with the same tag beforehand.

## 6. 观察发布并复验 | Monitor and Verify the Release

```bash
gh run list --workflow=release.yml
gh run view <run-id>
gh run view <run-id> --log-failed
```

发布顺序为 `validate → verify → build → publish`。只有标签事件能进入 `publish`，并且只有该 job 拥有 `contents: write`。发布阶段会核对恰好六个预期归档、验证各自的 sidecar，生成统一的 `SHA256SUMS`，再次执行 `sha256sum -c`，最后创建带 generated release notes 的 GitHub Release，上传六个归档、`SHA256SUMS` 和 `install.sh`。

The order is `validate → verify → build → publish`. Only a tag event can enter `publish`, and only that job has `contents: write`. Publishing checks the exact six expected archives and their sidecars, creates a combined `SHA256SUMS`, verifies it with `sha256sum -c`, then creates the GitHub Release with generated release notes and uploads the six archives, `SHA256SUMS`, and `install.sh`.

发布后从 GitHub Release 重新下载归档和 `SHA256SUMS`，不要复用本地产物。在无 Bun 的干净环境或对应平台上检查：

After publication, download the archive and `SHA256SUMS` from GitHub Releases rather than reusing local output. In a clean environment without Bun, on the corresponding platform, check:

```bash
# macOS
grep '<archive-name>$' SHA256SUMS | shasum -a 256 -c -

# Linux
grep '<archive-name>$' SHA256SUMS | sha256sum -c -

tar -xzf <archive-name>
./flash --version
./flash --help
```

Windows 使用 `tar -xf <archive-name>` 和 `.\flash.exe --version`、`.\flash.exe --help`，并使用 `Get-FileHash -Algorithm SHA256` 对比 `SHA256SUMS`。

On Windows, extract with `tar -xf <archive-name>`, run `.\flash.exe --version` and `.\flash.exe --help`, and compare `Get-FileHash -Algorithm SHA256` against `SHA256SUMS`.

在 macOS/Linux 上还要用隔离的 `HOME` 和 `TMPDIR` 执行真实安装器，以验证 latest 重定向、安装器资产、归档校验、默认路径安装和清理；只声明实际运行过的平台：

On macOS/Linux, also run the real installer with isolated `HOME` and `TMPDIR` directories to verify latest-release resolution, the installer asset, archive verification, default-path installation, and cleanup. Claim only platforms actually exercised:

```bash
install_check="$(mktemp -d)"
mkdir -p "$install_check/home" "$install_check/tmp"
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://github.com/wencaiwulue/flash/releases/latest/download/install.sh -o "$installer"
  HOME="$install_check/home" TMPDIR="$install_check/tmp" sh "$installer"
)
"$install_check/home/.local/bin/flash" --version
"$install_check/home/.local/bin/flash" --help
test -z "$(find "$install_check/tmp" -mindepth 1 -print -quit)"
rm -rf "$install_check"
```

## 7. 失败与修复 | Failures and Fixes

- 标签尚未推送：修复后重新执行本地验证和 dry-run。/ Before a tag is pushed, fix the change and repeat local verification and the dry run.
- 标签已推送但 Release 尚未创建：优先在后续提交修复；不要复用同一标签指向另一个提交。/ If a tag is pushed but no Release exists, prefer a forward fix; do not repoint the tag to another commit.
- Release 已发布：保留原始记录，修复问题并发布新版本；不要移动标签或静默替换同版本资产。/ Once a Release is published, preserve its history, fix forward, and publish a new version. Never move the tag or silently replace same-version assets.
- 某个平台失败：读取该矩阵任务日志，修复具体编译、运行或归档问题；不能删除该目标后继续发布“完整”版本。/ If one platform fails, inspect its matrix log and fix the specific compile, runtime, or packaging issue. Do not silently drop the target and publish a supposedly complete release.

发布门禁只证明独立启动、版本、帮助、归档和 checksum 验证成功。模型服务、ripgrep、图片处理、桌面/远程功能及自动更新需要各自独立的验证，不应由一次成功 Release 推断。

The release gate proves standalone startup, version, help, archive, and checksum verification only. Model providers, ripgrep, image processing, desktop/remote features, and automatic updates require separate validation and must not be inferred from a successful Release.
