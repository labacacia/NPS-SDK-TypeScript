// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import type { AnnounceFrame } from "./frames.js";
import { verifyAnnounceSignature } from "./registry-profile.js";
import {
  NDP_ANNOUNCE_NID_MISMATCH,
  NDP_ANNOUNCE_SIGNATURE_INVALID,
} from "./ndp-error-codes.js";

ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

export interface NdpAnnounceResult {
  isValid: boolean;
  errorCode?: string;
  message?: string;
}

export const NdpAnnounceResult = {
  ok: (): NdpAnnounceResult => ({ isValid: true }),
  fail: (errorCode: string, message: string): NdpAnnounceResult => ({
    isValid: false,
    errorCode,
    message,
  }),
};

export class NdpAnnounceValidator {
  private readonly _keys = new Map<string, string>(); // nid → "ed25519:<hex>"

  registerPublicKey(nid: string, encodedPubKey: string): void {
    this._keys.set(nid, encodedPubKey);
  }

  removePublicKey(nid: string): void {
    this._keys.delete(nid);
  }

  get knownPublicKeys(): ReadonlyMap<string, string> {
    return this._keys;
  }

  validate(frame: AnnounceFrame): NdpAnnounceResult {
    const encoded = this._keys.get(frame.nid);
    if (encoded === undefined) {
      return NdpAnnounceResult.fail(
        NDP_ANNOUNCE_NID_MISMATCH,
        `No public key registered for NID: ${frame.nid}`,
      );
    }
    if (verifyAnnounceSignature(frame.toDict(), encoded, frame.signature)) {
      return NdpAnnounceResult.ok();
    }

    try {
      const prefix = "ed25519:";
      const pubHex = encoded.startsWith(prefix)
        ? encoded.slice(prefix.length)
        : encoded;
      const pubKey = Buffer.from(pubHex, "hex");

      const sig = frame.signature;
      if (!sig.startsWith(prefix)) {
        return NdpAnnounceResult.fail(
          NDP_ANNOUNCE_SIGNATURE_INVALID,
          "Signature must start with 'ed25519:'",
        );
      }
      const sigBytes = Buffer.from(sig.slice(prefix.length), "base64");

      const unsigned = frame.unsignedDict();
      const canonical = JSON.stringify(unsigned, Object.keys(unsigned).sort());
      const message = new TextEncoder().encode(canonical);

      const valid = ed25519.verify(sigBytes, message, pubKey);
      if (!valid)
        return NdpAnnounceResult.fail(
          NDP_ANNOUNCE_SIGNATURE_INVALID,
          "Ed25519 signature verification failed.",
        );
      return NdpAnnounceResult.ok();
    } catch {
      return NdpAnnounceResult.fail(
        NDP_ANNOUNCE_SIGNATURE_INVALID,
        "Ed25519 signature verification failed.",
      );
    }
  }
}
