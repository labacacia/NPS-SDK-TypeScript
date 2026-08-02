// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * OID constants for NPS X.509 certificates per NPS-RFC-0002 §4.
 *
 * The 1.3.6.1.4.1.65715 arc is the LabAcacia IANA-assigned Private Enterprise
 * Number (PEN 65715, NPS-CR-0004, 2026-05-08).
 */

export const LAB_ACACIA_PEN_ARC = "1.3.6.1.4.1.65715";
export const EKU_ARC            = `${LAB_ACACIA_PEN_ARC}.1`;
export const EXTENSION_ARC      = `${LAB_ACACIA_PEN_ARC}.2`;

// ── EKUs (NPS-RFC-0002 §4.1) ─────────────────────────────────────────────────
export const EKU_AGENT_IDENTITY        = `${EKU_ARC}.1`;
export const EKU_NODE_IDENTITY         = `${EKU_ARC}.2`;
export const EKU_CA_INTERMEDIATE_AGENT = `${EKU_ARC}.3`;

// ── Custom extensions ────────────────────────────────────────────────────────
export const NID_ASSURANCE_LEVEL = `${EXTENSION_ARC}.1`;
/** `id-nps-node-roles` — SEQUENCE OF UTF8String, the CA-attested node-role set (NIP v0.10). */
export const ID_NPS_NODE_ROLES   = `${EXTENSION_ARC}.2`;
/** `id-nps-capabilities` — SEQUENCE OF UTF8String, the CA-attested capability set (NIP v0.12). */
export const ID_NPS_CAPABILITIES = `${EXTENSION_ARC}.3`;

// ── Ed25519 algorithm OID per RFC 8410 ───────────────────────────────────────
export const ED25519 = "1.3.101.112";

// ── Standard X.509 OIDs we reference ─────────────────────────────────────────
export const OID_EXTENDED_KEY_USAGE = "2.5.29.37";
