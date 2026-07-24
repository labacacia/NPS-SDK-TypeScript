// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import type { CapsFrame } from "../../ncp/frames.js";
import type { ActionFrame } from "../frames.js";
import { BridgeErrorCodes, BridgeDispatchException } from "./errors.js";
import { BridgeTargetParser, type BridgeTarget } from "./target.js";

/** WHATWG fetch signature used by all outbound Bridge dispatchers. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Translates one NWP action invocation into a concrete non-NPS protocol call
 * (port of .NET `IBridgeDispatcher`).
 */
export interface IBridgeDispatcher {
  /** Bridge protocol identifier served by this dispatcher. */
  readonly protocol: string;

  /** Dispatch an action frame to the requested external target. */
  dispatch(frame: ActionFrame, target: BridgeTarget): Promise<CapsFrame>;
}

/**
 * In-memory registry mapping bridge protocol identifiers to dispatchers
 * (port of .NET `BridgeDispatcherRegistry`). Protocol lookup is
 * case-insensitive.
 */
export class BridgeDispatcherRegistry {
  private readonly dispatchers = new Map<string, IBridgeDispatcher>();

  constructor(dispatchers?: Iterable<IBridgeDispatcher>) {
    if (dispatchers) {
      for (const dispatcher of dispatchers) this.register(dispatcher);
    }
  }

  /**
   * Create a registry with all built-in dispatchers: HTTP/HTTPS, gRPC JSON,
   * MCP JSON-RPC, and A2A JSON-RPC.
   */
  static createDefault(fetchFn: FetchFn = globalFetch): BridgeDispatcherRegistry {
    // Imported lazily to avoid a circular module dependency at load time.
    return new BridgeDispatcherRegistry()
      .register(new HttpBridgeDispatcher(fetchFn))
      .register(new GrpcBridgeDispatcher(fetchFn))
      .register(new McpBridgeDispatcher(fetchFn))
      .register(new A2aBridgeDispatcher(fetchFn));
  }

  /** The currently registered protocol identifiers. */
  get protocols(): string[] {
    return [...this.dispatchers.values()].map((d) => d.protocol);
  }

  /** Register or replace the dispatcher for its protocol. */
  register(dispatcher: IBridgeDispatcher): this {
    if (dispatcher == null) throw new Error("Bridge dispatcher must not be null.");
    if (!dispatcher.protocol || dispatcher.protocol.trim() === "") {
      throw new Error("Bridge dispatcher protocol must not be empty.");
    }
    this.dispatchers.set(dispatcher.protocol.toLowerCase(), dispatcher);
    return this;
  }

  /** Resolve a dispatcher for `protocol`. */
  resolve(protocol: string): IBridgeDispatcher {
    if (!protocol || protocol.trim() === "") {
      throw new BridgeDispatchException(BridgeErrorCodes.TargetInvalid, "bridge_target.protocol is required.");
    }

    const dispatcher = this.dispatchers.get(protocol.toLowerCase());
    if (dispatcher === undefined) {
      throw new BridgeDispatchException(
        BridgeErrorCodes.ProtocolUnsupported,
        `Bridge protocol '${protocol}' is not registered.`,
      );
    }
    return dispatcher;
  }
}

/**
 * Stateless Bridge Node dispatcher facade (port of .NET `BridgeNode`). Host
 * transports can feed decoded `ActionFrame` values here and write the returned
 * `CapsFrame`.
 */
export class BridgeNode {
  constructor(private readonly dispatchers: BridgeDispatcherRegistry) {
    if (dispatchers == null) throw new Error("BridgeDispatcherRegistry is required.");
  }

  /** Parse `bridge_target`, resolve a protocol dispatcher, and invoke it. */
  dispatch(frame: ActionFrame): Promise<CapsFrame> {
    if (frame == null) throw new Error("ActionFrame is required.");
    const target = BridgeTargetParser.fromActionFrame(frame);
    const dispatcher = this.dispatchers.resolve(target.protocol);
    return dispatcher.dispatch(frame, target);
  }
}

export const globalFetch: FetchFn = (input, init) => fetch(input, init);

// Imports placed after the class definitions to keep `createDefault` wiring
// close to the registry while avoiding a hoisting hazard for the constructors.
import { HttpBridgeDispatcher } from "./http-dispatcher.js";
import { GrpcBridgeDispatcher } from "./grpc-dispatcher.js";
import { McpBridgeDispatcher, A2aBridgeDispatcher } from "./json-rpc-dispatcher.js";
