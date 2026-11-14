# POSIX sh Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a checksum-verifying, atomic, user-level macOS/Linux installer downloaded with `curl` and executed by `sh`, test it entirely against a local fake Release, and publish it as the eighth GitHub Release asset.

**Architecture:** Keep all installation behavior in a POSIX `sh` script whose side effects begin only at a final `main "$@"` call. Resolve latest through the releases-root redirect, verify one exact `SHA256SUMS` entry before extracting only `claude-code` under `TMPDIR`, and commit through a final same-`INSTALL_DIR` `mktemp` file plus atomic rename. Drive real shell subprocesses with a local HTTP server and fake `uname`, then add `sh -n` and direct `scripts/install.sh` upload to `release.yml`.

**Tech Stack:** POSIX `sh`, `curl`, `uname`, `tar`, `mktemp`, `sha256sum`/`shasum`, standard POSIX file utilities, Bun 1.3+, TypeScript, `bun:test`, Node `http`/filesystem/crypto/child-process APIs, GitHub Actions.

## Global Constraints

- Design reference: `docs/superpowers/specs/2026-11-14-sh-installer-design.md`.
- README/archive document ownership: `docs/superpowers/specs/2026-11-14-readme-language-split-design.md`; preserve binary + two READMEs in each platform archive.
- Canonical user command: in a `set -e` subshell, download the Release `install.sh` to a `mktemp` file with `curl -fsSL -o`, execute it with `sh "$installer"`, and remove it through an EXIT trap so download failures propagate instead of becoming empty-script successes.
- Script must be POSIX `sh` with `set -eu`; no Bash-only syntax and no ShellCheck dependency.
- Default base is `https://github.com/wencaiwulue/flash/releases`; `CLAUDE_CODE_DOWNLOAD_BASE_URL` is internal and used only by local tests.
- Latest comes from the releases-root `/latest` redirect and must resolve under that same root’s `/tag/` prefix. Explicit or resolved `VERSION` must be strict `vX.Y.Z`, with no leading zeros, missing components, extra components, or prerelease/build suffix.
- `INSTALL_DIR` defaults to `$HOME/.local/bin`; target is always `$INSTALL_DIR/claude-code`.
- Support Darwin/Linux and `arm64|aarch64 → arm64`, `x86_64|amd64 → x64`; no Windows installer or fallback target.
- Download archive and `SHA256SUMS` from the same resolved Release. Require exactly one valid, exact selected-archive entry and a matching digest before running tar.
- Extract only `claude-code`; require a non-symlink regular file. Do not install either README or extra archive members.
- Create the download/extraction work directory under `${TMPDIR:-/tmp}`. Only final staging uses same-`INSTALL_DIR` `mktemp`, `chmod 0755`, and atomic `mv -f`; create `INSTALL_DIR` only after checksum verification and extraction. Never copy through a destination symlink.
- No `sudo`, prompts, stdin confirmation, insecure curl flags, checksum bypass, automatic shell-rc edits, or automatic updates.
- Clean up owned temporary paths on normal/error exit and HUP/INT/TERM. Before the rename, preserve the existing target on failure.
- Release validation runs `sh -n scripts/install.sh`; the explicit upload list directly includes `scripts/install.sh`, producing `install.sh` alongside six archives + `SHA256SUMS` = eight assets. No build/release copy or separate pre-publish eight-asset check. Sidecars remain intermediate artifacts and the aggregate manifest still has six archive entries.
- Do not claim tests, dry-runs, CI, public Releases, or live model integrations have already passed.

## 实施理由与步骤依据

1. **先建立真实子进程测试，而不是 source-text mock**：安装器的核心风险在 shell 展开、工具输出、文件模式、rename 和清理，而不是 TypeScript 函数返回值。通过本地 HTTP Release 执行真实 `sh` 才能观察这些行为，同时消除公网和真实 tag 的不确定性；信号 trap 是设计契约，不伪装成当前信号测试覆盖。
2. **先写完整失败契约，再创建脚本**：latest、严格版本、平台映射、checksum、tar 成员和原子替换是同一个安装事务。先让测试因脚本缺失 RED，再一次性实现完整事务，避免提交一个会暂时跳过 checksum 的“可用”中间安装器。
3. **用 fake uname 和受控 PATH 覆盖代表分支**：Darwin/Linux 不能仅靠当前宿主机证明，使用四个代表性 OS/alias 映射；缺少 digest 工具的场景通过仅链接其他必需命令的 PATH 触发。不要声称四种组合覆盖所有别名或两种 digest 成功路径都被分别执行。
4. **把网络信任与文件提交分开验证**：HTTP/digest 故障必须发生在 tar 之前，文件故障必须发生在 rename 之前。测试同时记录请求、tar 调用、旧目标和临时路径，避免只检查最终 exit code。
5. **最后修改发布工作流**：安装器行为先由本地端到端测试定义，之后再用 `sh -n` 和 YAML 发布列表把同一源码文件接入 Release。这样不会先发布一个语义未定义的入口。
6. **回滚区分仓库与未来 Release**：回滚源码/工作流只影响后续构建，不能移动 tag、替换历史资产或卸载用户二进制。双语 README 打包是独立功能，安装器回滚时不得一并撤销。

## File Structure

- Create `scripts/install.sh`: POSIX installer, version/target resolution, checksum enforcement, selective extraction, staging, atomic replacement, traps, and PATH guidance.
- Create `tests/installScript.test.ts`: local fake Release, fake `uname`, real shell integration tests, and success/failure cleanup.
- Modify `.github/workflows/release.yml`: validate with `sh -n` and directly upload `scripts/install.sh` as `install.sh`; verify the resulting eight assets only after publication.
- Modify `docs/RELEASING.md`: document installer syntax validation, eight public assets, and scoped post-release installation verification.
- Preserve `scripts/build-binary.ts` and `tests/releasePackaging.test.ts`: six archive names/checksums and binary + two README archive contents remain owned by the README/release feature.
- Create `docs/superpowers/specs/2026-11-14-sh-installer-design.md`: approved security, behavior, and failure contract.
- Create `docs/superpowers/plans/2026-11-14-sh-installer.md`: this TDD and rollback plan.

---

### Task 1: Build a Local Fake Release and Failing End-to-End Installer Tests

**Files:**
- Create: `tests/installScript.test.ts`
- Test: `tests/installScript.test.ts`

**Interfaces:**
- Consumes: `scripts/install.sh` through `/bin/sh`, local releases-root HTTP URLs, fake `uname`, controlled PATH for missing digest tools, and generated tar archives.
- Produces: assertions over HTTP requests, exit codes, stdout/stderr, installed bytes/mode, symlink referents, and TMPDIR cleanup.

- [ ] **Step 1: Implement isolated fake-release helpers**

Use Bun/Node APIs to generate a real archive containing an executable fake CLI and both README names. The fake CLI should print a unique value so installed bytes can be observed without a real Claude Code binary; do not claim coverage of arbitrary extra members beyond these two READMEs:

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')
const installer = join(repositoryRoot, 'scripts/install.sh')
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function makeFakeArchive(version: string, target: string) {
  const directory = await mkdtemp(join(tmpdir(), 'fake-release-archive-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const archiveName = `claude-code-${version}-${target}.tar.gz`
  await writeFile(
    join(directory, 'claude-code'),
    '#!/bin/sh\nprintf "%s\\n" "fake-claude-code-v1.2.3"\n',
    { mode: 0o755 },
  )
  await writeFile(join(directory, 'README.md'), 'do not install')
  await writeFile(join(directory, 'README.zh-CN.md'), 'do not install')
  const archivePath = join(directory, archiveName)
  const result = Bun.spawnSync({
    cmd: [
      'tar', '-czf', archivePath, '-C', directory,
      'claude-code', 'README.md', 'README.zh-CN.md',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const bytes = await readFile(archivePath)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  return { archiveName, bytes, checksum }
}
```

Create an HTTP fixture whose server root is the releases-root override, with routes `/latest`, `/tag/v1.2.3`, `/download/v1.2.3/<asset>`, and `/download/v1.2.3/SHA256SUMS`. Record every `req.url`. Return a 302 to the same root’s `/tag/v1.2.3`, actual bytes for selected archives, and a manifest containing all four Unix fake archives. Do not use the real GitHub host in any test.

```ts
type FakeRelease = Awaited<ReturnType<typeof makeFakeArchive>> & {
  baseUrl: string
  requests: string[]
  setManifest(text: string): void
}

async function serveFakeRelease(target = 'darwin-arm64'): Promise<FakeRelease> {
  const archive = await makeFakeArchive('v1.2.3', target)
  const requests: string[] = []
  let manifest = `${archive.checksum}  ${archive.archiveName}\n${'b'.repeat(64)}  claude-code-v1.2.3-linux-x64.tar.gz\n`
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/'
    requests.push(url)
    if (url === '/latest') {
      response.writeHead(302, { location: '/tag/v1.2.3' }).end()
    } else if (url === '/tag/v1.2.3') {
      response.end('release')
    } else if (url === `/download/v1.2.3/${archive.archiveName}`) {
      response.end(archive.bytes)
    } else if (url === '/download/v1.2.3/SHA256SUMS') {
      response.end(manifest)
    } else {
      response.writeHead(404).end('not found')
    }
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  cleanups.push(() => new Promise<void>(resolveClose => server.close(() => resolveClose())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  return {
    ...archive,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    setManifest(text: string) { manifest = text },
  }
}
```

If tests need delayed responses, add an explicit route/promise hook to the fixture and close active sockets during cleanup. Never leave a hanging server to make a negative test pass by timeout.

- [ ] **Step 2: Build controlled tool directories and a real-shell runner**

Create a fake `uname` directory for platform cases. For the missing-checksum-tool case, create a temporary `bin/` containing symlinks to real `curl`, `uname`, `tar`, `mktemp`, `grep`, `awk`, `cp`, `chmod`, `mv`, `mkdir`, and `rm`, but no `sha256sum` or `shasum`. Resolve host tool paths and fail test setup clearly if a prerequisite is absent. Other cases may retain the host’s available digest implementation; do not claim both implementations are independently exercised.

The fake `uname` can be:

```sh
#!/bin/sh
case "$1" in
  -s) printf '%s\n' "$FAKE_UNAME_S" ;;
  -m) printf '%s\n' "$FAKE_UNAME_M" ;;
  *) exit 2 ;;
esac
```

Use the controlled PATH only for the no-digest-tool case and fake `uname` for OS/architecture selection. Do not add production switches or claim a synthetic implementation of both digest tools. Record requests and inspect TMPDIR after success/failure; no tar-invocation logging is required by the implemented suite.

The following is illustrative harness pseudocode rather than a required helper signature; the implemented runner inherits `process.env` and overrides `HOME`, `TMPDIR`, `INSTALL_DIR`, `VERSION`, the releases-root URL, and PATH per case:

```ts
type RunOptions = {
  baseUrl: string
  installDir: string
  version?: string
  os?: string
  machine?: string
  digestTool?: 'sha256sum' | 'shasum' | 'none'
}

function runInstaller(options: RunOptions) {
  const env: NodeJS.ProcessEnv = {
    HOME: join(options.installDir, 'home'),
    INSTALL_DIR: options.installDir,
    PATH: options.toolPath,
    CLAUDE_CODE_DOWNLOAD_BASE_URL: options.baseUrl,
    FAKE_UNAME_S: options.os ?? 'Darwin',
    FAKE_UNAME_M: options.machine ?? 'arm64',
  }
  if (options.version !== undefined) env.VERSION = options.version
  const result = Bun.spawnSync({
    cmd: ['/bin/sh', installer],
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}
```

The real runner supplies an isolated `TMPDIR`, defaults to explicit `VERSION`/`INSTALL_DIR`, and allows individual tests to override them with empty values. Set loopback `NO_PROXY`/`no_proxy` for the local server. Default-HOME coverage uses `INSTALL_DIR: ''`; already-on-PATH coverage prefixes the install directory to the fake-uname PATH.

- [ ] **Step 3: Add failing success-path and platform-matrix tests**

The first end-to-end case should distinguish latest resolution from explicit version and verify selective extraction/mode:

```ts
test('resolves latest, verifies, extracts only the CLI, and prints PATH guidance', async () => {
  const release = await serveFakeRelease('darwin-arm64')
  const installDir = await makeInstallDirectory()
  const tools = await makeToolDirectory({ digestTool: 'sha256sum' })
  const result = runInstaller({
    baseUrl: release.baseUrl,
    installDir,
    toolPath: tools,
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(release.requests[0]).toBe('/latest')
  expect(release.requests).toContain(
    '/download/v1.2.3/claude-code-v1.2.3-darwin-arm64.tar.gz',
  )
  expect(await readFile(join(installDir, 'claude-code'), 'utf8')).toContain(
    'fake-claude-code-v1.2.3',
  )
  expect((await stat(join(installDir, 'claude-code'))).mode & 0o777).toBe(0o755)
  expect((await readdir(installDir)).sort()).toEqual(['claude-code'])
  expect(result.stdout).toContain('PATH')
})
```

Use four representative mappings—Darwin `arm64`, Darwin `x86_64`, Linux `aarch64`, and Linux `amd64`—and assert each exact request, executable output, and mode `0755`. Combine latest resolution with default-HOME and already-on-PATH coverage. Do not add a `shasum`-only success requirement or claim every OS/alias cross-product.

Run the file now to establish RED:

```bash
bun run test tests/installScript.test.ts
```

Expected: FAIL because `scripts/install.sh` does not exist. This is the intended initial failure; subsequent implementation must make assertions pass without removing server, mode, member, or PATH checks.

- [ ] **Step 4: Add the remaining failing security and failure-contract tests**

Before implementing the script, add the implemented contract cases:

- `VERSION=v1.2`, unsupported FreeBSD/`riscv64`, and HTTP 404, without claiming exhaustive malformed-version coverage;
- wrong, missing, duplicate, and malformed selected checksum entries with old-target preservation;
- corrupt tar, missing `claude-code`, and archive `claude-code` implemented as a symlink;
- existing target symlink replacement with unchanged referent on success;
- both checksum tools absent before download;
- cleanup failure after completed installation, with Warning, exit 1, and the new binary retained.

Representative checksum/atomicity case:

```ts
test('rejects a duplicate checksum entry and preserves the old target', async () => {
  const release = await serveFakeRelease('linux-x64')
  release.setManifest(
    `${release.checksum}  ${release.archiveName}\n` +
    `${release.checksum}  ${release.archiveName}\n`,
  )
  const installDir = await makeInstallDirectory()
  await writeFile(join(installDir, 'claude-code'), 'old-binary')
  const tools = await makeToolDirectory({
    digestTool: 'sha256sum',
    os: 'Linux',
    machine: 'x86_64',
  })
  const result = runInstaller({
    baseUrl: release.baseUrl,
    installDir,
    toolPath: tools.path,
    version: 'v1.2.3',
    os: 'Linux',
    machine: 'x86_64',
  })
  expect(result.status).not.toBe(0)
  expect(await readFile(join(installDir, 'claude-code'), 'utf8')).toBe('old-binary')
  expect((await readdir(installDir)).sort()).toEqual(['claude-code'])
})
```

For the symlink success case, create `outside` with `do-not-modify`, symlink `$INSTALL_DIR/claude-code` to it, install successfully, then assert the target is no longer a symlink, target mode is `0755`, and `outside` still has exactly its original bytes.

- [ ] **Step 5: Add cleanup-failure coverage without claiming signal tests**

Place an `rm` shim that exits 1 beside fake `uname`, then run an otherwise successful installation. Assert exit 1, a temporary-directory Warning, and an installed mode-`0755` binary. This covers the implemented “cleanup alone fails after commit” path. Keep HUP/INT/TERM statuses in the shell design, but do not add or claim signal fixtures in this suite.

```ts
await writeFile(rmShim, '#!/bin/sh\nexit 1\n')
await chmod(rmShim, 0o755)
const result = await runInstaller({ PATH: fakeUnamePath })
expect(result.exitCode).toBe(1)
expect(result.stderr).toContain('Warning: unable to remove temporary directory')
expect((await stat(binary)).mode & 0o777).toBe(0o755)
```

- [ ] **Step 6: Confirm the complete contract remains RED for the intended reason**

```bash
bun run test tests/installScript.test.ts
sh -n scripts/install.sh
```

Expected: tests fail at the missing installer and `sh -n` reports the missing file. Do not create an empty executable just to change the failure: the next task must implement the entire tested transaction.

---

### Task 2: Implement the Complete POSIX Installer Transaction

**Files:**
- Create: `scripts/install.sh`
- Test: `tests/installScript.test.ts`

**Interfaces:**
- Consumes: `VERSION`, `INSTALL_DIR`, `HOME`, `PATH`, and internal `CLAUDE_CODE_DOWNLOAD_BASE_URL`.
- Produces: `$INSTALL_DIR/claude-code` mode `0755`, stdout success/PATH guidance, stderr diagnostics, and standard/signal exit statuses.
- Owns: one `work_dir` generated by `mktemp` under `${TMPDIR:-/tmp}` and at most one `staging_file` generated under `INSTALL_DIR` after verified extraction.

- [ ] **Step 1: Establish function-only loading, cleanup, and strict version validation**

Create the script with constants/environment initialization and function definitions, but no top-level installation side effects. Use the implemented helper names and keep latest/target/checksum logic inline in `main`:

```sh
#!/bin/sh
set -eu

REPOSITORY='https://github.com/wencaiwulue/flash'
BINARY_NAME='claude-code'
RELEASES_URL=${CLAUDE_CODE_DOWNLOAD_BASE_URL:-"$REPOSITORY/releases"}
RELEASES_URL=${RELEASES_URL%/}
VERSION=${VERSION:-}
INSTALL_DIR=${INSTALL_DIR:-}
work_dir=''
staging_file=''

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

valid_version() {
  printf '%s\n' "$1" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
}
```

`cleanup()` records `$?`, disables EXIT/HUP/INT/TERM traps, and attempts both owned removals even if one fails. It prints Warning diagnostics, preserves an existing nonzero installation status, and changes status 0 to 1 only when cleanup itself fails. Use `work_dir` and `staging_file`; clear the latter immediately after rename.

At the bottom of the file, after the complete `main` body, place exactly `main "$@"`. Reject positional arguments and install HUP/INT/TERM traps with exit 129/130/143. Do not require separate `resolve_version`, `select_target`, `expected_checksum`, or `verify_checksum` functions.

- [ ] **Step 2: Implement preflight, default directory, target mapping, and downloads**

Inside `main`, run traps/preflight, select the digest command, establish the default directory and inline target mapping, then resolve latest against the same releases root. Create only the TMPDIR work directory before download:

```sh
for command in curl uname tar mktemp grep awk cp chmod mv mkdir rm; do
  require_command "$command"
done
if command -v sha256sum >/dev/null 2>&1; then
  checksum_command='sha256sum'
elif command -v shasum >/dev/null 2>&1; then
  checksum_command='shasum'
else
  fail 'Required command not found: sha256sum or shasum'
fi

if [ -z "$VERSION" ]; then
  latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$RELEASES_URL/latest") ||
    fail 'Unable to resolve the latest release.'
  case "$latest_url" in
    "$RELEASES_URL/tag/"*) VERSION=${latest_url#"$RELEASES_URL/tag/"} ;;
    *) fail 'The server returned an unexpected latest-release URL.' ;;
  esac
fi
valid_version "$VERSION" || fail "Invalid version: $VERSION. Expected vX.Y.Z."

archive_name="$BINARY_NAME-$VERSION-$platform-$architecture.tar.gz"
release_url="$RELEASES_URL/download/$VERSION"
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/claude-code-install.XXXXXX")
archive_path="$work_dir/$archive_name"
manifest_path="$work_dir/SHA256SUMS"
curl -fsSL "$release_url/SHA256SUMS" -o "$manifest_path" || fail 'Unable to download SHA256SUMS.'
curl -fsSL "$release_url/$archive_name" -o "$archive_path" || fail "Unable to download $archive_name."
```

Keep Darwin/Linux and alias mapping inline before this block. Preserve `curl -f` so 404 content is never accepted. Explicit versions bypass latest; do not create `INSTALL_DIR` until verified extraction is complete.

- [ ] **Step 3: Require one exact manifest entry and verify before tar**

Use inline `awk` to require exactly one valid two-space entry, then compare the selected digest implementation before tar:

```sh
expected_checksum=$(awk -v name="$archive_name" '
  $2 == name {
    count++
    checksum = $1
    if (NF != 2 || length(checksum) != 64 || checksum ~ /[^0-9a-f]/ || $0 != checksum "  " name) {
      invalid = 1
    }
  }
  END {
    if (count != 1 || invalid) exit 1
    print checksum
  }
' "$manifest_path") || fail "SHA256SUMS must contain exactly one valid entry for $archive_name."

if [ "$checksum_command" = 'sha256sum' ]; then
  checksum_output=$(sha256sum "$archive_path")
else
  checksum_output=$(shasum -a 256 "$archive_path")
fi
actual_checksum=${checksum_output%% *}
[ "$actual_checksum" = "$expected_checksum" ] || fail "Checksum mismatch for $archive_name."

tar -xzf "$archive_path" -C "$work_dir" "$BINARY_NAME" || fail 'Unable to extract claude-code from the verified archive.'
[ -f "$work_dir/$BINARY_NAME" ] && [ ! -L "$work_dir/$BINARY_NAME" ] ||
  fail 'The archive did not contain a regular claude-code binary.'
```

Keep this parser scoped to the repository’s lowercase, two-space manifest generator. The implemented tests cover wrong/missing/duplicate/malformed entries, not every possible whitespace or digest spelling.

- [ ] **Step 4: Implement same-directory staging, atomic rename, and PATH guidance**

Append after selective extraction; only now create the installation directory and same-directory staging:

```sh
mkdir -p "$INSTALL_DIR" || fail "Unable to create installation directory: $INSTALL_DIR"
destination="$INSTALL_DIR/$BINARY_NAME"
[ ! -d "$destination" ] || fail "Installation destination is a directory: $destination"
staging_file=$(mktemp "$INSTALL_DIR/.claude-code.XXXXXX")
cp "$work_dir/$BINARY_NAME" "$staging_file"
chmod 0755 "$staging_file"
mv -f "$staging_file" "$destination"
staging_file=''

printf 'Installed claude-code %s to %s\n' "$VERSION" "$destination"
case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf 'Add the installation directory to your PATH:\n'
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac
}
main "$@"
```

`cp` writes only the new `mktemp` staging file, never the destination. `mv` receives the exact target path, and clearing `staging_file` prevents cleanup from treating the renamed path as temporary. Do not automatically execute the installed binary or edit shell configuration.

- [ ] **Step 5: Run syntax and the complete local installer suite**

```bash
sh -n scripts/install.sh
bun run test tests/installScript.test.ts
```

Expected: syntax and the defined fake-Release cases PASS: latest/default-HOME/already-on-PATH, four representative platform mappings, exact `0755`, two-README selective extraction, four checksum failure classes with old-target preservation, unsupported targets, `v1.2`, 404, missing member, corrupt tar, symlink member, cleanup failure, missing checksum tools, and destination-symlink replacement. Do not claim both digest implementations, every malformed spelling, signal cleanup, target-dir/mv failures, or arbitrary extra archive members are covered.

- [ ] **Step 6: Commit the installer and behavioral tests**

```bash
git add scripts/install.sh tests/installScript.test.ts
git commit -m "Add verified POSIX standalone installer"
```

---

### Task 3: Add Release Syntax Validation and Direct Installer Upload

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: checked-out `scripts/install.sh`, six existing build candidates, aggregate checksum steps, and `softprops/action-gh-release`.
- Produces: a `sh -n` validate step and an explicit upload list whose source basename publishes `scripts/install.sh` as `install.sh` alongside seven existing assets.

- [ ] **Step 1: Review the publish contract without adding workflow unit tests**

Confirm the existing upload globs yield six archives plus `SHA256SUMS`, and that uploading the source path `scripts/install.sh` adds one public asset named `install.sh`. The resulting explicit list yields eight assets. Do not add a copy to `build/release/`, a separate exact-eight pre-publish staging verification, or installer-workflow assertions to `tests/installScript.test.ts`; the real asset set is checked after publication.

- [ ] **Step 2: Add `sh -n` to the validate job**

In `.github/workflows/release.yml`, after checkout in `validate`, add:

```yaml
      - name: Validate shell installer
        run: sh -n scripts/install.sh
```

Do not execute the installer in Ubuntu validate, download assets, install ShellCheck, or use `bash -n`. `sh -n` checks parsing only; behavioral assurance comes from the local fake-Release tests through reused CI.

- [ ] **Step 3: Upload the source script directly**

Keep archive/checksum verification unchanged and make the final action input:

```yaml
          files: |
            build/release/*.tar.gz
            build/release/*.zip
            build/release/SHA256SUMS
            scripts/install.sh
```

Keep `fail_on_unmatched_files: true` and `overwrite_files: false`. Do not add `build/release/*`, which would publish sidecars. No `cp scripts/install.sh build/release/install.sh` step is required. Manual `workflow_dispatch` still skips publish, so dry-run evidence cannot establish the public eight-asset set.

- [ ] **Step 4: Run focused validation without claiming a Release**

```bash
sh -n scripts/install.sh
bun run test tests/installScript.test.ts
bun run test tests/releasePackaging.test.ts
bun run typecheck
```

Expected: installer behavior and release-document tests PASS and the workflow is suitable for review. These commands do not prove GitHub Actions execution or public assets. After an authorized tagged Release, use the post-release asset and real-latest checks in Task 4.

- [ ] **Step 5: Commit the Release integration**

```bash
git add .github/workflows/release.yml
git commit -m "Publish verified shell installer with releases"
```

---

### Task 4: Update Maintainer Guidance and Complete Acceptance/Rollback Review

**Files:**
- Modify: `docs/RELEASING.md`
- Create: `docs/superpowers/specs/2026-11-14-sh-installer-design.md`
- Create: `docs/superpowers/plans/2026-11-14-sh-installer.md`

**Interfaces:**
- Consumes: implemented local installer behavior and tagged Release asset flow.
- Produces: maintainer instructions with explicit dry-run/publication evidence boundaries and a reversible repository change.

- [ ] **Step 1: Update the Release Guide**

Add the canonical install command and explain its macOS/Linux scope, strict `VERSION`, default/custom `INSTALL_DIR`, mandatory selected-archive checksum, and PATH-only guidance. State that `sh -n` is a syntax gate, not behavioral or macOS validation, and that local fake-Release tests provide offline behavior coverage.

Update the publication description to exactly eight assets: six archives, one six-entry `SHA256SUMS`, and one `install.sh`. Keep sidecars as intermediate artifacts. Add a post-publication verification example, clearly conditional on an authorized real Release:

```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

The output must contain the expected eight unique names. Do not instruct maintainers to move tags or replace a published same-version installer when a defect is found; use a forward fix and a new version.

- [ ] **Step 2: Review documentation independence and security boundaries**

Confirm the spec explains why same-root redirect/latest, exact checksum parsing, TMPDIR work files plus final same-directory rename, function-only loading, test-only base injection, direct source upload, and no-sudo/no-prompt choices were made. Confirm alternatives, data layout, failure propagation, signal statuses, concurrency, trust limitations, and Release asset accounting are explicit without treating untested paths as test coverage.

Confirm README files contain user-level instructions only and that this plan does not redefine their two-language/two-document archive contract. Do not add historical execution output, claims of a published latest installer, signature/notarization claims, or a ShellCheck requirement.

- [ ] **Step 3: Run the complete local acceptance sequence**

```bash
bun install --frozen-lockfile
sh -n scripts/install.sh
bun run test tests/installScript.test.ts
bun run test tests/releasePackaging.test.ts
bun run typecheck
bun run build
bun run build:binary
bun run test
bun dist/main.js --version
bun dist/main.js --help
git diff --check
```

Inspect each test’s actual failure output if any. Verify no test-created server/process/temp directory survives. Do not infer untested signal paths, both digest implementations, exhaustive aliases, or malformed-input combinations from this suite. The native binary build must still produce binary + two READMEs, not an archive containing `install.sh`.

- [ ] **Step 4: Exercise a Release dry-run without claiming publication**

After normal review and merge, use the existing manual workflow path:

```bash
gh workflow run release.yml --ref main
gh run list --workflow=release.yml
```

Observe the actual run and inspect logs on failure. Required dry-run observations are: `sh -n` executes in validate, reused CI completes, six native build jobs produce their candidates, and publish is skipped. Do not create a tag merely to test this feature. Eight public assets can only be verified on an authorized tagged Release, followed by a clean-directory download from the public latest URL.

- [ ] **Step 5: Review migration and failure recovery**

No user configuration or installed-data migration is required. New installs create `$HOME/.local/bin` only when necessary and replace one command path. Existing binaries are not auto-updated by merging this feature. Older Releases do not gain `install.sh`; only new Releases built with this workflow have the eight-asset contract.

Installation failures before rename are safe to retry as a complete command. There is no partial-download cache to migrate. A failure after rename may leave the new complete binary installed even if cleanup or PATH output fails; diagnostics must not promise automatic rollback.

- [ ] **Step 6: Review rollback scope and commands**

Before any new Release, rollback reverts `scripts/install.sh`, its tests, the Release syntax/direct-upload changes, and the new maintainer guidance as one unit. Keep `README.zh-CN.md`, `RELEASE_DOCUMENTS`, and binary + two-document archive checks intact. Re-run:

```bash
bun run test tests/releasePackaging.test.ts
bun run typecheck
bun run build
bun run build:binary
bun run test
```

Expected rollback behavior: future Releases return to seven assets (six archives + `SHA256SUMS`) and no longer advertise the shell installer. This rollback removes the installer feature; it does not make the old manual installation path checksum-free. If installation instructions remain in rolled-back README content while no installer is published, remove only those instructions as part of the same user-facing rollback.

After a public Release, do not repoint its tag, overwrite `install.sh`, or silently reduce its asset set. Fix forward and publish a new strict version. Repository rollback never uninstalls or downgrades binaries already placed in user directories; any uninstall instruction must be a separate, explicit user action.

- [ ] **Step 7: Commit the maintainer and feature documentation**

```bash
git add docs/RELEASING.md docs/superpowers/specs/2026-11-14-sh-installer-design.md docs/superpowers/plans/2026-11-14-sh-installer.md
git commit -m "Document POSIX installer design"
```
