// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { HDR_AGENT, MIME_MANIFEST } from "../http-headers.js";
import { ActionFrame } from "../frames.js";
import { ErrorFrame } from "../../ncp/frames.js";
import { NODE_TYPE_BRIDGE } from "../bridge.js";
import { BridgeErrorCodes, BridgeDispatchException } from "./errors.js";
import { BridgeDispatcherRegistry, BridgeNode, type FetchFn } from "./dispatcher.js";

/** Options for the Web-fetch hosted Bridge Node (port of .NET `BridgeNodeOptions`). */
export interface BridgeNodeAppOptions {
  /** Bridge Node identifier surfaced in `/.nwm`. */
  nodeId?: string;
  /** Path prefix for the Bridge Node endpoints. Empty string means root. */
  pathPrefix?: string;
  /** Action id accepted by `/invoke`. */
  actionId?: string;
  /** Require the `X-NWP-Agent` header before dispatching. */
  requireAuth?: boolean;
  /** Register HTTP/HTTPS, gRPC, MCP, and A2A dispatchers automatically. */
  registerBuiltInDispatchers?: boolean;
}

/**
 * WHATWG Fetch handler exposing a Bridge Node at `/.nwm`, `/actions`, and
 * `/invoke` (port of .NET `BridgeNodeMiddleware`).
 */
export class BridgeNodeApp {
  private readonly nodeId: string;
  private readonly prefix: string;
  private readonly actionId: string;
  private readonly requireAuth: boolean;
  private readonly bridge: BridgeNode;
  private readonly registry: BridgeDispatcherRegistry;

  constructor(
    options: BridgeNodeAppOptions = {},
    deps: { registry?: BridgeDispatcherRegistry; fetchFn?: FetchFn } = {},
  ) {
    this.nodeId = options.nodeId ?? "nps-bridge";
    this.prefix = (options.pathPrefix ?? "").replace(/\/+$/, "");
    this.actionId = options.actionId ?? "bridge.dispatch";
    this.requireAuth = options.requireAuth ?? false;

    if (deps.registry !== undefined) {
      this.registry = deps.registry;
    } else if (options.registerBuiltInDispatchers ?? true) {
      this.registry = BridgeDispatcherRegistry.createDefault(deps.fetchFn);
    } else {
      this.registry = new BridgeDispatcherRegistry();
    }
    this.bridge = new BridgeNode(this.registry);
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!path.toLowerCase().startsWith(this.prefix.toLowerCase())) {
      return notFound();
    }

    const sub = path.slice(this.prefix.length);
    switch (sub) {
      case "/.nwm":
      case "/.nwm/":
        return writeJson(200, this.buildManifest(), MIME_MANIFEST);
      case "/actions":
      case "/actions/":
        return writeJson(200, this.buildActions());
      case "/invoke":
      case "/invoke/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleInvoke(req);
      default:
        return notFound();
    }
  };

  private async handleInvoke(req: Request): Promise<Response> {
    if (this.requireAuth && !req.headers.get(HDR_AGENT)) {
      return writeError(401, "NPS-CLIENT-UNAUTHORIZED", "NWP-BRIDGE-AUTH-REQUIRED", "X-NWP-Agent header is required.");
    }

    let frame: ActionFrame;
    try {
      const body = (await req.json()) as Record<string, unknown>;
      frame = ActionFrame.fromDict(body);
    } catch (err) {
      return writeError(
        400,
        "NPS-CLIENT-BAD-REQUEST",
        BridgeErrorCodes.TargetInvalid,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (frame.actionId !== this.actionId) {
      return writeError(
        404,
        "NPS-CLIENT-NOT-FOUND",
        "NWP-BRIDGE-ACTION-NOT-FOUND",
        `Unknown bridge action '${frame.actionId}'.`,
      );
    }

    try {
      const caps = await this.bridge.dispatch(frame);
      return writeJson(200, caps.toDict());
    } catch (err) {
      if (err instanceof BridgeDispatchException) {
        const status = err.errorCode === BridgeErrorCodes.UpstreamFailed ? 502 : 400;
        const npsStatus = status === 502 ? "NPS-SERVER-UPSTREAM-FAILED" : "NPS-CLIENT-BAD-REQUEST";
        return writeError(status, npsStatus, err.errorCode, err.message);
      }
      return writeError(
        500,
        "NPS-SERVER-ERROR",
        BridgeErrorCodes.UpstreamFailed,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private buildManifest(): Record<string, unknown> {
    return {
      node_type: NODE_TYPE_BRIDGE,
      node_id: this.nodeId,
      bridge_protocols: [...this.registry.protocols].sort((a, b) => a.localeCompare(b)),
      actions: [this.actionId],
    };
  }

  private buildActions(): unknown[] {
    return [
      {
        action_id: this.actionId,
        description: "Dispatch an NWP ActionFrame to an external Bridge target.",
        bridge_protocols: [...this.registry.protocols].sort((a, b) => a.localeCompare(b)),
      },
    ];
  }
}

function writeJson(status: number, body: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function writeError(httpStatus: number, status: string, error: string, message: string): Response {
  const frame = new ErrorFrame(status, error, message);
  return writeJson(httpStatus, frame.toDict());
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}
