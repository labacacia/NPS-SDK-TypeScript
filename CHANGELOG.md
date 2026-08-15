English | [中文版](./CHANGELOG.cn.md)

# Changelog — TypeScript SDK (`@labacacia/nps-sdk`)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until NPS reaches v1.0 stable, every repository in the suite is synchronized to the same pre-release version tag.

---

## [1.0.0-alpha.18] — 2026-08-15

### Added

- Added official stateful LLM context DTOs, an in-process store, and a Fetch Action Server coordinator with owner scoping, CAS reservations, lifecycle actions, true asynchronous execution, cancellation, and all 19 shared conformance vectors.

### Changed

- Aligned unary request correlation, LLM usage accounting, strict stateful request validation, task ownership, and late-result rejection across SDK families.
- Runtime `VERSION` now derives from package metadata so package and API versions cannot drift.

## [1.0.0-alpha.17] — 2026-08-02

### Added

- Port the reference server surface into the TypeScript SDK: NCP native transport, NWP action/complex/memory nodes and bidirectional bridges, NIP CA services and full verification, NOP orchestration, daemon observability, and telemetry.
- Export the daemon observability surface through the `./daemon` package subpath.
- Implement the shared NCP 0.11, NWP 0.20, NIP 0.13, NDP 0.12, and NOP 0.9
  portable profiles and language-neutral conformance fixtures.

### Security

- Refresh the locked Vitest/Vite/PostCSS/esbuild toolchain to resolve all reported npm audit findings.

## [1.0.0-alpha.16] — 2026-07-23

### Changed

- Suite-wide alpha.16 source synchronization and protocol compatibility update.

## [1.0.0-alpha.15] — 2026-06-28

### Changed

- Suite-wide alpha.15 sync: aligned package metadata, current README/version banners, distribution source trees, and release-prep notes with NPS-Dev.
- Carries the NCP Tier-3 BinaryVector, inbound NWP Bridge server hardening, NIP canonical trust/revoke, and NDP discovery canonical-form alignment delivered by the source-of-truth tree.

## [1.0.0-alpha.14] — 2026-06-26

### Added
- `NipCaClient` under `@labacacia/nps-sdk/nip`: typed remote NIP CA client for discovery, CRL, agent/node registration, X.509 registration, renewal, revocation, and verification.
- `NwpNativeNodeServer` under `@labacacia/nps-sdk/nwp`: native-mode NWP serving helper for dispatching QueryFrame/ActionFrame over an already established NCP stream.
- `@labacacia/nps-sdk/conformance`: TC-N1/TC-N2 conformance catalog, manifest helper, and validator for CI/self-certification flows.

---

## [1.0.0-alpha.11] — 2026-05-28

### Added

- NOP saga compensation: `DagNode.compensate_action/compensate_params_mapping`, `TaskFrame.compensation_policy`, `TaskState.COMPENSATING/COMPENSATED`, `CompensationPolicy` constants (alpha.9 parity)
- NOP `AggregateStrategy.WEIGHTED_FIRST_K` and `MERGE_ALL` (alpha.11)
- NOP `DelegateFrame.target_cluster_anchor`, `AlignStreamFrame.ack_seq/nak_seq` (alpha.11)
- NDP security profiles: `SecurityProfile` constants + registry enforcement (alpha.9 parity)
- NDP ephemeral TTL cap (60 s) in registry (alpha.9 parity)
- NDP `AnnounceFrame` alpha.9 fields: node_roles, cluster_anchor, spawn_spec_ref, bridge_protocols, activation_mode, activation_endpoint
- NDP `GraphFrame` / `NdpGraphEdge` redesigned to NPS-4 §5 topology snapshot format (alpha.11)
- NIP `IdentReputationPolicyHint` and `IdentMetadata.reputation_policy` (alpha.10 parity)
- NIP `IdentFrame.ocsp_staple` (alpha.11)
- NWP `SubscribeFrame` and NWM `trust_anchors` field (alpha.11)

---

## [1.0.0-alpha.2] — 2026-04-19

### Fixed

- **`NpsFrameCodec is not a constructor`** — `src/core/index.ts` now explicitly re-exports the shipped OOP API (`NpsFrameCodec`, `Tier1JsonCodec`, `Tier2MsgPackCodec`, `FrameRegistry`, `AnchorFrameCache`) from `./codec.js`, `./registry.js`, `./cache.js`. The parallel functional API under `./codecs/` remains reachable by direct path but is no longer auto-exported (it collided on `FrameType` / `EncodingTier` / `FrameHeader`).
- **Missing Ed25519 runtime deps** — `@noble/ed25519` and `@noble/hashes` are now declared as runtime dependencies. Previously imported by `src/nip/identity.ts` and `src/ndp/validator.ts` but not listed in `package.json`, causing install failures for npm consumers.

### Added

- **HelloFrame (NCP 0x06)** — new `HelloFrame` class in `src/ncp/frames.ts` with snake_case toDict/fromDict, registered in `ncp/registry.ts`. `FrameType.HELLO = 0x06` added to the enum.
- **Subpath exports** — `package.json` `exports` map now includes `./nwp`, `./nip`, `./ndp`, `./nop` (previously only `.`, `./core`, `./ncp` were declared even though README documented all six).

### Changed

- Node engine requirement raised to `>=22.0.0`.
- 264 tests green (up from 158 previously passing + 5 file failures + 1 test failure).

### Covered modules

- core / ncp / nwp / nip / ndp / nop

---

## [1.0.0-alpha.1] — 2026-04-10

First public alpha as part of the NPS suite `v1.0.0-alpha.1` release.

[1.0.0-alpha.2]: https://github.com/LabAcacia/nps/releases/tag/v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/LabAcacia/nps/releases/tag/v1.0.0-alpha.1
