import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeDatabase,
  openDatabase,
  persistMemoryEdge,
  type DbHandle,
} from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";

type SeedMemoryRow = {
  id: string;
  title: string;
  content: string;
  workspace?: string;
};

function createTestDb(): { handle: DbHandle; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zmem-graph-schema-test-"));
  const dbPath = join(dir, "test.db");
  const handle = openDatabase(dbPath);
  runMigrations(handle);

  return {
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
      row.workspace ?? "ws-graph-test",
      createHash("sha256").update(row.content).digest("hex"),
      now,
      now
    );
  }
}

function countCanonicalEdges(handle: DbHandle, args: {
  fromMemoryId: string;
  toMemoryId: string;
  relationType: string;
}): number {
  const row = handle.db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges
    WHERE from_memory_id = ?
      AND to_memory_id = ?
      AND relation_type = ?
  `).get(args.fromMemoryId, args.toMemoryId, args.relationType) as { count: number };

  return row.count;
}

test("memory_edges persists canonical graph edges", () => {
  const { handle, cleanup } = createTestDb();

  try {
    seedMemories(handle, [
      { id: "mem_a", title: "Memory A", content: "A" },
      { id: "mem_b", title: "Memory B", content: "B" },
    ]);

    persistMemoryEdge(handle, {
      id: randomUUID(),
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "related_to",
      confidence: 0.82,
      origin: "manual",
      status: "accepted",
      justification: "Same initiative",
      acceptedBy: "user",
    });

    const edge = handle.db.prepare(`
      SELECT relation_type, confidence, origin, status, justification, accepted_by
      FROM memory_edges
      WHERE from_memory_id = 'mem_a' AND to_memory_id = 'mem_b'
    `).get() as {
      relation_type: string;
      confidence: number;
      origin: string;
      status: string;
      justification: string;
      accepted_by: string | null;
    };

    assert.equal(edge.relation_type, "related_to");
    assert.equal(edge.confidence, 0.82);
    assert.equal(edge.origin, "manual");
    assert.equal(edge.status, "accepted");
    assert.equal(edge.justification, "Same initiative");
    assert.equal(edge.accepted_by, "user");
  } finally {
    cleanup();
  }
});

test("memory_edges keeps one canonical row for duplicate inserts", () => {
  const { handle, cleanup } = createTestDb();

  try {
    seedMemories(handle, [
      { id: "mem_a", title: "Memory A", content: "A" },
      { id: "mem_b", title: "Memory B", content: "B" },
    ]);

    persistMemoryEdge(handle, {
      id: randomUUID(),
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "supports",
      confidence: 0.61,
      origin: "manual",
      status: "accepted",
      justification: "First insert",
      acceptedBy: "user",
    });

    persistMemoryEdge(handle, {
      id: randomUUID(),
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "supports",
      confidence: 0.99,
      origin: "llm",
      status: "suggested",
      justification: "Duplicate insert",
      acceptedBy: null,
    });

    assert.equal(
      countCanonicalEdges(handle, {
        fromMemoryId: "mem_a",
        toMemoryId: "mem_b",
        relationType: "supports",
      }),
      1
    );
  } finally {
    cleanup();
  }
});

test("memory_edges keeps rejected edges queryable for admin paths", () => {
  const { handle, cleanup } = createTestDb();

  try {
    seedMemories(handle, [
      { id: "mem_a", title: "Memory A", content: "A" },
      { id: "mem_b", title: "Memory B", content: "B" },
    ]);

    persistMemoryEdge(handle, {
      id: randomUUID(),
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "contradicts",
      confidence: 0.33,
      origin: "llm",
      status: "rejected",
      justification: "Rejected after review",
      acceptedBy: null,
    });

    const rows = handle.db.prepare(`
      SELECT id, status, origin, justification
      FROM memory_edges
      WHERE status = 'rejected'
    `).all() as Array<{
      id: string;
      status: string;
      origin: string;
      justification: string;
    }>;

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "rejected");
    assert.equal(rows[0]?.origin, "llm");
    assert.equal(rows[0]?.justification, "Rejected after review");
  } finally {
    cleanup();
  }
});

test("memory_edges allows multiple relation types for same memory pair", () => {
  const { handle, cleanup } = createTestDb();

  try {
    seedMemories(handle, [
      { id: "mem_a", title: "Memory A", content: "A" },
      { id: "mem_b", title: "Memory B", content: "B" },
    ]);

    persistMemoryEdge(handle, {
      id: randomUUID(),
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "related_to",
      confidence: 0.7,
      origin: "manual",
      status: "accepted",
      justification: "General relation",
      acceptedBy: "user",
    });

    persistMemoryEdge(handle, {
      id: randomUUID(),
      fromMemoryId: "mem_a",
      toMemoryId: "mem_b",
      relationType: "derived_from",
      confidence: 0.9,
      origin: "manual",
      status: "accepted",
      justification: "Derived work",
      acceptedBy: "agent",
    });

    const rows = handle.db.prepare(`
      SELECT relation_type
      FROM memory_edges
      WHERE from_memory_id = 'mem_a' AND to_memory_id = 'mem_b'
      ORDER BY relation_type
    `).all() as Array<{ relation_type: string }>;

    assert.deepEqual(rows.map((row) => row.relation_type), ["derived_from", "related_to"]);
  } finally {
    cleanup();
  }
});
