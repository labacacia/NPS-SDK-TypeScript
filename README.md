English | [中文版](./README.cn.md)

# @labacacia/nps-sdk — TypeScript / Node.js
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)
[![Release](https://img.shields.io/badge/release-v1.0.0--alpha.17-orange.svg)](../../CHANGELOG.md)
[![NCP](https://img.shields.io/badge/NCP-v0.9-5b8cff.svg)]()
[![NWP](https://img.shields.io/badge/NWP-v0.14-4af0b0.svg)]()
[![NIP](https://img.shields.io/badge/NIP-v0.10-7b61ff.svg)]()
[![NDP](https://img.shields.io/badge/NDP-v0.9-f0a050.svg)]()
[![NOP](https://img.shields.io/badge/NOP-v0.7-ff8c42.svg)]()

TypeScript SDK for the **Neural Protocol Suite** (NPS) — a protocol suite designed for AI Agents.  
Part of the [LabAcacia](https://github.com/LabAcacia) / INNO LOTUS PTY LTD open-source ecosystem.

## Status

**v1.0.0-alpha.17 candidate — server and orchestration surface parity** · 5 protocols · 979 tests

Alpha.15 additions: typed remote NIP CA client (`NipCaClient`), native-mode NWP serving helper (`NwpNativeNodeServer`), and TC-N1/TC-N2 conformance manifest helpers (`@labacacia/nps-sdk/conformance`).

| Protocol | Class | Status |
|----------|-------|--------|
| NCP — Neural Communication Protocol | Framing, codec | ✅ |
| NWP — Neural Web Protocol | `NwpClient`, `NwpNativeNodeServer` | ✅ |
| NIP — Neural Identity Protocol | `NipIdentity`, `NipIdentVerifier` (RFC-0002 §8.1 dual-trust), `AssuranceLevel` (RFC-0003), `nip.x509` + `nip.acme` | ✅ |
| NDP — Neural Discovery Protocol | `InMemoryNdpRegistry`, `NdpAnnounceValidator` | ✅ |
| NOP — Neural Orchestration Protocol | `NopClient` | ✅ |

**Earlier additions** — Full NPS-RFC-0002 X.509 + ACME `agent-01` NID certificate primitives:

- `nip.x509` — `issueLeaf` / `issueRoot` / `verify` (built on `@peculiar/x509` + native Web Crypto Ed25519).
- `nip.acme` — `AcmeClient` + in-process `AcmeServer` + JWS / message helpers (RFC 8555 + EdDSA per RFC 8037).
- `IdentFrame` extended with non-breaking `assuranceLevel` / `certFormat` / `certChain` constructor options; v1 verifiers ignore the new fields.

## Alpha.17 candidate

The candidate carries the server-surface parity wave planned for the next suite release:

- **NOP orchestration engine** — DAG validator, condition evaluator, input mapper,
  result aggregator, task store, worker client, callback validator, instrumentation
- **NCP native-mode transport** — server, session, client, frame IO, handshake caps,
  encoding policy, patch format
- **NIP CA service** — CA router + RA admission model, SQL-backed CA store,
  TrustFrame validator, full six-step §7 `VerifyFull` verifier
- **NWP server surface** extensions (memory/complex node serving)
- **Daemon observability** (health / metrics / logging / shutdown) and **telemetry**

## Installation

```bash
npm install @labacacia/nps-sdk@alpha
```

Alpha releases are published on the `alpha` dist-tag. The npm `latest` tag is reserved for the default/stable install channel.

> **Peer requirement:** Node.js 22+

## Quick Start

### NWP — query a node

```typescript
import { NwpClient, QueryFrame } from "@labacacia/nps-sdk/nwp";

const client = new NwpClient("http://node.example.com:17433");
const caps   = await client.query(new QueryFrame("sha256:<anchor-id>", { active: true }, 20));
console.log(caps.count, caps.data);
```

### NWP — stream results

```typescript
for await (const chunk of client.stream(new QueryFrame("sha256:<anchor-id>"))) {
  console.log(chunk.seq, chunk.data);
}
```

### NWP — invoke an action

```typescript
import { ActionFrame } from "@labacacia/nps-sdk/nwp";

const result = await client.invoke(new ActionFrame("summarise", { maxTokens: 500 }));
```

### NWP — native serving

```typescript
import { NwpNativeNodeServer } from "@labacacia/nps-sdk/nwp";

const server = new NwpNativeNodeServer({
  queryHandler: () => [{ id: 42 }],
  actionHandler: (action) => ({ action: action.actionId }),
});

// `source`/`sink` are already past NCP preamble, TLS, and Hello negotiation.
await server.serve(source, sink);
```

### NIP — Ed25519 identity

```typescript
import { NipIdentity } from "@labacacia/nps-sdk/nip";

// Generate and persist
const id = NipIdentity.generate();
id.save("./my-key.json", process.env.KEY_PASS!);

// Load and sign
const loaded = NipIdentity.load("./my-key.json", process.env.KEY_PASS!);
const sig    = loaded.sign({ action: "announce", nid: "urn:nps:node:example.com:data" });
const ok     = loaded.verify({ action: "announce", nid: "urn:nps:node:example.com:data" }, sig);
```

### NIP — remote CA client

```typescript
import { NipCaClient } from "@labacacia/nps-sdk/nip";

const ca = new NipCaClient("https://ca.example.com", { routePrefix: "/nip" });
const discovery = await ca.getDiscovery();
const ident = await ca.registerAgent(
  { identifier: "agent-a", pub_key: "ed25519:<pub>", capabilities: ["nwp:query"] },
  "token",
);
const status = await ca.verifyAgent(ident.nid);
```

### Conformance manifest

```typescript
import {
  NODE_L1,
  catalogForProfile,
  createConformanceManifest,
  validateConformanceManifest,
} from "@labacacia/nps-sdk/conformance";

const results = catalogForProfile(NODE_L1).map((c) => ({ id: c.id, result: "pass" as const }));
const manifest = createConformanceManifest({
  profile: NODE_L1,
  iutName: "my-node",
  iutVersion: "1.0.0-alpha.16",
  iutNid: "urn:nps:node:example.com:my-node",
  peerName: "labacacia-fixture",
  peerVersion: "1.0.0-alpha.16",
  results,
});
const validation = validateConformanceManifest(manifest);
```

### NDP — registry and signature validation

```typescript
import { InMemoryNdpRegistry, NdpAnnounceValidator } from "@labacacia/nps-sdk/ndp";
import { AnnounceFrame } from "@labacacia/nps-sdk/ndp";

const registry  = new InMemoryNdpRegistry();
const validator = new NdpAnnounceValidator();
validator.registerPublicKey(nid, identity.pubKeyString);

registry.announce(frame);
const resolved = registry.resolve("nwp://example.com/data/items");
```

### NOP — submit and wait for a task

```typescript
import { NopClient, TaskFrame } from "@labacacia/nps-sdk/nop";

const client = new NopClient("http://orchestrator.example.com:17433");
const dag    = {
  nodes: [{ id: "classify", action: "classify-text", agent: "urn:nps:node:ml.example.com:classifier" }],
  edges: [],
};

const taskId = await client.submit(new TaskFrame("my-task-1", dag));
const status = await client.wait(taskId, { timeoutMs: 30_000 });
console.log(status.state, status.aggregatedResult);
```

## Package Exports

```typescript
import { ... } from "@labacacia/nps-sdk";           // everything
import { ... } from "@labacacia/nps-sdk/core";       // codec, frames, registry, cache
import { ... } from "@labacacia/nps-sdk/ncp";        // AnchorFrame, CapsFrame, StreamFrame, HelloFrame, …
import { ... } from "@labacacia/nps-sdk/nwp";        // NwpClient, QueryFrame, ActionFrame
import { ... } from "@labacacia/nps-sdk/nip";        // NipIdentity, IdentFrame, TrustFrame, RevokeFrame
import { ... } from "@labacacia/nps-sdk/ndp";        // InMemoryNdpRegistry, NdpAnnounceValidator, AnnounceFrame, …
import { ... } from "@labacacia/nps-sdk/nop";        // NopClient, NopTaskStatus, TaskFrame, …
import { ... } from "@labacacia/nps-sdk/conformance"; // TC-N1/TC-N2 catalogs and manifest validator
```

## NCP Codec

The codec layer supports Tier-1/2/3 encoding and direct wire-format manipulation. Overrides are intended for negotiated session policy, diagnostics, and tests; application code should not switch tiers arbitrarily inside one workflow.

```typescript
import { NpsFrameCodec, EncodingTier } from "@labacacia/nps-sdk/core";
import { createDefaultRegistry } from "@labacacia/nps-sdk";

const codec = new NpsFrameCodec(createDefaultRegistry());

// Encode (defaults to MsgPack)
const wire = codec.encode(frame);

// Encode as JSON (debugging / interop policy)
const json = codec.encode(frame, { overrideTier: EncodingTier.JSON });

// Decode
const decoded = codec.decode(wire);

// Peek at the header without decoding the payload
const header = NpsFrameCodec.peekHeader(wire);
console.log(header.frameType, header.isExtended, header.payloadLength);
```

## Development

```bash
# Install (no symlinks required on restricted filesystems)
npm install --no-bin-links

# Test
node node_modules/vitest/vitest.mjs run

# Test + coverage
node node_modules/vitest/vitest.mjs run --coverage

# Build (ESM + CJS)
node node_modules/tsup/dist/cli-default.js
```

## License

Apache 2.0 — see [LICENSE](https://github.com/labacacia/NPS-Dev/blob/main/LICENSE)
