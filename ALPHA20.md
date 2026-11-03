# Experimental alpha.20 implementation slices

These helpers are not wired into existing HTTP/native servers, exported as a stable
profile API, or advertised through Hello/NWM. They do not make this SDK alpha.20-qualified.
The normative baseline is NIP §7.8 / NWP §9.7 / NCP §2.6.3. Tracking: P20-203 / NPS-Dev #130.

## Invocation projection admission

`src/alpha20/context-admission.ts` composes strict carrier/schema decoding, current
configured-key Ed25519 verification, independent channel-issuer binding, exact
audience/subject/request binding, receiver delegation ceilings, registered-operation
validation, authorization, time checks and an atomic replay claim. A failed check
never returns an admitted context. Backend exception details are not exposed.

All `InvocationAdmissionOptions` are receiver-owned configuration, not wire assertions.
In particular, derive `allowedIssuers` from the separately authenticated transport;
do not populate it from the payload's issuer or a public header. `selectedFeatures`
must come from admitted native negotiation or an independently enforced HTTP route.
`validateOperation` is a pure schema/binding check; `authorize` is receiver policy.
Neither callback may execute the business action. Key/policy bindings and time are
rechecked after asynchronous policy work, before replay insertion.

Dispatch only after `admitInvocationProjection` resolves, using its frozen `request`
value. Do not reparse the original request into different numeric semantics. The
API does not dispatch a handler, create outbound projections, strip public headers,
negotiate transports, or supply cancellation/deadline/retry orchestration. Those
integrations remain mandatory. `checkProjectionSignature` alone is not admission.

## Single-host durable replay

`SqliteProjectionReplayStore.open(absolutePath, { audience, capacity })` uses the
optional Node SQLite platform (Node >=22.13 for unflagged `node:sqlite`). It requires a dedicated,
application-owned local file; in-memory/relative paths are rejected. Newly created
files have mode 0600. Existing files are neither replaced nor chmod'd.

All replicas for the audience **must share that same local file**. Audience and
capacity are persisted and mismatched open/claim configuration fails closed. The
default bound is 65,536 live entries. `BEGIN IMMEDIATE`, WAL and synchronous FULL
commit serialize claims; the acceptance clock is read after obtaining the write
lock. Entries are retained through `expires_at + 5`, even with a smaller acceptance
skew. Full capacity does not evict live IDs. Lock wait is bounded at 250ms and storage
errors fail closed. A persisted clock high-water mark rejects backward clock motion.

This is **not** a multi-host store, network-filesystem protocol or database rollback
detector. Independent files cannot protect a load-balanced audience. Multi-host
deployments need a separately qualified shared-store implementation of
`ProjectionReplayStore`; there is no silent in-memory fallback. Replay prevention
does not provide business idempotency or prove whether an action executed.

## Evidence and remaining work

Tests exercise strict parsing, cryptographic binding, policy/time failures before
replay, concurrent admission, real SQLite reopen/capacity/clock/lock failures, two
child processes sharing a file, and recovery after abrupt child termination.
Fixtures use public synthetic keys and disposable temporary databases only.
This is not six-SDK context parity, multi-host failover, complete daemon/adopter
qualification, or the beta clean interval. Production feature advertisement remains disabled.

## Package imports

Use `@labacacia/nps-sdk/alpha20` for experimental parsing, exact-byte checks and
host-configured admission. The optional durable replay implementation is imported
separately from `@labacacia/nps-sdk/alpha20/sqlite`; this keeps ordinary imports
independent of `node:sqlite`. The SQLite subpath requires Node 22.13 or later and
remains subject to the single-host limits above. Exports do not advertise feature
support or install admission on a transport route.
