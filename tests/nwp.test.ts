// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ActionFrame,
  NWP_TOPOLOGY_SNAPSHOT,
  QueryFrame,
  asyncActionResponseFromDict,
  type BridgeNodeSpec,
  type TopologySnapshotRequest,
} from "../src/nwp/frames.js";
import { NwpClient } from "../src/nwp/client.js";
import { createDefaultRegistry, createFullRegistry } from "../src/setup.js";
import { NpsFrameCodec, EncodingTier } from "../src/core/index.js";
import { AnchorFrame, CapsFrame, StreamFrame } from "../src/ncp/frames.js";

// ── QueryFrame ────────────────────────────────────────────────────────────────

describe("QueryFrame", () => {
  it("round-trips via toDict / fromDict", () => {
    const f = new QueryFrame(
      "sha256:" + "a".repeat(64),
      { name: { $eq: "Alice" } },
      10,
      0,
      [{ field: "name", dir: "asc" }],
      ["id", "name"],
      { vector: [0.1, 0.2], topK: 5 },
      2,
    );
    const back = QueryFrame.fromDict(f.toDict());
    expect(back.anchorRef).toBe(f.anchorRef);
    expect(back.limit).toBe(10);
    expect(back.offset).toBe(0);
    expect(back.orderBy?.[0]?.field).toBe("name");
    expect(back.fields?.[1]).toBe("name");
    expect(back.vectorSearch?.topK).toBe(5);
    expect(back.depth).toBe(2);
  });

  it("handles all-optional constructor (empty query)", () => {
    const f    = new QueryFrame();
    const back = QueryFrame.fromDict(f.toDict());
    expect(back.anchorRef).toBeUndefined();
    expect(back.limit).toBeUndefined();
  });

  it("round-trips alpha.11 query extensions", () => {
    const f = QueryFrame.fromDict({
      anchor_ref: "sha256:" + "c".repeat(64),
      cursor: "next-page",
      order: [{ field: "created_at", dir: "DESC" }],
      vector_search: { field: "embedding", vector: [0.1, 0.2], top_k: 3, threshold: 0.7, metric: "cosine" },
      auto_anchor: true,
      stream: true,
      aggregate: { count: "*" },
      token_budget: 4096,
      tokenizer: "cl100k_base",
      request_id: "req-1",
    });

    expect(f.cursor).toBe("next-page");
    expect(f.orderBy?.[0]?.dir).toBe("DESC");
    expect(f.vectorSearch?.topK).toBe(3);
    expect(f.vectorSearch?.vectorField).toBe("embedding");
    expect(f.autoAnchor).toBe(true);
    expect(f.tokenBudget).toBe(4096);
  });

  it("round-trips vector search via BinaryVector tier", () => {
    const codec = new NpsFrameCodec(createFullRegistry());
    const f = new QueryFrame(
      "sha256:" + "d".repeat(64),
      undefined,
      3,
      undefined,
      undefined,
      undefined,
      { field: "embedding", vector: [0.25, -1.5, 3.0], topK: 2, metric: "cosine" },
    );

    const wire = codec.encode(f, { overrideTier: EncodingTier.BINARY_VECTOR });
    const header = NpsFrameCodec.peekHeader(wire);
    expect(header.encodingTier).toBe(EncodingTier.BINARY_VECTOR);
    expect([...wire.slice(header.headerSize, header.headerSize + 4)]).toEqual([0x4e, 0x50, 0x42, 0x56]);

    const out = codec.decode(wire) as QueryFrame;
    expect(out.vectorSearch?.field).toBe("embedding");
    expect(out.vectorSearch?.topK).toBe(2);
    expect(out.vectorSearch?.vector[0]).toBeCloseTo(0.25);
    expect(out.vectorSearch?.vector[1]).toBeCloseTo(-1.5);
    expect(out.vectorSearch?.vector[2]).toBeCloseTo(3.0);
  });
});

describe("NWP topology models", () => {
  it("exposes snapshot and bridge model shapes", () => {
    const req: TopologySnapshotRequest = {
      kind: NWP_TOPOLOGY_SNAPSHOT,
      anchorRef: "sha256:" + "d".repeat(64),
      includeBridges: true,
      maxDepth: 2,
    };
    const bridge: BridgeNodeSpec = {
      bridgeId: "bridge-1",
      sourceProtocol: "nwp",
      targetProtocol: "ndp",
    };

    expect(req.kind).toBe("topology.snapshot");
    expect(bridge.targetProtocol).toBe("ndp");
  });
});

// ── ActionFrame ───────────────────────────────────────────────────────────────

describe("ActionFrame", () => {
  it("round-trips via toDict / fromDict", () => {
    const f = new ActionFrame(
      "search",
      { q: "test" },
      true,
      "idem-key-1",
      5000,
      "req-action-1",
    );
    const back = ActionFrame.fromDict(f.toDict());
    expect(back.actionId).toBe("search");
    expect(back.params?.["q"]).toBe("test");
    expect(back.async_).toBe(true);
    expect(back.idempotencyKey).toBe("idem-key-1");
    expect(back.timeoutMs).toBe(5000);
    expect(back.requestId).toBe("req-action-1");
  });

  it("defaults async to false when not provided", () => {
    const f    = new ActionFrame("do-thing");
    const back = ActionFrame.fromDict(f.toDict());
    expect(back.async_).toBeFalsy();
  });
});

// ── asyncActionResponseFromDict ───────────────────────────────────────────────

describe("asyncActionResponseFromDict", () => {
  it("parses full response", () => {
    const r = asyncActionResponseFromDict({ task_id: "t1", status: "accepted", poll_url: "/poll/t1" });
    expect(r.taskId).toBe("t1");
    expect(r.status).toBe("accepted");
    expect(r.pollUrl).toBe("/poll/t1");
  });

  it("omits pollUrl when null", () => {
    const r = asyncActionResponseFromDict({ task_id: "t2", status: "accepted", poll_url: null });
    expect(r.pollUrl).toBeUndefined();
  });
});

// ── NwpClient ─────────────────────────────────────────────────────────────────

describe("NwpClient", () => {
  const registry = createDefaultRegistry();
  const codec    = new NpsFrameCodec(registry);
  const aid      = "sha256:" + "b".repeat(64);
  const schema   = { fields: [{ name: "id", type: "uint64" }] };

  beforeEach(() => { vi.restoreAllMocks(); });

  it("sendAnchor — POSTs and resolves on 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const client = new NwpClient("http://node.test");
    await expect(client.sendAnchor(new AnchorFrame(aid, schema))).resolves.toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://node.test/anchor",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sendAnchor — throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const client = new NwpClient("http://node.test");
    await expect(client.sendAnchor(new AnchorFrame(aid, schema))).rejects.toThrow("503");
  });

  it("query — decodes CapsFrame response", async () => {
    const capsFrame = new CapsFrame(aid, 1, [{ id: 42 }]);
    const wire      = codec.encode(capsFrame);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok:          true,
      arrayBuffer: () => Promise.resolve(wire.buffer),
    }));
    const client = new NwpClient("http://node.test");
    const result = await client.query(new QueryFrame(aid));
    expect(result).toBeInstanceOf(CapsFrame);
    expect(result.count).toBe(1);
  });

  it("query — throws when response is not CapsFrame", async () => {
    const anchorFrame = new AnchorFrame(aid, schema);
    const wire        = codec.encode(anchorFrame);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok:          true,
      arrayBuffer: () => Promise.resolve(wire.buffer),
    }));
    const client = new NwpClient("http://node.test");
    await expect(client.query(new QueryFrame(aid))).rejects.toThrow(TypeError);
  });

  it("query — throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const client = new NwpClient("http://node.test");
    await expect(client.query(new QueryFrame(aid))).rejects.toThrow("404");
  });

  it("invoke — sync NPS frame response", async () => {
    const capsFrame = new CapsFrame(aid, 0, []);
    const wire      = codec.encode(capsFrame);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok:          true,
      headers:     { get: () => "application/x-nps-frame" },
      arrayBuffer: () => Promise.resolve(wire.buffer),
    }));
    const client = new NwpClient("http://node.test");
    const result = await client.invoke(new ActionFrame("list"));
    expect(result).toBeInstanceOf(CapsFrame);
  });

  it("invoke — async response returns AsyncActionResponse", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve({ task_id: "t99", status: "queued" }),
    }));
    const client = new NwpClient("http://node.test");
    const result = await client.invoke(new ActionFrame("heavy", {}, true)) as { taskId: string };
    expect(result.taskId).toBe("t99");
  });

  it("invoke — sync JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok:      true,
      headers: { get: () => "application/json" },
      json:    () => Promise.resolve({ result: "ok" }),
    }));
    const client = new NwpClient("http://node.test");
    const result = await client.invoke(new ActionFrame("ping")) as { result: string };
    expect(result.result).toBe("ok");
  });

  it("invoke — throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const client = new NwpClient("http://node.test");
    await expect(client.invoke(new ActionFrame("ping"))).rejects.toThrow("500");
  });

  it("stream — yields StreamFrames and stops at isLast", async () => {
    const s0   = new StreamFrame("s1", 0, false, [{ id: 1 }]);
    const s1   = new StreamFrame("s1", 1, true,  [{ id: 2 }]);
    const w0   = codec.encode(s0);
    const w1   = codec.encode(s1);

    async function* mockBody() { yield w0; yield w1; }

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody() }));
    const client  = new NwpClient("http://node.test");
    const frames: StreamFrame[] = [];
    for await (const f of client.stream(new QueryFrame(aid))) {
      frames.push(f);
    }
    expect(frames).toHaveLength(2);
    expect(frames[0]!.seq).toBe(0);
    expect(frames[1]!.isLast).toBe(true);
  });

  it("stream — throws when chunk is not a StreamFrame", async () => {
    const anchor = new AnchorFrame(aid, schema);
    const wire   = codec.encode(anchor);
    async function* mockBody() { yield wire; }

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody() }));
    const client = new NwpClient("http://node.test");
    await expect(async () => {
      for await (const _ of client.stream(new QueryFrame(aid))) { /* consume */ }
    }).rejects.toThrow(TypeError);
  });

  it("stream — returns immediately when body is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: null }));
    const client = new NwpClient("http://node.test");
    const frames: StreamFrame[] = [];
    for await (const f of client.stream(new QueryFrame(aid))) frames.push(f);
    expect(frames).toHaveLength(0);
  });

  it("stream — throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    const client = new NwpClient("http://node.test");
    await expect(async () => {
      for await (const _ of client.stream(new QueryFrame(aid))) { /* consume */ }
    }).rejects.toThrow("400");
  });

  it("trailing slash stripped from baseUrl", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const client = new NwpClient("http://node.test/");
    await client.sendAnchor(new AnchorFrame(aid, schema));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://node.test/anchor",
      expect.anything(),
    );
  });
});
