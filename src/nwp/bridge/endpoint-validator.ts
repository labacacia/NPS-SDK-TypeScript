// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { isPrivateHost } from "../callback-validator.js";
import { BridgeErrorCodes, BridgeDispatchException } from "./errors.js";
import { BridgeTargetParser, type BridgeTarget } from "./target.js";

/** Validates outbound Bridge endpoints before dereferencing them. */
export const BridgeEndpointValidator = {
  /**
   * Parse and validate an HTTP(S) Bridge endpoint. By default, both `http://`
   * and `https://` are accepted, while private and loopback hosts are rejected
   * as an SSRF guard.
   */
  parseHttpEndpoint(target: BridgeTarget): URL {
    let uri: URL;
    try {
      uri = new URL(target.endpoint);
    } catch {
      throw new BridgeDispatchException(
        BridgeErrorCodes.EndpointInvalid,
        "bridge_target.endpoint must be an absolute http:// or https:// URI.",
      );
    }

    if (uri.protocol !== "http:" && uri.protocol !== "https:") {
      throw new BridgeDispatchException(
        BridgeErrorCodes.EndpointInvalid,
        "bridge_target.endpoint must be an absolute http:// or https:// URI.",
      );
    }

    const allowHttp = getBool(target, "allow_http", true);
    if (!allowHttp && uri.protocol === "http:") {
      throw new BridgeDispatchException(
        BridgeErrorCodes.EndpointInvalid,
        "bridge_target.endpoint MUST use https:// unless bridge_target.allow_http is true.",
      );
    }

    const allowedPrefixes = getStringList(target, "allowed_prefixes");
    if (allowedPrefixes.length > 0 && !allowedPrefixes.some((prefix) => matchesAllowedPrefix(uri, prefix))) {
      throw new BridgeDispatchException(
        BridgeErrorCodes.EndpointInvalid,
        `bridge_target.endpoint '${target.endpoint}' is not in bridge_target.allowed_prefixes.`,
      );
    }

    const rejectPrivate = getBool(target, "reject_private", true);
    if (rejectPrivate && isPrivateHost(uri.hostname)) {
      throw new BridgeDispatchException(
        BridgeErrorCodes.EndpointInvalid,
        `bridge_target.endpoint host '${uri.hostname}' is private or loopback (SSRF guard).`,
      );
    }

    return uri;
  },
};

function getBool(target: BridgeTarget, name: string, defaultValue: boolean): boolean {
  const found = BridgeTargetParser.tryGetJson(target, name);
  if (found === undefined) return defaultValue;
  const value = found.value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return defaultValue;
}

function getStringList(target: BridgeTarget, name: string): string[] {
  const found = BridgeTargetParser.tryGetJson(target, name);
  if (found === undefined) return [];
  const value = found.value;

  if (typeof value === "string" && value.trim() !== "") return [value];
  if (!Array.isArray(value)) return [];

  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") items.push(item);
  }
  return items;
}

function matchesAllowedPrefix(endpoint: URL, rawPrefix: string): boolean {
  let prefix: URL;
  try {
    prefix = new URL(rawPrefix);
  } catch {
    return false;
  }

  if (
    endpoint.protocol.toLowerCase() !== prefix.protocol.toLowerCase() ||
    endpoint.hostname.toLowerCase() !== prefix.hostname.toLowerCase() ||
    effectivePort(endpoint) !== effectivePort(prefix)
  ) {
    return false;
  }

  const prefixPath = prefix.pathname;
  if (prefixPath === "/") return true;

  const endpointPath = endpoint.pathname;
  if (!endpointPath.toLowerCase().startsWith(prefixPath.toLowerCase())) return false;

  return (
    endpointPath.length === prefixPath.length ||
    prefixPath.endsWith("/") ||
    endpointPath[prefixPath.length] === "/"
  );
}

function effectivePort(uri: URL): number {
  if (uri.port !== "") return Number(uri.port);
  return uri.protocol === "https:" ? 443 : uri.protocol === "http:" ? 80 : -1;
}
