// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Validates TaskFrame.callback_url per NPS-5 §8.4:
//   - MUST be an https:// URL.
//   - SHOULD NOT target a private/loopback address (SSRF guard).
// TypeScript port of NPS.NOP.Validation.NopCallbackValidator.

/**
 * Validates `callbackUrl`. Returns `null` when valid; otherwise a human-readable
 * error string.
 */
export function validateCallbackUrl(callbackUrl: string): string | null {
  if (callbackUrl == null || callbackUrl.trim().length === 0)
    return "callback_url must not be empty.";

  let uri: URL;
  try {
    uri = new URL(callbackUrl);
  } catch {
    return `callback_url '${callbackUrl}' is not a valid absolute URI.`;
  }

  // URL.protocol includes the trailing ':'.
  const scheme = uri.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https")
    return `callback_url MUST use the https:// scheme (got '${scheme}://').`;

  if (isPrivateHost(uri.hostname))
    return `callback_url host '${uri.hostname}' resolves to a private or loopback address (SSRF guard).`;

  return null; // valid
}

/**
 * Returns `true` when `host` is a well-known private / loopback / link-local
 * address or hostname, without performing DNS resolution.
 */
export function isPrivateHost(host: string): boolean {
  if (host == null || host.length === 0) return true;

  if (host.toLowerCase() === "localhost") return true;

  // Strip IPv6 URI brackets: [::1] → ::1  (URL.hostname already strips them, but be safe).
  const stripped = host.replace(/^\[/, "").replace(/\]$/, "");

  if (isIpv4(stripped)) return isPrivateIpv4(stripped);
  if (stripped.includes(":")) return isPrivateIpv6(stripped);

  return false;
}

function isIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isPrivateIpv4(host: string): boolean {
  const b = host.split(".").map(Number);
  return (
    b[0] === 127 ||                       // 127.0.0.0/8 loopback
    b[0] === 10 ||                        // 10.0.0.0/8
    b[0] === 0 ||                         // 0.0.0.0/8
    (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || // 172.16.0.0/12
    (b[0] === 192 && b[1] === 168) ||     // 192.168.0.0/16
    (b[0] === 169 && b[1] === 254)        // 169.254.0.0/16 link-local
  );
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();

  // IPv4-mapped IPv6: ::ffff:10.0.0.1
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isIpv4(mapped[1])) return isPrivateIpv4(mapped[1]);

  if (lower === "::1") return true;              // loopback
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  if (lower.startsWith("fec") || lower.startsWith("fed") ||
      lower.startsWith("fee") || lower.startsWith("fef")) return true; // fec0::/10 site-local
  return false;
}
