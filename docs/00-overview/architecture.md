# Architecture

## Purpose and lifecycle

Public TypeScript release projection; canonical source is in NPS-Dev.

## Boundaries

src/: package.

tests/: tests.

scripts/: build and registry safeguards.

spec/: released snapshot.

doc/: documentation.

Keep responsibilities and dependency direction explicit. Do not add layers or cross-repository sources of truth without a concrete requirement. Record architecture-significant decisions under `docs/04-decisions/`.
