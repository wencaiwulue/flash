# Commit documentation policy

Every commit must have an independent SPEC, PLAN, and implementation status. Historical records are generated with `bun scripts/document-commits.ts`; CI validates them with `bun scripts/check-commit-docs.ts`.

## Records

- `docs/specs/<sha>-SPEC.md`: behavior, changed files, protocol/security constraints, acceptance evidence, and remaining work.
- `docs/plans/<sha>-PLAN.md`: objective, implementation steps, risks, verification sequence, and completion status.
- `docs/status/index.json`: machine-readable commit records.
- `docs/INDEX.md`: human-readable links and status counts.

Statuses are `implemented`, `partial`, and `unimplemented`. They describe the commit's implementation scope, not whether a later live environment has been verified. OAuth/Cloud/desktop validation remains separate.

## The `self` record

A commit cannot contain its own final SHA in a file without changing that SHA. The current work therefore uses `self-SPEC.md` and `self-PLAN.md` with a stable `changeId`. On the next documentation update, the previous `self` record is finalized to that commit's SHA and a new `self` record is created for the following work.

Do not delete the `self` record or use it to bypass documentation. CI requires all historical SHA records plus the current `self` record.

## Updating after a commit

1. Set `COMMIT_DOC_ID` and `COMMIT_DOC_SUBJECT` when preparing a new change.
2. Run `bun scripts/document-commits.ts` and review generated requirements and evidence.
3. Run `bun scripts/check-commit-docs.ts`, the full test suite, typecheck, and build.
4. Commit the SPEC, PLAN, indexes, and validation changes together.

The generator uses real git metadata and curated commit-specific requirements. Do not replace curated requirements with a generic status-only file.
