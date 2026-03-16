import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appConfigSchema } from "../src/config/schema.js";
import {
  closeDatabase,
  openDatabase,
  type DbHandle,
} from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  createCoreContext,
  createEdge,
  listNeighbors,
  updateEdge,
  updateEdgeStatus,
  type CoreContext,
} from "../src/core/index.js";
import type { VectorCollection } from "../src/vectors/index.js";
import { createMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

type SeedMemoryRow = {
  id: string;
  title: string;
  content: string;
  workspace?: string;
};

function createTestCoreContext(workspace = "ws-edge-test"): {
  ctx: CoreContext;
  handle: DbHandle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zmem-edge-core-test-"));
  const dbPath = join(dir, "test.db");
  const handle = openDatabase(dbPath);
  runMigrations(handle);

  const embedProvider = createMockEmbeddingProvider(3);

  const vectorCollection: VectorCollection = {
    insert() { },
    query() {
      return [];
    },
    delete() { },
    close() { },
  };

  const ctx = createCoreContext({
    db: handle,
    embedProvider,
    vectorCollection,
    workspace,
    config: appConfigSchema.parse({
      defaults: {
        retrieval: {},
      },
    }),
  });

  return {
    ctx,
    handle,
    cleanup: () => {
      closeDatabase(handle);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedMemories(handle: DbHandle, rows: SeedMemoryRow[]): void {
  const now = new Date().toISOString();
  const stmt = handle.db.prepare(`
    INSERT INTO memory_items (
      id, type, title, content, summary, source, scope, workspace,
      tags, importance, status, supersedes_id, content_hash, created_at, updated_at
    ) VALUES (?, 'fact', ?, ?, '', 'test', 'workspace', ?, '[]', 0.5, 'active', NULL, ?, ?, ?)
  `);

  for (const row of rows) {
    stmt.run(
      row.id,
      row.title,
      row.content,
      row.workspace ?? "ws-edge-test",
      createHash("sha256").update(row.content).digest("hex"),
      now,
      now
    );
  }
}

test("createEdge stores accepted edge values", async () => {
  const { ctx, cleanup } = createTestCoreContext();

  try {
    seedMemories(ctx.db, [
      { id: "mem_a", title: "Memory A", content: "A" },
      { id: "mem_b", title: "Memory B", content: "B" },
    ]);

    const edge = await createEdge(ctx, {
      id: "edge_manual_accept",
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "related_to",
      confidence: 0.82,
      origin: "manual",
      status: "accepted",
      justification: "Same initiative",
      acceptedBy: "user",
    });

    assert.equal(edge.id, "edge_manual_accept");
    assert.equal(edge.fromMemoryId, "mem_a");
    assert.equal(edge.toMemoryId, "mem_b");
    assert.equal(edge.relationType, "related_to");
    assert.equal(edge.confidence, 0.82);
    assert.equal(edge.origin, "manual");
    assert.equal(edge.status, "accepted");
    assert.equal(edge.justification, "Same initiative");
    assert.equal(edge.acceptedBy, "user");
  } finally {
    cleanup();
  }
});

test("updateEdgeStatus changes edge status and acceptance provenance", async () => {
  const { ctx, cleanup } = createTestCoreContext();

  try {
    seedMemories(ctx.db, [
      { id: "mem_a", title: "Memory A", content: "A" },
      { id: "mem_b", title: "Memory B", content: "B" },
    ]);

    const created = await createEdge(ctx, {
      id: "edge_llm_suggested",
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "supports",
      confidence: 0.58,
      origin: "llm",
      status: "suggested",
      justification: "Possible support",
    });

    assert.equal(created.status, "suggested");
    assert.equal(created.acceptedBy, null);

    const accepted = await updateEdgeStatus(ctx, {
      id: created.id,
      status: "accepted",
      acceptedBy: "agent",
      justification: "Validated during moderation",
    });

    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.acceptedBy, "agent");
    assert.equal(accepted.justification, "Validated during moderation");

    const rejected = await updateEdgeStatus(ctx, {
      id: created.id,
      status: "rejected",
      justification: "Dismissed after review",
    });

    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.acceptedBy, null);
    assert.equal(rejected.justification, "Dismissed after review");
  } finally {
    cleanup();
  }
});

test("listNeighbors honors direction, filters, and default depth of 1", async () => {
  const { ctx, cleanup } = createTestCoreContext();

  try {
    seedMemories(ctx.db, [
      { id: "mem_a", title: "Memory A", content: "A" },
      { id: "mem_b", title: "Memory B", content: "B" },
      { id: "mem_c", title: "Memory C", content: "C" },
      { id: "mem_d", title: "Memory D", content: "D" },
      { id: "mem_e", title: "Memory E", content: "E" },
    ]);

    await createEdge(ctx, {
      id: "edge_accepted_outbound",
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "related_to",
      confidence: 0.9,
      origin: "manual",
      status: "accepted",
      justification: "Accepted edge",
      acceptedBy: "user",
    });
    await createEdge(ctx, {
      id: "edge_suggested_outbound",
      fromMemoryId: "mem_a",
      toMemoryId: "mem_c",
      relationType: "supports",
      confidence: 0.55,
      origin: "llm",
      status: "suggested",
      justification: "Suggested edge",
    });
    await createEdge(ctx, {
      id: "edge_rejected_inbound",
      fromMemoryId: "mem_d",
      toMemoryId: "mem_a",
      relationType: "contradicts",
      confidence: 0.22,
      origin: "llm",
      status: "suggested",
      justification: "Needs review",
    });
    await updateEdgeStatus(ctx, {
      id: "edge_rejected_inbound",
      status: "rejected",
      justification: "Rejected edge",
    });
    await createEdge(ctx, {
      id: "edge_depth_two",
      fromMemoryId: "mem_b",
      toMemoryId: "mem_e",
      relationType: "derived_from",
      confidence: 0.77,
      origin: "manual",
      status: "accepted",
      justification: "Depth two edge",
      acceptedBy: "system",
    });

    const allNeighbors = await listNeighbors(ctx, "mem_a");
    assert.deepEqual(
      allNeighbors.map((neighbor) => ({
        id: neighbor.memory.id,
        direction: neighbor.direction,
        status: neighbor.edge.status,
        depth: neighbor.depth,
      })),
      [
        { id: "mem_b", direction: "outbound", status: "accepted", depth: 1 },
        { id: "mem_c", direction: "outbound", status: "suggested", depth: 1 },
        { id: "mem_d", direction: "inbound", status: "rejected", depth: 1 },
      ]
    );

    const outboundAccepted = await listNeighbors(ctx, "mem_a", {
      direction: "outbound",
      statuses: ["accepted"],
    });
    assert.deepEqual(outboundAccepted.map((neighbor) => neighbor.memory.id), ["mem_b"]);

    const inboundRejected = await listNeighbors(ctx, "mem_a", {
      direction: "inbound",
      statuses: ["rejected"],
    });
    assert.deepEqual(inboundRejected.map((neighbor) => neighbor.memory.id), ["mem_d"]);

    const depthTwo = await listNeighbors(ctx, "mem_a", {
      direction: "outbound",
      depth: 2,
      statuses: ["accepted"],
    });
    assert.deepEqual(
      depthTwo.map((neighbor) => ({ id: neighbor.memory.id, depth: neighbor.depth })),
      [
        { id: "mem_b", depth: 1 },
        { id: "mem_e", depth: 2 },
      ]
    );
  } finally {
    cleanup();
  }
});

test("related_to edges reuse the existing reverse-direction row", async () => {
  const { ctx, cleanup } = createTestCoreContext();

  try {
    seedMemories(ctx.db, [
      { id: "mem_z", title: "Memory Z", content: "Z" },
      { id: "mem_a", title: "Memory A", content: "A" },
    ]);

    const first = await createEdge(ctx, {
      fromMemoryId: "mem_z",
      toMemoryId: "mem_a",
      relationType: "related_to",
      confidence: 0.7,
      origin: "manual",
      status: "accepted",
      justification: "Symmetric relation",
      acceptedBy: "user",
    });

    const second = await createEdge(ctx, {
      fromMemoryId: "mem_a",
      toMemoryId: "mem_z",
      relationType: "related_to",
      confidence: 0.7,
      origin: "manual",
      status: "accepted",
      justification: "Reverse creation should reuse",
      acceptedBy: "user",
    });

    assert.equal(first.id, second.id);
    assert.equal(second.fromMemoryId, "mem_z");
    assert.equal(second.toMemoryId, "mem_a");
  } finally {
    cleanup();
  }
});

test("updateEdge cannot rewrite edge origin provenance", async () => {
  const { ctx, cleanup } = createTestCoreContext();

  try {
    seedMemories(ctx.db, [
      { id: "mem_a", title: "Memory A", content: "A" },
      { id: "mem_b", title: "Memory B", content: "B" },
    ]);

    const created = await createEdge(ctx, {
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "supports",
      confidence: 0.6,
      origin: "llm",
      status: "suggested",
      justification: "LLM suggestion",
    });

    const updated = await updateEdge(ctx, {
      id: created.id,
      confidence: 0.9,
      justification: "Human reviewed confidence",
    });

    assert.equal(updated.origin, "llm");
    assert.equal(updated.confidence, 0.9);
  } finally {
    cleanup();
  }
});
