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
  get,
  listNeighbors,
  save,
  type CoreContext,
  type EdgeSuggestionProvider,
} from "../src/core/index.js";
import type { VectorCollection } from "../src/vectors/index.js";
import { createMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

type SeedMemoryRow = {
  id: string;
  title: string;
  content: string;
  workspace?: string;
};

function createTestCoreContext(options: {
  workspace?: string;
  edgeSuggestionProvider?: EdgeSuggestionProvider;
} = {}): {
  ctx: CoreContext;
  handle: DbHandle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zmem-save-core-test-"));
  const dbPath = join(dir, "test.db");
  const handle = openDatabase(dbPath);
  runMigrations(handle);

  const embedProvider = createMockEmbeddingProvider(3);

  const vectorCollection: VectorCollection = {
    insert() {},
    query() {
      return [];
    },
    delete() {},
    close() {},
  };

  const ctx = createCoreContext({
    db: handle,
    embedProvider,
    vectorCollection,
    workspace: options.workspace ?? "ws-save-test",
    config: appConfigSchema.parse({
      defaults: {
        retrieval: {},
      },
    }),
    edgeSuggestionProvider: options.edgeSuggestionProvider,
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
      row.workspace ?? "ws-save-test",
      createHash("sha256").update(row.content).digest("hex"),
      now,
      now
    );
  }
}

function getEdgeRows(handle: DbHandle, fromMemoryId: string): Array<{
  id: string;
  to_memory_id: string;
  relation_type: string;
  origin: string;
  status: string;
  accepted_by: string | null;
}> {
  return handle.db.prepare(`
    SELECT id, to_memory_id, relation_type, origin, status, accepted_by
    FROM memory_edges
    WHERE from_memory_id = ?
    ORDER BY relation_type ASC, to_memory_id ASC, id ASC
  `).all(fromMemoryId) as Array<{
    id: string;
    to_memory_id: string;
    relation_type: string;
    origin: string;
    status: string;
    accepted_by: string | null;
  }>;
}

function countCanonicalEdges(handle: DbHandle, fromMemoryId: string, toMemoryId: string, relationType: string): number {
  const row = handle.db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges
    WHERE from_memory_id = ?
      AND to_memory_id = ?
      AND relation_type = ?
  `).get(fromMemoryId, toMemoryId, relationType) as { count: number };

  return row.count;
}

test("save with explicit links creates accepted manual edges and neighbor retrieval", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [
      { id: "mem_alpha", title: "Alpha", content: "Alpha memory" },
      { id: "mem_beta", title: "Beta", content: "Beta memory" },
    ]);

    const saved = await save(ctx, {
      type: "decision",
      title: "Linked memory",
      content: "This memory explicitly links to earlier context.",
      source: "test",
      scope: "workspace",
      links: [
        { toMemoryId: "mem_alpha", relationType: "supports", confidence: 0.9, justification: "Supports alpha" },
        { toMemoryId: "mem_beta", relationType: "related_to", confidence: 0.7, justification: "Related to beta" },
      ],
    });

    const rows = getEdgeRows(handle, saved.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => ({
        to: row.to_memory_id,
        relationType: row.relation_type,
        origin: row.origin,
        status: row.status,
        acceptedBy: row.accepted_by,
      })),
      [
        {
          to: "mem_beta",
          relationType: "related_to",
          origin: "manual",
          status: "accepted",
          acceptedBy: "agent",
        },
        {
          to: "mem_alpha",
          relationType: "supports",
          origin: "manual",
          status: "accepted",
          acceptedBy: "agent",
        },
      ]
    );

    const neighbors = await listNeighbors(ctx, saved.id, {
      direction: "outbound",
      statuses: ["accepted"],
    });
    assert.deepEqual(neighbors.map((neighbor) => neighbor.memory.id), ["mem_alpha", "mem_beta"]);
  } finally {
    cleanup();
  }
});

test("save suggestion policy respects per-save opt-out", async () => {
  let providerCalls = 0;
  const { ctx, handle, cleanup } = createTestCoreContext({
    edgeSuggestionProvider: {
      async suggestForSave({ memoryId }) {
        providerCalls += 1;
        return [
          {
            fromMemoryId: memoryId,
            toMemoryId: "mem_target",
            relationType: "related_to",
            confidence: 0.61,
            origin: "llm",
            status: "suggested",
            justification: "Deterministic fake suggestion",
          },
        ];
      },
    },
  });

  try {
    seedMemories(handle, [{ id: "mem_target", title: "Target", content: "Target memory" }]);

    const defaultSave = await save(ctx, {
      type: "fact",
      title: "Default suggestion policy",
      content: "This save should allow the fake suggestion provider.",
      source: "test",
      scope: "workspace",
    });

    assert.equal(providerCalls, 1);
    assert.equal(countCanonicalEdges(handle, defaultSave.id, "mem_target", "related_to"), 1);

    const optedOutSave = await save(ctx, {
      type: "fact",
      title: "Opted out of suggestions",
      content: "This save should skip the fake suggestion provider.",
      source: "test",
      scope: "workspace",
      suggestEdges: false,
    });

    assert.equal(providerCalls, 1);
    assert.equal(getEdgeRows(handle, optedOutSave.id).length, 0);
  } finally {
    cleanup();
  }
});

test("save with supersedesId still archives the prior memory correctly", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [{ id: "mem_support", title: "Support", content: "Support memory" }]);

    const original = await save(ctx, {
      type: "decision",
      title: "Original decision",
      content: "Original decision content",
      source: "test",
      scope: "workspace",
    });

    const replacement = await save(ctx, {
      type: "decision",
      title: "Replacement decision",
      content: "Replacement decision content",
      source: "test",
      scope: "workspace",
      supersedesId: original.id,
      links: [{ toMemoryId: "mem_support", relationType: "derived_from", justification: "Derived from support" }],
    });

    const oldItem = await get(ctx, original.id);
    const newItem = await get(ctx, replacement.id);

    assert.equal(oldItem?.status, "archived");
    assert.equal(newItem?.status, "active");
    assert.equal(newItem?.supersedesId, original.id);
    assert.equal(countCanonicalEdges(handle, replacement.id, "mem_support", "derived_from"), 1);
  } finally {
    cleanup();
  }
});

test("save reuses the canonical edge row for duplicate explicit links", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [{ id: "mem_target", title: "Target", content: "Target memory" }]);

    const saved = await save(ctx, {
      type: "fact",
      title: "Duplicate link memory",
      content: "This memory repeats the same explicit link twice.",
      source: "test",
      scope: "workspace",
      links: [
        { toMemoryId: "mem_target", relationType: "related_to", confidence: 0.4, justification: "First mention" },
        { toMemoryId: "mem_target", relationType: "related_to", confidence: 0.9, justification: "Second mention" },
      ],
    });

    assert.equal(countCanonicalEdges(handle, saved.id, "mem_target", "related_to"), 1);
    assert.equal(getEdgeRows(handle, saved.id).length, 1);
  } finally {
    cleanup();
  }
});
