// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Experimental parsing, exact-byte verification and host-bound admission helpers.
 * Importing this entrypoint does not advertise a profile, negotiate a session or
 * guarantee admission at an HTTP route. Host policy and authenticated transport
 * remain mandatory. The optional SQLite implementation is a separate subpath.
 */
export * from './alpha20/feature-wire-parser.js';
export * from './alpha20/context-bytes.js';
export * from './alpha20/context-admission.js';
export { ContextFormatError } from './alpha20/strict-json.js';
export type { JsonObject, JsonValue } from './alpha20/strict-json.js';
