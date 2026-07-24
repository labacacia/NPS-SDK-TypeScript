// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF guards for outbound URLs, port of the .NET `ActionCallbackValidator` and
 * `ComplexChildUrlValidator` (NPS-2 §7.1, §13.2).
 *
 * DNS resolution is intentionally avoided — only hostname literals and IP-literal
 * addresses in loopback / link-local / RFC1918 ranges are rejected.
 */

/** True for `localhost` and IP literals in loopback / private / link-local ranges. */
export function isPrivateHost(host: string): boolean {
  if (!host) return true;
  if (host.toLowerCase() === "localhost") return true;

  const stripped = host.replace(/^\[/, "").replace(/\]$/, "");

  // IPv4 literal
  const v4 = stripped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const b = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (b.some((n) => n > 255)) return false;
    return (
      b[0] === 127 ||
      b[0] === 10 ||
      b[0] === 0 ||
      (b[0] === 172 && b[1]! >= 16 && b[1]! <= 31) ||
      (b[0] === 192 && b[1] === 168) ||
      (b[0] === 169 && b[1] === 254)
    );
  }

  // IPv6 literal (best-effort, mirroring IsLoopback / link-local / site-local)
  if (stripped.includes(":")) {
    const lower = stripped.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    // IPv4-mapped: ::ffff:127.0.0.1
    const mapped = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateHost(mapped[1]!);
    if (lower.startsWith("fe80")) return true;            // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local (site-local)
    return false;
  }

  // Non-IP hostname (other than localhost) — not resolved, treated as public.
  return false;
}

/**
 * Validate an action `callback_url` (NPS-2 §7.1). Returns `null` when valid,
 * otherwise a human-readable error string. MUST be https:// and (by default) not
 * target a private/loopback address.
 */
export function validateCallbackUrl(callbackUrl: string, rejectPrivate = true): string | null {
  if (!callbackUrl || !callbackUrl.trim()) return "callback_url must not be empty.";

  let uri: URL;
  try {
    uri = new URL(callbackUrl);
  } catch {
    return `callback_url '${callbackUrl}' is not a valid absolute URI.`;
  }

  if (uri.protocol.toLowerCase() !== "https:") {
    return `callback_url MUST use the https:// scheme (got '${uri.protocol.replace(/:$/, "")}://').`;
  }
  if (rejectPrivate && isPrivateHost(uri.hostname)) {
    return `callback_url host '${uri.hostname}' resolves to a private or loopback address (SSRF guard).`;
  }
  return null;
}

/**
 * Validate a Complex Node child URL (NPS-2 §13.2). Returns `null` when acceptable,
 * otherwise a human-readable reason. MUST be https:// (unless `allowHttp`), MUST match
 * an allowed prefix if any are configured, and MUST NOT target a private host when
 * `rejectPrivate`.
 */
export function validateChildUrl(
  childUrl: string,
  allowedPrefixes: readonly string[] = [],
  rejectPrivate = true,
  allowHttp = false,
): string | null {
  if (!childUrl || !childUrl.trim()) return "child node URL must not be empty.";

  let uri: URL;
  try {
    uri = new URL(childUrl);
  } catch {
    return `child node URL '${childUrl}' is not a valid absolute URI.`;
  }

  const scheme = uri.protocol.toLowerCase();
  const isHttps = scheme === "https:";
  const isHttp = scheme === "http:";
  if (!isHttps && !(allowHttp && isHttp)) {
    return `child node URL MUST use the https:// scheme (got '${scheme.replace(/:$/, "")}://').`;
  }

  if (allowedPrefixes.length > 0) {
    const matched = allowedPrefixes.some((p) => childUrl.toLowerCase().startsWith(p.toLowerCase()));
    if (!matched) return `child node URL '${childUrl}' is not in the allowed prefix list.`;
  }

  if (rejectPrivate && isPrivateHost(uri.hostname)) {
    return `child node host '${uri.hostname}' resolves to a private or loopback address (SSRF guard).`;
  }
  return null;
}
