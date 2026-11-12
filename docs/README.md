# Documentation Index

This index separates current project documentation from historical records, forward-looking designs, and internal working material. For the project overview and quick start, see the [repository README](../README.md).

## Start Here

- [Architecture](ARCHITECTURE.md) — CLI and SDK entrypoints, build artifacts, query and state flow, SDK composition, security, and external-build feature boundaries.
- [Implementation Status](STATUS.md) — current capability status, verification evidence, known limitations, and remaining implementation work.
- [Release Record](RELEASE.md) — historical release notes. Use the implementation status document for current capabilities rather than relying on release history alone.

## Feature Design and Maintenance

- [Feature Documentation Policy](COMMIT_DOCS.md) — the maintainer policy for feature-level design specs and implementation plans.
- [Design Specs](superpowers/specs/) and [Implementation Plans](superpowers/plans/) — reviewed design rationale, implementation sequencing, and acceptance criteria for individual features. These documents do not replace the current architecture or capability status.

## Forward-Looking Designs and Verification

- [External Stub Designs](external-stubs/README.md) — forward-looking designs and public protocol contracts for external capabilities.
- [External Stub Verification](external-stubs/verification.md) — verification evidence and environment boundaries for those implementations.
- [External Stub Audit](status/external-stubs-audit.md) — the audit inventory and implementation status.

A design or protocol contract does not by itself mean that a capability is implemented, enabled in the external build, or verified in a live environment. Consult [Implementation Status](STATUS.md) and the linked verification material for those distinctions.
