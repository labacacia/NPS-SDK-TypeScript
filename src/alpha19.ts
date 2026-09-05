// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** Portable, side-effect-free alpha.19 policy decisions shared by SDK runtimes. */
export type Alpha19Input = Record<string, any>;
export type Alpha19Output = Record<string, any>;

export function evaluateNcpRuntime(input: Alpha19Input): Alpha19Output {
  if ("client_ping_ms" in input) {
    const offers = [input.client_ping_ms, input.server_ping_ms].filter((v) => v > 0);
    return { keepalive_enabled: offers.length > 0, effective_interval_ms: offers.length ? Math.max(1000, Math.min(...offers)) : null };
  }
  if ("events" in input) {
    let clock = input.last_valid_inbound_ms;
    for (const event of input.events) if (event.event === "valid_inbound_frame") clock = event.at_ms;
    return { last_valid_inbound_ms: clock };
  }
  if ("queued_probe_count" in input) {
    const due = input.evaluate_at_ms - input.last_application_send_ms >= input.effective_interval_ms;
    return due && input.queued_probe_count === 0
      ? { enqueue: { frame: "0x07", payload_length: 0 }, queued_probe_count: 1 }
      : { queued_probe_count: input.queued_probe_count };
  }
  if ("active_streams" in input) {
    const timedOut = input.evaluate_at_ms >= input.last_valid_inbound_ms + 3 * input.effective_interval_ms;
    return timedOut ? { state: "closing", error: "NCP-KEEPALIVE-TIMEOUT", error_count: 1, cancelled_streams: input.active_streams, close_by_ms: input.evaluate_at_ms + 500, allow_later_application_frames: false } : { state: "open" };
  }
  if ("payload_length" in input) return input.payload_length === 0
    ? { accepted: true, last_valid_inbound_ms: input.received_at_ms }
    : { accepted: false, error: "NCP-FRAME-PAYLOAD-TOO-LARGE", last_valid_inbound_ms: input.last_valid_inbound_ms };
  if ("early_data" in input) return input.carrier === "quic" && !input.handshake_confirmed
    ? { accepted: false, error: "NCP-EARLY-DATA-REJECTED", retry_after_confirmation: true }
    : { accepted: true };
  if ("bound_nid" in input) {
    if (!input.handshake_confirmed || input.bound_nid !== input.migrated_nid) return { migration_allowed: false, session_preserved: false, error: "NCP-NID-MISMATCH" };
    const send = input.carrier_credit_bytes > 0 && input.ncp_window_cgn > 0;
    return send ? { migration_allowed: true, session_preserved: true, send_allowed: true }
      : { migration_allowed: true, session_preserved: true, send_allowed: false, reason: input.ncp_window_cgn <= 0 ? "ncp_window_exhausted" : "carrier_credit_exhausted" };
  }
  throw new RangeError("unknown NCP 0.12 hardening input");
}

function normalizeSla(sla: Alpha19Input, prefix = ""): [Alpha19Output, string[]] {
  const out: Alpha19Output = {}, diagnostics: string[] = [];
  if ("p95_latency_ms" in sla) Number.isInteger(sla.p95_latency_ms) && sla.p95_latency_ms > 0 && sla.p95_latency_ms <= 0xffffffff ? out.p95_latency_ms = sla.p95_latency_ms : diagnostics.push(prefix + "p95_latency_ms");
  if ("availability" in sla) { const value = Number(sla.availability); value > 0 && value <= 1 ? out.availability = String(sla.availability) : diagnostics.push(prefix + "availability"); }
  if ("sla_tier" in sla) { const ranks: Alpha19Input = { basic: 0, standard: 1, premium: 2 }; if (sla.sla_tier in ranks) { out.sla_tier = sla.sla_tier; out.sla_tier_rank = ranks[sla.sla_tier]; } else { out.sla_tier_raw = String(sla.sla_tier); out.sla_tier_rank = null; } }
  return [out, diagnostics];
}

export function normalizeNwpMetadata(input: Alpha19Input): Alpha19Output {
  if ("stability" in input) return input.stability == null ? { normalized: "stable", diagnostics: [] }
    : ["experimental", "stable", "deprecated"].includes(input.stability) ? { raw: input.stability, normalized: input.stability, rank_as_stable: input.stability === "stable" }
      : { raw: input.stability, normalized: "experimental", rank_as_stable: false };
  if ("sla" in input) { const [sla, diagnostics] = normalizeSla(input.sla); return { manifest_valid: true, normalized_sla: sla, diagnostics }; }
  if ("billing" in input) {
    const billing = input.billing, profile = ["free", "metered"].includes(billing.metering_profile) ? billing.metering_profile : "metered";
    const out: Alpha19Output = { metering_profile: profile }, diagnostics: string[] = [];
    if (profile === "free") for (const key of ["billing_unit", "price_hint", "currency"]) { if (key in billing) diagnostics.push(key); }
    else {
      if (typeof billing.billing_unit === "string" && billing.billing_unit) out.billing_unit = billing.billing_unit; else diagnostics.push("billing_unit");
      if (typeof billing.price_hint === "string" && /^[A-Z]{3} [0-9]+(?:\.[0-9]+)?$/.test(billing.price_hint)) {
        if (billing.currency != null && billing.currency !== billing.price_hint.slice(0, 3)) diagnostics.push("currency");
        else { out.price_hint = billing.price_hint; if (billing.currency != null) out.currency = billing.currency; }
      } else if (billing.price_hint != null) diagnostics.push("price_hint");
    }
    return { normalized_billing: out, diagnostics };
  }
  if ("top_level" in input) { const [base] = normalizeSla(input.top_level?.sla ?? {}); const [override, diagnostics] = normalizeSla(input.action?.sla ?? {}, "action.sla."); return { effective_sla: { ...base, ...override }, diagnostics }; }
  throw new RangeError("unknown NWP metadata input");
}

const iso = (value: string): Date => new Date(value);
const format = (value: Date): string => value.toISOString().replace(".000Z", "Z");
export function evaluateNwpSubscription(input: Alpha19Input): Alpha19Output {
  if ("policy" in input) {
    const p = input.policy, r = input.request;
    if (p.default_lease_seconds <= 0 || p.max_lease_seconds <= 0 || p.default_lease_seconds > p.max_lease_seconds || p.renew_before_seconds >= p.max_lease_seconds) return { accepted: false, error: "NWP-SUBSCRIBE-LEASE-INVALID", state_mutated: false };
    const requested = r.lease_seconds ?? p.default_lease_seconds;
    if (requested <= 0) return { accepted: false, error: "NWP-SUBSCRIBE-LEASE-INVALID", state_mutated: false };
    const lease = Math.min(requested, p.max_lease_seconds), expires = new Date(iso(input.accepted_at).getTime() + lease * 1000);
    return r.lease_seconds == null ? { lease_seconds: lease, expires_at: format(expires), status: "open" } : { lease_seconds: lease, expires_at: format(expires) };
  }
  if ("owner_nid" in input) return input.owner_nid === input.caller_nid ? { accepted: true } : { accepted: false, error: "NWP-AUTH-NID-SCOPE-VIOLATION", state_disclosed: false };
  if ("prior_seq" in input) return { expires_at: format(new Date(iso(input.accepted_at).getTime() + input.lease_seconds * 1000)), seq: input.prior_seq, cursor: input.prior_cursor };
  if ("expires_at" in input) return iso(input.now) >= iso(input.expires_at) ? { accepted: false, status: "closed", error: "NWP-SUBSCRIBE-LEASE-EXPIRED", terminal_event_count: 1 } : { accepted: true };
  if (["renew", "close"].includes(input.operation) && ["anchor_ref", "filter", "type"].some((key) => key in input)) return { accepted: false, error: "NWP-SUBSCRIBE-LEASE-INVALID", state_mutated: false };
  throw new RangeError("unknown NWP subscription input");
}

export function evaluateNipRenewal(input: Alpha19Input): Alpha19Output {
  if (input.profile === "standard") { const open = iso(input.not_after).getTime() - iso(input.now).getTime() <= 7 * 86400000; return { renewal_open: open, error: open ? null : "NIP-CA-RENEWAL-TOO-EARLY" }; }
  if (input.profile === "short-lived-edge") { const window = Math.floor(input.original_validity_seconds / 4); return { renewal_open: input.remaining_seconds <= window, window_seconds: window }; }
  if ("current" in input) { const allowed = input.requested.capabilities.every((x: string) => input.current.capabilities.includes(x)) && input.requested.scope.every((x: string) => input.current.scope.includes(x)); return allowed ? { issued: true } : { issued: false, error: "NIP-CA-SCOPE-EXPANSION-DENIED" }; }
  if ("recorded" in input) return input.recorded.committed && input.recorded.canonical_digest === input.canonical_digest ? { serial: input.recorded.serial, new_issue_count: 0 } : { error: "NIP-CA-SERIAL-DUPLICATE", new_issue_count: 0 };
  if ("old_ticket_not_after" in input) return { old_ticket_not_after: input.old_ticket_not_after };
  throw new RangeError("unknown NIP renewal input");
}

export function evaluateNipRevocation(input: Alpha19Input): Alpha19Output {
  if ("cached" in input) { const replace = input.incoming.signature_valid && iso(input.incoming.this_update) > iso(input.cached.this_update); return { cache_replaced: replace, effective_outcome: (replace ? input.incoming : input.cached).outcome }; }
  const consulted: string[] = [], diagnostics: string[] = [], now = input.now ? iso(input.now) : undefined;
  for (const source of input.sources ?? []) {
    consulted.push(source.source);
    if (source.outcome === "unknown") return { valid: false, error: "NIP-OCSP-UNKNOWN" };
    if (now && source.next_update && now >= iso(source.next_update)) { diagnostics.push(`${source.source}_stale`); continue; }
    if (source.outcome === "revoked") return { valid: false, error: "NIP-CERT-REVOKED" };
    if (source.outcome === "good") return diagnostics.length ? { valid: true, consulted_sources: consulted, diagnostics } : { valid: true, consulted_sources: consulted };
  }
  return input.revocation_mode === "required" ? { valid: false, error: "NIP-REVOCATION-STATE-STALE" } : { valid: true, consulted_sources: consulted };
}

export function evaluateNipAdvisory(input: Alpha19Input): Alpha19Output {
  const ident = input.ident, ext = input.certificate_extensions, findings: Alpha19Output[] = [];
  if (ident.assurance_level !== ext.assurance_level) findings.push({ field: "assurance_level", error: "NIP-ASSURANCE-MISMATCH" });
  if (!ident.capabilities.every((x: string) => (ext.capabilities ?? []).includes(x))) findings.push({ field: "capabilities", error: "NIP-CERT-CAPABILITIES-EXCEEDED" });
  if (!ident.node_roles.every((x: string) => (ext.node_roles ?? []).includes(x))) findings.push({ field: "node_roles", error: "NIP-CERT-NODE-ROLES-MISMATCH" });
  if (ident.ocsp_staple == null) findings.push({ field: "ocsp_staple", error: "NIP-OCSP-STAPLE-EXPIRED" });
  findings.sort((a, b) => a.field.localeCompare(b.field));
  return { accepted_current_request: !input.phase3_enforcement, findings, state_mutated: false };
}

export function evaluateNdpRecovery(input: Alpha19Input): Alpha19Output {
  if ("commit" in input) return input.commit === "success" ? { acknowledged: true, served_seq: input.incoming_seq, persisted_seq: input.incoming_seq } : { acknowledged: false, served_seq: input.persisted_seq, persisted_seq: input.persisted_seq, error: "NDP-STATE-UNAVAILABLE" };
  if ("record" in input && "now" in input) return { live_entry: iso(input.record.fresh_until) > iso(input.now), highest_seq: input.record.highest_seq, ready: true };
  if ("restored_highest_seq" in input) return input.incoming_seq < input.restored_highest_seq ? { accepted: false, highest_seq: input.restored_highest_seq, error: "NDP-GRAPH-SEQ-ROLLBACK" } : { accepted: true, highest_seq: input.incoming_seq };
  if ("owners" in input) { const live = input.owners.filter((x: Alpha19Input) => x.live), top = Math.max(...live.map((x: Alpha19Input) => x.epoch)), leaders = live.filter((x: Alpha19Input) => x.epoch === top).map((x: Alpha19Input) => x.nid).sort(); return leaders.length === 1 ? { resolved_nid: leaders[0] } : { resolved_nid: null, error: "NDP-CLUSTER-SPLIT" }; }
  if ("snapshot_validation" in input) return input.snapshot_validation === "valid" ? { ready: true, started_empty: false } : { ready: false, started_empty: false, error: "NDP-STATE-CORRUPT" };
  if ("profiles" in input) return { recovery: input.profiles.map((x: string) => x === "local-dev" ? "volatile" : "durable") };
  if ("revoked_origin" in input) return { live: !!input.record.live && input.record.origin !== input.revoked_origin, highest_seq: input.record.highest_seq };
  throw new RangeError("unknown NDP recovery input");
}

export function evaluateNopReplay(input: Alpha19Input): Alpha19Output {
  if ("recorded" in input && input.recorded.digest === input.digest) return { state: input.recorded.state, dispatch_count: input.recorded.dispatch_count, replayed: true };
  if ("recorded_digest" in input) return input.digest !== input.recorded_digest ? { accepted: false, error: "NOP-REPLAY-CONFLICT", record_mutated: false } : { accepted: true };
  if ("incoming" in input) { const found = input.records.some((x: Alpha19Input) => x.caller_nid === input.incoming.caller_nid && x.task_id === input.incoming.task_id); return { new_key: !found, accepted: !found }; }
  if ("terminal_commit_ms" in input) return input.query_at_ms >= input.terminal_commit_ms + input.result_ttl_seconds * 1000 ? { result: null, error: "NOP-TASK-RESULT-EXPIRED" } : { result: "retained" };
  if ("result_expired_at_ms" in input) { const retained = input.duplicate_at_ms < input.result_expired_at_ms + input.replay_tombstone_seconds * 1000; return retained ? { dispatch: false, error: "NOP-TASK-RESULT-EXPIRED", tombstone_retained: true } : { dispatch: true, tombstone_retained: false }; }
  if ("capacity" in input) { const safe = input.records.filter((x: Alpha19Input) => x.state !== "running"); return input.records.length >= input.capacity && safe.length === 0 ? { accepted: false, evicted: [], error: "NOP-REPLAY-LIMIT" } : { accepted: true, evicted: safe.length ? [safe[0].key] : [] }; }
  if ("committed" in input) return { state: input.committed.state, late_event: "audit_only", ttl_extended: false };
  if ("min_required" in input) { if (input.results.some((x: Alpha19Input) => typeof x.score !== "number" || !Number.isFinite(x.score))) return { error: "NOP-AGGREGATION-INVALID" }; const selected = [...input.results].sort((a, b) => b.score - a.score || a.node_id.localeCompare(b.node_id)).slice(0, input.min_required); return { selected_node_ids: selected.map((x) => x.node_id) }; }
  if ("topology_order" in input) { const byId = new Map(input.results.map((x: Alpha19Input) => [x.node_id, x])), aggregate: Alpha19Output = {}; for (const id of input.topology_order) { const item = byId.get(id) as Alpha19Input | undefined; if (!item || item.state !== "completed") continue; for (const [key, value] of Object.entries(item.value ?? {})) aggregate[key] = Array.isArray(aggregate[key]) && Array.isArray(value) ? [...aggregate[key], ...structuredClone(value)] : structuredClone(value); } return { aggregated: aggregate, inputs_mutated: false }; }
  throw new RangeError("unknown NOP replay input");
}
