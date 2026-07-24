// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { BridgeErrorCodes, BridgeDispatchException } from "./errors.js";
import { BridgeTargetParser, type BridgeTarget } from "./target.js";
import type { FetchFn } from "./dispatcher.js";

/** Apply string-valued `headers` extras from a target onto a Headers bag. */
export function applyStringHeaders(headers: Headers, target: BridgeTarget): void {
  const found = BridgeTargetParser.tryGetJson(target, "headers");
  if (found === undefined) return;
  const value = found.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;

  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string" || raw === "") continue;
    headers.set(name, raw);
  }
}

/** Collect response headers into a comma-joined string map. */
export function collectResponseHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function isJsonContentType(contentType: string | null): boolean {
  return contentType != null && contentType.toLowerCase().includes("json");
}

export function estimateTokenCost(bodyText: string): number {
  if (!bodyText) return 0;
  return Math.max(1, Math.floor(bodyText.length / 4));
}

export function estimateTokenCostBytes(byteLength: number): number {
  return byteLength === 0 ? 0 : Math.max(1, Math.floor(byteLength / 4));
}

/**
 * Send a request via `fetchFn`, applying an optional per-frame timeout and
 * mapping transport failures / timeouts to `BridgeDispatchException`
 * (NWP-BRIDGE-UPSTREAM-FAILED).
 */
export async function sendWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  label: string,
): Promise<Response> {
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs !== undefined && timeoutMs > 0) {
    controller = new AbortController();
    init = { ...init, signal: controller.signal };
    timer = setTimeout(() => controller!.abort(), timeoutMs);
  }

  try {
    return await fetchFn(url, init);
  } catch (err) {
    if (isAbortError(err)) {
      throw new BridgeDispatchException(BridgeErrorCodes.UpstreamFailed, `${label} timed out.`);
    }
    throw new BridgeDispatchException(BridgeErrorCodes.UpstreamFailed, `${label} failed.`, { cause: err });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}
