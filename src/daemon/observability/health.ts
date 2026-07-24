// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Transport-neutral health / readiness probes. Port of the .NET
// `NPS.Daemon.Observability.HealthChecks` (`HealthProbeRenderer`,
// `IReadinessProbe`, `HealthEndpoints`). Renders liveness / readiness without
// depending on any HTTP framework; a Web-`fetch` handler is provided for hosts
// that speak the Request/Response API.
//
// JSON body shape, status codes, and content type match the .NET reference:
//   /healthz → 200 {"status":"ok"}
//   /readyz  → 200 {"status":"ok"} | 503 {"status":"error","reason":"..."}

export const HEALTH_JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** Transport-neutral health/readiness response. */
export interface HealthProbeResponse {
  statusCode: number;
  contentType: string;
  body: string;
  status: string;
  reason?: string;
}

/**
 * One readiness probe — daemons register one per backing dependency
 * (storage, key material, etc.). `renderReadyz` returns 503 if any fail.
 * Probes MUST be fast; callers may wire an AbortSignal from the request.
 */
export interface IReadinessProbe {
  /** Short name used in the JSON response (e.g. "storage"). */
  readonly name: string;
  /** Returns null/undefined on success, a short reason on failure. */
  check(signal?: AbortSignal): Promise<string | null | undefined>;
}

/** Inline readiness probe wrapper for callers that prefer a lambda. */
export class DelegateReadinessProbe implements IReadinessProbe {
  constructor(
    readonly name: string,
    private readonly fn: (signal?: AbortSignal) => Promise<string | null | undefined>,
  ) {}
  check(signal?: AbortSignal): Promise<string | null | undefined> {
    return this.fn(signal);
  }
}

/** Renders the liveness response used by `/healthz`. */
export function renderHealthz(): HealthProbeResponse {
  return ok();
}

/**
 * Runs the supplied probes and renders the readiness response used by
 * `/readyz`. With no probes, readiness is `ok`. Returns the first failure.
 */
export async function renderReadyz(
  probes: Iterable<IReadinessProbe>,
  signal?: AbortSignal,
): Promise<HealthProbeResponse> {
  for (const probe of probes) {
    let reason: string | null | undefined;
    try {
      reason = await probe.check(signal);
    } catch (err) {
      reason = `${probe.name}: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (reason !== null && reason !== undefined) return error(reason);
  }
  return ok();
}

/**
 * Web-`fetch` handler mapping `/healthz` and `/readyz`. Non-matching paths
 * return a 404. `readinessProbes` and an optional shutdown liveness gate are
 * evaluated per request.
 */
export function createHealthHandler(opts: {
  readinessProbes?: () => Iterable<IReadinessProbe>;
  /** When set and returns true, `/healthz` fails with 503 (draining). */
  isStopping?: () => boolean;
} = {}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;

    if (path === "/healthz" && request.method === "GET") {
      if (opts.isStopping?.()) {
        const r = error("stopping");
        return toResponse(r);
      }
      return toResponse(renderHealthz());
    }

    if (path === "/readyz" && request.method === "GET") {
      const probes = opts.readinessProbes?.() ?? [];
      const r = await renderReadyz(probes, request.signal);
      return toResponse(r);
    }

    return new Response("", { status: 404 });
  };
}

/** Converts a {@link HealthProbeResponse} to a Web `Response`. */
export function toResponse(r: HealthProbeResponse): Response {
  return new Response(r.body, {
    status: r.statusCode,
    headers: { "Content-Type": r.contentType },
  });
}

// ── Private ────────────────────────────────────────────────────────────────

function ok(): HealthProbeResponse {
  return {
    statusCode: 200,
    contentType: HEALTH_JSON_CONTENT_TYPE,
    body: JSON.stringify({ status: "ok" }),
    status: "ok",
  };
}

function error(reason: string): HealthProbeResponse {
  return {
    statusCode: 503,
    contentType: HEALTH_JSON_CONTENT_TYPE,
    body: JSON.stringify({ status: "error", reason }),
    status: "error",
    reason,
  };
}
