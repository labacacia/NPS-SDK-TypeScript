// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { NpsFrameCodec } from "../src/core/codec.js";
import { EncodingTier } from "../src/core/frames.js";
import { CapsFrame, ErrorFrame } from "../src/ncp/frames.js";
import { createFullRegistry } from "../src/setup.js";
import { ActionFrame, QueryFrame } from "../src/nwp/frames.js";
import { NwpNativeNodeServer } from "../src/nwp/native-server.js";

describe("NwpNativeNodeServer", () => {
  it("dispatchWire returns a CapsFrame for QueryFrame", async () => {
    const codec = new NpsFrameCodec(createFullRegistry());
    const server = new NwpNativeNodeServer({
      codec,
      queryHandler: () => [{ id: 42 }],
    });

    const out = await server.dispatchWire(
      codec.encode(QueryFrame.fromDict({ anchor_ref: "sha256:a", request_id: "req-query-1" }), { overrideTier: EncodingTier.MSGPACK }),
    );
    const frame = codec.decode(out);

    expect(frame).toBeInstanceOf(CapsFrame);
    expect((frame as CapsFrame).count).toBe(1);
    expect((frame as CapsFrame).data[0]?.id).toBe(42);
    expect((frame as CapsFrame).requestId).toBe("req-query-1");
  });

  it("serves frames from an async chunk source", async () => {
    const codec = new NpsFrameCodec(createFullRegistry());
    const server = new NwpNativeNodeServer({
      codec,
      actionHandler: (frame) => ({ action: frame.actionId }),
    });
    const request = codec.encode(new ActionFrame("ping", undefined, undefined, undefined, undefined, "req-action-1"), { overrideTier: EncodingTier.MSGPACK });
    const writes: Uint8Array[] = [];

    await server.serve([request.slice(0, 2), request.slice(2)], {
      write(chunk) { writes.push(chunk); },
    });

    const frame = codec.decode(writes[0]!);
    expect(frame).toBeInstanceOf(CapsFrame);
    expect((frame as CapsFrame).data[0]?.action).toBe("ping");
    expect((frame as CapsFrame).requestId).toBe("req-action-1");
  });

  it("rejects unnegotiated BinaryVector frames", async () => {
    const codec = new NpsFrameCodec(createFullRegistry());
    const server = new NwpNativeNodeServer({
      codec,
      queryHandler: () => [{ id: 42 }],
    });
    const out = await server.dispatchWire(
      codec.encode(vectorQuery(), { overrideTier: EncodingTier.BINARY_VECTOR }),
    );
    const frame = codec.decode(out);

    expect(frame).toBeInstanceOf(ErrorFrame);
    expect((frame as ErrorFrame).status).toBe("NPS-SERVER-ENCODING-UNSUPPORTED");
    expect((frame as ErrorFrame).error).toBe("NCP-ENCODING-UNSUPPORTED");
  });

  it("allows negotiated BinaryVector QueryFrame", async () => {
    const codec = new NpsFrameCodec(createFullRegistry());
    const server = new NwpNativeNodeServer({
      codec,
      enabledEncodings: ["msgpack", "binary_vector.v1"],
      queryHandler: () => [{ id: 42 }],
    });
    const out = await server.dispatchWire(
      codec.encode(vectorQuery(), { overrideTier: EncodingTier.BINARY_VECTOR }),
    );
    const frame = codec.decode(out);

    expect(frame).toBeInstanceOf(CapsFrame);
    expect((frame as CapsFrame).count).toBe(1);
  });

  it("accepts the legacy action key", () => {
    const frame = ActionFrame.fromDict({ action: "ping" });

    expect(frame.actionId).toBe("ping");
  });

  it("returns ErrorFrame for unsupported frames", async () => {
    const server = new NwpNativeNodeServer();
    const frame = await server.dispatch(new ErrorFrame("NPS-TEST", "TEST"));

    expect(frame).toBeInstanceOf(ErrorFrame);
    expect((frame as ErrorFrame).error).toBe("NWP-NATIVE-FRAME-UNSUPPORTED");
  });
});

function vectorQuery(): QueryFrame {
  return new QueryFrame(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { field: "embedding", vector: [0.25, -1.5, 3.0], top_k: 1 },
  );
}
