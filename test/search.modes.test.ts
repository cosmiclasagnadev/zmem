import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appConfigSchema } from "../src/config/schema.js";
import { createCoreContext, recall, type CoreContext } from "../src/core/index.js";
import { closeDatabase, openDatabase, persistMemoryEdge, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import type { MemoryType } from "../src/types/memory.js";
import type { VectorCollection, VectorHit } from "../src/vectors/index.js";
import { createMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

const WORKSPACE = "ws-search-modes-test";

type SeedMemory = {
  id: string;
  title: string;
  content: string;
  chunks?: string[];
  type?: MemoryType;
  importance?: number;
  createdAt: string;
  updatedAt?: string;
};

function createTestCoreContext(options?: {
  vectorHits?: VectorHit[];
  throwOnEmbed?: boolean;
  throwOnVectorQuery?: boolean;
}): {
  ctx: CoreContext;
  handle: DbHandle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zmem-search-modes-test-"));
  const dbPath = join(dir, "test.db");
  const handle = openDatabase(dbPath);
  runMigrations(handle);

  const embedProvider = createMockEmbeddingProvider(3);
  if (options?.throwOnEmbed) {
    embedProvider.embed = async () => {
      throw new Error("embed should not run");
    };
  }

  const vectorCollection: VectorCollection = {
    insert() {},
    query() {
      if (options?.throwOnVectorQuery) {
        throw new Error("vector query should not run");
      }
      return options?.vectorHits ?? [];
    },
    delete() {},
    close() {},
  };

  const ctx = createCoreContext({
    db: handle,
    embedProvider,
    vectorCollection,
    workspace: WORKSPACE,
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

function seedMemories(handle: DbHandle, memories: SeedMemory[]): void {
  const insertMemory = handle.db.prepare(`
    INSERT INTO memory_items (
      id, type, title, content, summary, source, scope, workspace,
      tags, importance, status, supersedes_id, content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'test', 'workspace', ?, '[]', ?, 'active', NULL, ?, ?, ?)
  `);
  const insertChunk = handle.db.prepare(`
    INSERT INTO content_chunks (id, memory_id, seq, pos, token_count, chunk_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const memory of memories) {
    insertMemory.run(
      memory.id,
      memory.type ?? "fact",
      memory.title,
      memory.content,
      WORKSPACE,
      memory.importance ?? 0.5,
      createHash("sha256").update(memory.content).digest("hex"),
      memory.createdAt,
      memory.updatedAt ?? memory.createdAt
    );

    let position = 0;
    for (const [index, chunk] of (memory.chunks ?? [memory.content]).entries()) {
      insertChunk.run(
        `${memory.id}_${index}`,
        memory.id,
        index,
        position,
        chunk.split(/\s+/).length,
        chunk,
        memory.createdAt
      );
      position += chunk.length + 1;
    }
  }
}

function seedAcceptedManualEdge(handle: DbHandle, fromMemoryId: string, toMemoryId: string, id: string): void {
  persistMemoryEdge(handle, {
    id,
    fromMemoryId,
    toMemoryId,
    relationType: "related_to",
    confidence: 0.95,
    origin: "manual",
    status: "accepted",
    justification: id,
    acceptedBy: "user",
  });
}

test("recent mode ignores lexical and vector behavior and sorts by recency", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext({
    throwOnEmbed: true,
    throwOnVectorQuery: true,
  });

  try {
    seedMemories(handle, [
      {
        id: "mem_old_exact",
        title: "Old exact lexical hit",
        content: "Contains recentmodeanchor but should still rank last in recent mode.",
        chunks: ["recentmodeanchor exact lexical anchor"],
        createdAt: "2026-03-12T00:00:01.000Z",
      },
      {
        id: "mem_middle",
        title: "Middle item",
        content: "Middle recency item.",
        createdAt: "2026-03-12T00:00:02.000Z",
      },
      {
        id: "mem_newest",
        title: "Newest item",
        content: "Newest recency item.",
        createdAt: "2026-03-12T00:00:03.000Z",
      },
    ]);

    const results = await recall(ctx, "recentmodeanchor", { mode: "recent", topK: 3 });

    assert.deepEqual(results.map((result) => result.id), ["mem_newest", "mem_middle", "mem_old_exact"]);
  } finally {
    cleanup();
  }
});

test("important mode supports queryless and query-constrained ranking", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [
      {
        id: "imp_high",
        title: "Architecture handbook",
        content: "Reference architecture handbook.",
        chunks: ["reference architecture handbook"],
        type: "decision",
        importance: 0.96,
        createdAt: "2026-03-12T00:00:01.000Z",
      },
      {
        id: "imp_connected",
        title: "Architecture bridge note",
        content: "Bridge note for connected architecture context.",
        chunks: ["connected architecture context"],
        importance: 0.7,
        createdAt: "2026-03-12T00:00:02.000Z",
      },
      {
        id: "imp_recent",
        title: "Architecture scratchpad",
        content: "Newest but lower-importance architecture scratchpad.",
        chunks: ["newest lower importance architecture scratchpad"],
        importance: 0.42,
        createdAt: "2026-03-12T00:00:03.000Z",
      },
      {
        id: "imp_neighbor_a",
        title: "Neighbor A",
        content: "Connected supporting context A.",
        importance: 0.2,
        createdAt: "2026-03-12T00:00:04.000Z",
      },
      {
        id: "imp_neighbor_b",
        title: "Neighbor B",
        content: "Connected supporting context B.",
        importance: 0.2,
        createdAt: "2026-03-12T00:00:05.000Z",
      },
      {
        id: "query_high",
        title: "Release checklist canonical",
        content: "Release checklist canonical guidance.",
        chunks: ["release checklist canonical guidance"],
        importance: 0.38,
        createdAt: "2026-03-12T00:00:00.000Z",
      },
      {
        id: "query_low",
        title: "Release checklist scratch",
        content: "Release checklist scratch notes.",
        chunks: ["release checklist scratch notes"],
        importance: 0.12,
        createdAt: "2026-03-11T23:59:59.000Z",
      },
    ]);

    seedAcceptedManualEdge(handle, "imp_connected", "imp_neighbor_a", "edge-connected-a");
    seedAcceptedManualEdge(handle, "imp_connected", "imp_neighbor_b", "edge-connected-b");

    const queryless = await recall(ctx, "", { mode: "important", topK: 3 });
    assert.deepEqual(queryless.map((result) => result.id), ["imp_high", "imp_connected", "imp_recent"]);

    const constrained = await recall(ctx, "release checklist", { mode: "important", topK: 2 });
    assert.deepEqual(constrained.map((result) => result.id).slice(0, 2), ["query_high", "query_low"]);
  } finally {
    cleanup();
  }
});

test("typed mode supports multiple types, default sorting, and optional query", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [
      {
        id: "typed_decision_high",
        title: "Decision policy",
        content: "Decision policy guidance.",
        chunks: ["decision policy guidance"],
        type: "decision",
        importance: 0.91,
        createdAt: "2026-03-12T00:00:01.000Z",
      },
      {
        id: "typed_preference_mid",
        title: "Theme preference",
        content: "Theme preference guidance for the workspace.",
        chunks: ["theme preference guidance"],
        type: "preference",
        importance: 0.83,
        createdAt: "2026-03-12T00:00:02.000Z",
      },
      {
        id: "typed_decision_low",
        title: "Fallback decision",
        content: "Fallback decision context.",
        chunks: ["fallback decision context"],
        type: "decision",
        importance: 0.41,
        createdAt: "2026-03-12T00:00:03.000Z",
      },
      {
        id: "typed_fact_excluded",
        title: "Fact that should be filtered",
        content: "Theme fact that should not appear in typed mode for decision and preference.",
        chunks: ["theme fact excluded"],
        type: "fact",
        importance: 0.99,
        createdAt: "2026-03-12T00:00:04.000Z",
      },
    ]);

    const queryless = await recall(ctx, "", {
      mode: "typed",
      types: ["decision", "preference"],
      topK: 5,
    });
    assert.deepEqual(queryless.map((result) => result.id), [
      "typed_decision_high",
      "typed_preference_mid",
      "typed_decision_low",
    ]);

    const constrained = await recall(ctx, "theme", {
      mode: "typed",
      types: ["decision", "preference"],
      topK: 5,
    });
    assert(constrained.length > 0, "expected typed query to return filtered results");
    assert(constrained.every((result) => result.type === "decision" || result.type === "preference"));
    assert(constrained.some((result) => result.id === "typed_preference_mid"));
  } finally {
    cleanup();
  }
});
