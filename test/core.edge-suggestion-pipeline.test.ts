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
  buildSaveEdgeSuggestionCandidatePool,
  createCoreContext,
  createEdge,
  createSaveEdgeSuggestionProvider,
  listNeighbors,
  save,
  type CoreContext,
  type EdgeSuggestionGenerator,
} from "../src/core/index.js";
import type { VectorCollection, VectorHit } from "../src/vectors/index.js";
import { createMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

type SeedMemoryRow = {
  id: string;
  title: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
};

function createTestCoreContext(options: {
  workspace?: string;
  vectorHits?: VectorHit[];
  edgeSuggestionGenerator?: EdgeSuggestionGenerator;
} = {}): {
  ctx: CoreContext;
  handle: DbHandle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zmem-edge-suggestion-test-"));
  const dbPath = join(dir, "test.db");
  const handle = openDatabase(dbPath);
  runMigrations(handle);

  const embedProvider = createMockEmbeddingProvider(3);

  const vectorCollection: VectorCollection = {
    insert() {},
    query() {
      return options.vectorHits ?? [];
    },
    delete() {},
    close() {},
  };

  const edgeSuggestionProvider = options.edgeSuggestionGenerator
    ? createSaveEdgeSuggestionProvider({
        generator: options.edgeSuggestionGenerator,
        topK: 3,
        semanticCandidateLimit: 6,
        recentCandidateLimit: 6,
      })
    : undefined;

  const ctx = createCoreContext({
    db: handle,
    embedProvider,
    vectorCollection,
    workspace: options.workspace ?? "ws-edge-suggestion-test",
    config: appConfigSchema.parse({
      defaults: {
        retrieval: {},
      },
    }),
    edgeSuggestionProvider,
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

function seedMemories(handle: DbHandle, rows: SeedMemoryRow[], workspace = "ws-edge-suggestion-test"): void {
  const stmt = handle.db.prepare(`
    INSERT INTO memory_items (
      id, type, title, content, summary, source, scope, workspace,
      tags, importance, status, supersedes_id, content_hash, created_at, updated_at
    ) VALUES (?, 'fact', ?, ?, '', 'test', 'workspace', ?, '[]', 0.5, 'active', NULL, ?, ?, ?)
  `);

  for (const row of rows) {
    const createdAt = row.createdAt ?? new Date().toISOString();
    const updatedAt = row.updatedAt ?? createdAt;
    stmt.run(
      row.id,
      row.title,
      row.content,
      workspace,
      createHash("sha256").update(row.content).digest("hex"),
      createdAt,
      updatedAt
    );
  }
}

function getSuggestedRows(handle: DbHandle, fromMemoryId: string): Array<{
  to_memory_id: string;
  relation_type: string;
  origin: string;
  status: string;
}> {
  return handle.db.prepare(`
    SELECT to_memory_id, relation_type, origin, status
    FROM memory_edges
    WHERE from_memory_id = ?
    ORDER BY confidence DESC, to_memory_id ASC
  `).all(fromMemoryId) as Array<{
    to_memory_id: string;
    relation_type: string;
    origin: string;
    status: string;
  }>;
}

test("candidate pool includes both recent and semantic candidates", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext({
    vectorHits: [
      {
        id: "mem_semantic_0",
        distance: 0.05,
        score: 0.91,
        fields: { scope: "workspace", type: "fact" },
      },
    ],
  });

  try {
    seedMemories(handle, [
      { id: "mem_semantic", title: "Semantic memory", content: "Semantic match", createdAt: "2026-03-12T00:00:01.000Z" },
      { id: "mem_recent", title: "Recent memory", content: "Recent match", createdAt: "2026-03-12T00:00:02.000Z" },
      { id: "mem_older", title: "Older memory", content: "Older match", createdAt: "2026-03-12T00:00:00.000Z" },
    ]);

    const pool = await buildSaveEdgeSuggestionCandidatePool(ctx, {
      memoryId: "mem_new",
      workspace: ctx.workspace,
      input: {
        type: "fact",
        title: "New memory",
        content: "This content should retrieve semantic and recent candidates.",
        summary: "",
        source: "test",
        scope: "workspace",
        tags: [],
        importance: 0.5,
        links: [],
        suggestEdges: true,
      },
    }, {
      semanticCandidateLimit: 2,
      recentCandidateLimit: 2,
    });

    assert.deepEqual(pool.semanticCandidates.map((candidate) => candidate.memoryId), ["mem_semantic"]);
    assert.deepEqual(pool.recentCandidates.map((candidate) => candidate.memoryId), ["mem_recent", "mem_semantic"]);
    assert(pool.allCandidates.some((candidate) => candidate.memoryId === "mem_semantic" && candidate.sources.includes("semantic")));
    assert(pool.allCandidates.some((candidate) => candidate.memoryId === "mem_recent" && candidate.sources.includes("recent")));
  } finally {
    cleanup();
  }
});

test("candidate pool preserves zero semantic scores when merging candidates", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext({
    vectorHits: [
      {
        id: "mem_zero_semantic_0",
        distance: 1,
        score: 0,
        fields: { scope: "workspace", type: "fact" },
      },
    ],
  });

  try {
    seedMemories(handle, [
      { id: "mem_zero_semantic", title: "Zero semantic", content: "Still a valid candidate", createdAt: "2026-03-12T00:00:02.000Z" },
      { id: "mem_recent_only", title: "Recent only", content: "Recent candidate", createdAt: "2026-03-12T00:00:03.000Z" },
    ]);

    const pool = await buildSaveEdgeSuggestionCandidatePool(ctx, {
      memoryId: "mem_new",
      workspace: ctx.workspace,
      input: {
        type: "fact",
        title: "New memory",
        content: "This should merge semantic and recent candidates without erasing zero scores.",
        summary: "",
        source: "test",
        scope: "workspace",
        tags: [],
        importance: 0.5,
        links: [],
        suggestEdges: true,
      },
    }, {
      semanticCandidateLimit: 2,
      recentCandidateLimit: 2,
    });

    const merged = pool.allCandidates.find((candidate) => candidate.memoryId === "mem_zero_semantic");
    assert(merged, "Expected merged candidate to exist");
    assert.equal(merged?.semanticScore, 0);
    assert(merged?.sources.includes("semantic"));
    assert(merged?.sources.includes("recent"));
  } finally {
    cleanup();
  }
});

test("only the top few suggestions are persisted", async () => {
  const generator: EdgeSuggestionGenerator = {
    async suggest({ candidatePool }) {
      return candidatePool.allCandidates.map((candidate, index) => ({
        toMemoryId: candidate.memoryId,
        relationType: "related_to",
        confidence: 0.95 - index * 0.1,
        evidenceScore: 10 - index,
        justification: `Candidate ${candidate.memoryId}`,
      }));
    },
  };
  const { ctx, handle, cleanup } = createTestCoreContext({ edgeSuggestionGenerator: generator });

  try {
    seedMemories(handle, [
      { id: "mem_target_a", title: "Target A", content: "Target A", createdAt: "2026-03-12T00:00:01.000Z" },
      { id: "mem_target_b", title: "Target B", content: "Target B", createdAt: "2026-03-12T00:00:02.000Z" },
      { id: "mem_target_c", title: "Target C", content: "Target C", createdAt: "2026-03-12T00:00:03.000Z" },
      { id: "mem_target_d", title: "Target D", content: "Target D", createdAt: "2026-03-12T00:00:04.000Z" },
    ]);

    const saved = await save(ctx, {
      type: "decision",
      title: "Suggestion source",
      content: "Suggestion source content",
      source: "test",
      scope: "workspace",
    });

    const rows = getSuggestedRows(handle, saved.id);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.to_memory_id), ["mem_target_d", "mem_target_c", "mem_target_b"]);
  } finally {
    cleanup();
  }
});

test("suggested edges are stored with origin=llm and status=suggested", async () => {
  const generator: EdgeSuggestionGenerator = {
    async suggest({ candidatePool }) {
      return candidatePool.allCandidates.slice(0, 1).map((candidate) => ({
        toMemoryId: candidate.memoryId,
        relationType: "supports",
        confidence: 0.84,
        justification: "Deterministic generated suggestion",
      }));
    },
  };
  const { ctx, handle, cleanup } = createTestCoreContext({ edgeSuggestionGenerator: generator });

  try {
    seedMemories(handle, [{ id: "mem_target", title: "Target", content: "Target", createdAt: "2026-03-12T00:00:01.000Z" }]);

    const saved = await save(ctx, {
      type: "fact",
      title: "Suggestion source",
      content: "Suggestion source content",
      source: "test",
      scope: "workspace",
    });

    const neighbors = await listNeighbors(ctx, saved.id, {
      direction: "outbound",
      origins: ["llm"],
      statuses: ["suggested"],
    });
    assert.equal(neighbors.length, 1);
    assert.equal(neighbors[0]?.memory.id, "mem_target");
    assert.equal(neighbors[0]?.edge.origin, "llm");
    assert.equal(neighbors[0]?.edge.status, "suggested");
  } finally {
    cleanup();
  }
});

test("previously rejected edges are not re-suggested under unchanged evidence", async () => {
  const generator: EdgeSuggestionGenerator = {
    async suggest() {
      return [
        {
          toMemoryId: "mem_target",
          relationType: "related_to",
          confidence: 0.7,
          justification: "Unchanged evidence",
        },
      ];
    },
  };
  const { ctx, handle, cleanup } = createTestCoreContext({ edgeSuggestionGenerator: generator });

  try {
    seedMemories(handle, [
      { id: "mem_source", title: "Source", content: "Source", createdAt: "2026-03-12T00:00:02.000Z" },
      { id: "mem_target", title: "Target", content: "Target", createdAt: "2026-03-12T00:00:01.000Z" },
    ]);
    await createEdge(ctx, {
      fromMemoryId: "mem_source",
      toMemoryId: "mem_target",
      relationType: "related_to",
      confidence: 0.7,
      origin: "llm",
      status: "suggested",
      justification: "Initial suggestion",
    });
    handle.db.prepare(`
      UPDATE memory_edges
      SET status = 'rejected', accepted_by = NULL
      WHERE from_memory_id = ? AND to_memory_id = ? AND relation_type = ?
    `).run("mem_source", "mem_target", "related_to");

    const suggestions = await ctx.edgeSuggestionProvider?.suggestForSave({
      ctx,
      memoryId: "mem_source",
      workspace: ctx.workspace,
      input: {
        type: "fact",
        title: "Source",
        content: "Source",
        summary: "",
        source: "test",
        scope: "workspace",
        tags: [],
        importance: 0.5,
        links: [],
        suggestEdges: true,
      },
    });

    assert.deepEqual(suggestions, []);
  } finally {
    cleanup();
  }
});
