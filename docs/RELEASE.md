# Release Record

## Initial restoration release

- **Source baseline**: `4b9d30f` (`asdf`).
- **Target repository**: `wencaiwulue/flash` on GitHub.
- **Visibility**: Public, selected by the repository owner.
- **Release status**: Initial commit pushed and first GitHub Actions run passed.
- **Commit**: `9b2a35201244ca84adeaa6844bf799e5a18aff6d`.
- **CI**: `ci` run `42750917055` passed on 2026-11-10.
- **Remotes**:
  - `legacy`: `https://github.com/wencaiwulue/claude-code`
  - `origin`: `git@github.com:wencaiwulue/flash.git`

The initial commit preserves the current work rather than creating an orphan branch or rewriting the baseline. `node_modules/`, `dist/`, local configuration, logs, and credentials are excluded by `.gitignore` and by the pre-push review.

### Included work

- Restored a reproducible Bun/TypeScript build and declaration pipeline.
- Recovered original TypeScript sources from embedded source maps where available.
- Restored core message, SDK, UI, OAuth, storage, and transport types.
- Added the external build and disabled-boundary behavior for internal-only modules.
- Implemented the CLI headless path, SDK query, in-process MCP, V2 sessions, portable session mutations/forking, and scheduled tasks.
- Added offline regression tests and CI.

### Verification at release preparation

- Frozen dependency installation passed.
- TypeScript checking completed with zero errors.
- 7 tests and 38 assertions passed.
- CLI, SDK, and declaration builds passed.
- Real CLI/SDK query, in-process MCP, V2 multi-turn/resume, abort, and packaged SDK query checks passed.

See `docs/STATUS.md` for the commands and the distinction between verified, implemented-but-unverified, missing, disabled, and protocol-blocked capabilities.

### Known limitations

`connectRemoteControl`, Linux libsecret, npm marketplace sources, Cloud xattr persistence, SDK rewind, non-REPL stop hooks, and several SDK control methods remain incomplete. Cloud and daemon/bridge work requires authoritative protocol confirmation. Internal experimental features remain disabled in the external build.

The initial release does not amend its commit to add release metadata. The actual commit SHA and GitHub Actions result will be recorded in a subsequent documentation update.
