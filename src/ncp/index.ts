// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 LabAcacia / INNO LOTUS PTY LTD
export * from "./frames/anchor-frame.js";
export * from "./frames/caps-frame.js";
export * from "./frames/diff-frame.js";
export * from "./frames/error-frame.js";
export * from "./frames/hello-frame.js";
export * from "./frames/stream-frame.js";
export * from "./ncp-error-codes.js";
export * from "./ncp-patch-format.js";
export * from "./handshake.js";
export * from "./stream-manager.js";
export * from "./preamble.js";
// Native-mode TCP transport (NPS-1 §4.6) — ported from the .NET reference.
// Note: the OOP frame classes in ./frames.js (HelloFrame, CapsFrame, ErrorFrame,
// …) intentionally share names with the POJO interfaces re-exported above from
// ./frames/*.js, so only the transport-specific NcpHandshakeCapsFrame is
// re-exported here. Import the frame classes directly from "./frames.js" when
// the OOP variants are required.
export { NcpHandshakeCapsFrame } from "./frames.js";
export { NcpEncodingPolicy, NpsEncodingUnsupportedError } from "./encoding-policy.js";
export { SocketFrameReader, NcpStreamClosedError } from "./socket-frame-reader.js";
export { NcpSession } from "./session.js";
export { NcpNativeClient, NcpHandshakeError } from "./native-client.js";
export { NcpServer } from "./server.js";
export { NcpServerConnection } from "./server-connection.js";
export { resolveServerOptions } from "./server-options.js";
export type { NcpServerOptions } from "./server-options.js";
