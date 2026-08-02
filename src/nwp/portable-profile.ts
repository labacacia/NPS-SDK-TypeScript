// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { NpsStatusCodes } from "../core/status-codes.js";
import {
  MIME_CAPSULE,
  MIME_ERROR,
  MIME_FRAME,
  MIME_LEGACY_FRAME,
  MIME_MANIFEST,
} from "./http-headers.js";
import {
  NWP_BRIDGE_ENDPOINT_INVALID,
  NWP_BRIDGE_PROTOCOL_UNSUPPORTED,
  NWP_BRIDGE_TARGET_INVALID,
  NWP_BRIDGE_UPSTREAM_FAILED,
  NWP_HTTP_ACCEPT_UNSATISFIABLE,
  NWP_HTTP_BODY_TOO_LARGE,
  NWP_HTTP_CONTENT_TYPE_UNSUPPORTED,
  NWP_HTTP_FRAME_BODY_MALFORMED,
} from "./nwp-error-codes.js";
import { validateChildUrl } from "./callback-validator.js";

export type NwpServerTransport = "http" | "native";
export type NwpPortableNodeRole = "memory" | "action" | "complex";
export type NwpTelemetryOutcome = "success" | "rejected" | "cancelled" | "timeout";

export interface NwpPortableNodeRequest {
  transport: NwpServerTransport;
  nodeRole: NwpPortableNodeRole;
  method?: string;
  path?: string;
  contentType?: string;
  accept?: string;
  bodyBytes?: number;
  maxBodyBytes?: number;
  frameKind?: string;
  bodyValid?: boolean;
  cancelled?: boolean;
  correlationId?: string;
}

export interface NwpPortableNodeDecision {
  decision:
    | "serve_manifest"
    | "dispatch_query"
    | "dispatch_action"
    | "reject"
    | "abort"
    | "error_frame";
  httpStatus?: number;
  contentType?: string;
  status?: string;
  error?: string;
  allow?: string;
  responseFrame?: string;
  correlationId?: string;
  telemetryOutcome: NwpTelemetryOutcome;
  legacyMediaTypeAccepted?: boolean;
}

/** Evaluate NWP v0.20 Node admission without touching a stream or provider. */
export function evaluatePortableNode(
  request: NwpPortableNodeRequest,
): NwpPortableNodeDecision {
  if (request.cancelled === true) {
    return nodeResult(request, "abort", { telemetryOutcome: "cancelled" });
  }
  if (request.transport === "native") return evaluateNativeNode(request);
  return evaluateHttpNode(request);
}

function evaluateHttpNode(request: NwpPortableNodeRequest): NwpPortableNodeDecision {
  const path = (request.path ?? "").toLowerCase();
  const method = (request.method ?? "").toUpperCase();
  if (path === "/.nwm") {
    if (method !== "GET") return methodNotAllowed(request, "GET");
    return nodeResult(request, "serve_manifest", {
      httpStatus: 200,
      contentType: MIME_MANIFEST,
    });
  }
  if (path !== "/query" && path !== "/invoke") {
    return nodeReject(
      request,
      404,
      NpsStatusCodes.NPS_CLIENT_NOT_FOUND,
      NWP_HTTP_FRAME_BODY_MALFORMED,
    );
  }
  if (method !== "POST") return methodNotAllowed(request, "POST");

  const mediaType = baseMediaType(request.contentType);
  const legacy = mediaType === MIME_LEGACY_FRAME;
  if (!legacy && mediaType !== MIME_FRAME) {
    return nodeReject(
      request,
      400,
      NpsStatusCodes.NPS_CLIENT_BAD_FRAME,
      NWP_HTTP_CONTENT_TYPE_UNSUPPORTED,
    );
  }
  if (!accepts(request.accept, MIME_CAPSULE)) {
    return nodeReject(
      request,
      400,
      NpsStatusCodes.NPS_CLIENT_BAD_PARAM,
      NWP_HTTP_ACCEPT_UNSATISFIABLE,
    );
  }

  const maxBodyBytes = request.maxBodyBytes ?? 1024 * 1024;
  if (maxBodyBytes <= 0) throw new RangeError("maxBodyBytes must be positive");
  if ((request.bodyBytes ?? 0) > maxBodyBytes) {
    return nodeReject(
      request,
      413,
      NpsStatusCodes.NPS_LIMIT_PAYLOAD,
      NWP_HTTP_BODY_TOO_LARGE,
    );
  }
  if (request.bodyValid === false) {
    return nodeReject(
      request,
      400,
      NpsStatusCodes.NPS_CLIENT_BAD_FRAME,
      NWP_HTTP_FRAME_BODY_MALFORMED,
    );
  }

  const frameKind = (request.frameKind ?? "").toLowerCase();
  const query =
    path === "/query" &&
    (request.nodeRole === "memory" || request.nodeRole === "complex") &&
    frameKind === "query";
  const action =
    path === "/invoke" &&
    (request.nodeRole === "action" || request.nodeRole === "complex") &&
    frameKind === "action";
  if (!query && !action) {
    return nodeReject(
      request,
      400,
      NpsStatusCodes.NPS_CLIENT_BAD_FRAME,
      NWP_HTTP_FRAME_BODY_MALFORMED,
    );
  }
  return nodeResult(request, query ? "dispatch_query" : "dispatch_action", {
    httpStatus: 200,
    contentType: MIME_CAPSULE,
    legacyMediaTypeAccepted: legacy,
  });
}

function evaluateNativeNode(request: NwpPortableNodeRequest): NwpPortableNodeDecision {
  const frameKind = (request.frameKind ?? "").toLowerCase();
  const query =
    frameKind === "query" &&
    (request.nodeRole === "memory" || request.nodeRole === "complex");
  const action =
    frameKind === "action" &&
    (request.nodeRole === "action" || request.nodeRole === "complex");
  if (request.bodyValid !== false && (query || action)) {
    return nodeResult(request, query ? "dispatch_query" : "dispatch_action", {
      responseFrame: "caps",
    });
  }
  return nodeResult(request, "error_frame", {
    status: NpsStatusCodes.NPS_CLIENT_BAD_FRAME,
    error: "NWP-NATIVE-FRAME-UNSUPPORTED",
    responseFrame: "error",
    telemetryOutcome: "rejected",
  });
}

function methodNotAllowed(
  request: NwpPortableNodeRequest,
  allowedMethod: string,
): NwpPortableNodeDecision {
  return nodeResult(request, "reject", {
    httpStatus: 405,
    allow: allowedMethod,
    telemetryOutcome: "rejected",
  });
}

function nodeReject(
  request: NwpPortableNodeRequest,
  httpStatus: number,
  status: string,
  error: string,
): NwpPortableNodeDecision {
  return nodeResult(request, "reject", {
    httpStatus,
    contentType: MIME_ERROR,
    status,
    error,
    telemetryOutcome: "rejected",
  });
}

function nodeResult(
  request: NwpPortableNodeRequest,
  decision: NwpPortableNodeDecision["decision"],
  values: Partial<NwpPortableNodeDecision> = {},
): NwpPortableNodeDecision {
  return {
    decision,
    correlationId: request.correlationId,
    telemetryOutcome: "success",
    ...values,
  };
}

export interface BridgeLifecycleRequest {
  protocol: string;
  endpoint: string;
  registeredProtocols: readonly string[];
  allowHttp?: boolean;
  rejectPrivate?: boolean;
  allowedPrefixes?: readonly string[];
  timeoutMs: number;
  elapsedMs: number;
  cancelled?: boolean;
  correlationId?: string;
  taskMode?: string;
}

export interface BridgeLifecycleDecision {
  decision: "dispatch" | "reject" | "abort";
  httpStatus?: number;
  status?: string;
  error?: string;
  correlationId?: string;
  taskMode?: "sync" | "async";
  telemetryOutcome: NwpTelemetryOutcome;
}

/** Evaluate outbound Bridge preflight without making an upstream connection. */
export function evaluateBridgeLifecycle(
  request: BridgeLifecycleRequest,
): BridgeLifecycleDecision {
  if (request.cancelled === true) {
    return bridgeResult(request, "abort", { telemetryOutcome: "cancelled" });
  }
  if (request.protocol.trim() === "" || request.endpoint.trim() === "") {
    return bridgeResult(request, "reject", {
      httpStatus: 422,
      status: NpsStatusCodes.NPS_CLIENT_UNPROCESSABLE,
      error: NWP_BRIDGE_TARGET_INVALID,
      telemetryOutcome: "rejected",
    });
  }
  if (!request.registeredProtocols.some(
    (protocol) => protocol.toLowerCase() === request.protocol.toLowerCase(),
  )) {
    return bridgeResult(request, "reject", {
      httpStatus: 501,
      status: NpsStatusCodes.NPS_SERVER_UNSUPPORTED,
      error: NWP_BRIDGE_PROTOCOL_UNSUPPORTED,
      telemetryOutcome: "rejected",
    });
  }

  const endpointError = validateChildUrl(
    request.endpoint,
    request.allowedPrefixes ?? [],
    request.rejectPrivate ?? true,
    request.allowHttp ?? true,
  );
  if (endpointError !== null) {
    return bridgeResult(request, "reject", {
      httpStatus: 422,
      status: NpsStatusCodes.NPS_CLIENT_UNPROCESSABLE,
      error: NWP_BRIDGE_ENDPOINT_INVALID,
      telemetryOutcome: "rejected",
    });
  }

  if (request.timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  if (request.elapsedMs < 0) throw new RangeError("elapsedMs must not be negative");
  if (request.elapsedMs >= request.timeoutMs) {
    return bridgeResult(request, "reject", {
      httpStatus: 504,
      status: NpsStatusCodes.NPS_SERVER_TIMEOUT,
      error: NWP_BRIDGE_UPSTREAM_FAILED,
      telemetryOutcome: "timeout",
    });
  }

  const taskMode = request.taskMode?.toLowerCase() === "async" ? "async" : "sync";
  return bridgeResult(request, "dispatch", {
    status:
      taskMode === "async"
        ? NpsStatusCodes.NPS_OK_ACCEPTED
        : NpsStatusCodes.NPS_OK,
    taskMode,
  });
}

function bridgeResult(
  request: BridgeLifecycleRequest,
  decision: BridgeLifecycleDecision["decision"],
  values: Partial<BridgeLifecycleDecision> = {},
): BridgeLifecycleDecision {
  return {
    decision,
    correlationId: request.correlationId,
    telemetryOutcome: "success",
    ...values,
  };
}

function baseMediaType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function accepts(accept: string | undefined, responseType: string): boolean {
  if (accept === undefined || accept.trim() === "") return true;
  return accept.split(",").some((value) => {
    const mediaType = baseMediaType(value);
    return mediaType === "*/*" || mediaType === "application/*" || mediaType === responseType;
  });
}
