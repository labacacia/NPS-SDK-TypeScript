// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import type { ActionFrame } from "../frames.js";
import { BridgeErrorCodes, BridgeDispatchException } from "./errors.js";
import type { BridgeTarget } from "../bridge.js";

export type { BridgeTarget } from "../bridge.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parser and accessors for the `bridge_target` action parameter
 * (port of .NET `BridgeTargetParser`).
 */
export const BridgeTargetParser = {
  /** Parse `params.bridge_target` from an action frame. */
  fromActionFrame(frame: ActionFrame): BridgeTarget {
    const parameters = frame.params;
    if (parameters == null) {
      throw new BridgeDispatchException(
        BridgeErrorCodes.TargetInvalid,
        "params.bridge_target is required.",
      );
    }

    let targetElement: unknown = parameters;
    if (isPlainObject(parameters) && "bridge_target" in parameters) {
      targetElement = parameters["bridge_target"];
    }

    return BridgeTargetParser.fromJson(targetElement);
  },

  /** Parse a bridge target JSON object. */
  fromJson(targetElement: unknown): BridgeTarget {
    if (!isPlainObject(targetElement)) {
      throw new BridgeDispatchException(
        BridgeErrorCodes.TargetInvalid,
        "bridge_target must be an object.",
      );
    }

    const protocol = readRequiredString(targetElement, "protocol");
    const endpoint = readRequiredString(targetElement, "endpoint");
    const extras: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(targetElement)) {
      if (name === "protocol" || name === "endpoint") continue;

      if (name === "extras" && isPlainObject(value)) {
        for (const [extraName, extraValue] of Object.entries(value)) {
          extras[extraName] = extraValue;
        }
        continue;
      }

      extras[name] = value;
    }

    return Object.keys(extras).length === 0
      ? { protocol, endpoint }
      : { protocol, endpoint, extras };
  },

  /** Read a string extra from a target (case-insensitive key match). */
  getString(target: BridgeTarget, name: string, defaultValue?: string): string | undefined {
    const value = tryGetExtra(target, name);
    if (value === undefined || value === null) return defaultValue;

    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (typeof value === "boolean") return value ? "True" : "False";
    return String(value);
  },

  /** Try to read a JSON (raw) extra from a target. Returns `undefined` when absent. */
  tryGetJson(target: BridgeTarget, name: string): { value: unknown } | undefined {
    const value = tryGetExtra(target, name);
    if (value === undefined || value === null) return undefined;
    return { value };
  },
};

function tryGetExtra(target: BridgeTarget, name: string): unknown {
  if (target.extras == null) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(target.extras)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function readRequiredString(obj: Record<string, unknown>, name: string): string {
  const value = obj[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BridgeDispatchException(
      BridgeErrorCodes.TargetInvalid,
      `bridge_target.${name} is required.`,
    );
  }
  return value;
}
