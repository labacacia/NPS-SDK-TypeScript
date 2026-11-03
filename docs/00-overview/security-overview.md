# Security Overview

Treat decoded objects, URLs, certificates, and network data as untrusted. Review parser bounds, object merging, lockfiles, registry targeting, and publishing.

## Review rules

- Validate external input and fail closed.
- Keep secrets out of source, fixtures, logs, and errors.
- Bound network, parser, file, memory, and concurrency work where applicable.
- Pin and review automation dependencies.
- Add focused tests for changed security behavior.
- Follow [SECURITY.md](../../SECURITY.md) for reports.
