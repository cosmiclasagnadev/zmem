import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appConfigSchema } from "../src/config/schema.js";
import { createCoreContext, recall, type CoreContext } from "../src/core/index.js";
import { openDatabase, closeDatabase, persistMemoryEdge, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import type { VectorCollection } from "../src/vectors/index.js";
import { createMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

type SeedMemory = {
  id: string;
  title: string;
  content: string;
  chunks: string[];
};

function createTestCoreContext(): {
  ctx: CoreContext;
  handle: DbHandle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zmem-search-graph-test-"));
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
    workspace: "ws-search-graph-test",
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
  const now = new Date().toISOString();
  const insertMemory = handle.db.prepare(`
    INSERT INTO memory_items (
      id, type, title, content, summary, source, scope, workspace,
      tags, importance, status, supersedes_id, content_hash, created_at, updated_at
    ) VALUES (?, 'fact', ?, ?, '', 'test', 'workspace', 'ws-search-graph-test', '[]', 0.5, 'active', NULL, ?, ?, ?)
  `);
  const insertChunk = handle.db.prepare(`
    INSERT INTO content_chunks (id, memory_id, seq, pos, token_count, chunk_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const memory of memories) {
    insertMemory.run(
      memory.id,
      memory.title,
      memory.content,
      createHash("sha256").update(memory.content).digest("hex"),
      now,
      now
    );

    let position = 0;
    memory.chunks.forEach((chunk, index) => {
      insertChunk.run(`${memory.id}_${index}`, memory.id, index, position, chunk.split(/\s+/).length, chunk, now);
      position += chunk.length + 1;
    });
  }
}

function seedEdge(handle: DbHandle, input: {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  status: "suggested" | "accepted" | "rejected";
  origin: "manual" | "llm";
}): void {
  persistMemoryEdge(handle, {
    id: input.id,
    fromMemoryId: input.fromMemoryId,
    toMemoryId: input.toMemoryId,
    relationType: "related_to",
    confidence: 0.92,
    origin: input.origin,
    status: input.status,
    justification: `test edge ${input.id}`,
    acceptedBy: input.status === "accepted" ? "user" : null,
  });
}

test("relational recall can inject accepted manual neighbors", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [
      {
        id: "mem_change_seed",
        title: "Release change summary",
        content: "This memory explains what changed in the release and anchors the search.",
        chunks: ["what changed in the release after rollout and migration"],
      },
      {
        id: "mem_change_neighbor",
        title: "Baseline before release",
        content: "Baseline comparison notes and prior behavior before the rollout.",
        chunks: ["baseline comparison notes before rollout"],
      },
    ]);

    seedEdge(handle, {
      id: "edge-accepted-manual",
      fromMemoryId: "mem_change_seed",
      toMemoryId: "mem_change_neighbor",
      status: "accepted",
      origin: "manual",
    });

    const hits = await recall(ctx, "what changed", { mode: "lexical", topK: 5 });

    assert.deepEqual(hits.map((hit) => hit.id), ["mem_change_seed", "mem_change_neighbor"]);
    assert.match(hits[1]?.snippet ?? "", /baseline comparison/i);
  } finally {
    cleanup();
  }
});

test("suggested-only neighbors do not get injected in v1", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [
      {
        id: "mem_decision_seed",
        title: "Decision summary",
        content: "This note covers why did we choose this architecture.",
        chunks: ["why did we choose this architecture for the service"],
      },
      {
        id: "mem_decision_neighbor",
        title: "Suggested supporting note",
        content: "Supporting rationale that should stay hidden until accepted.",
        chunks: ["supporting rationale hidden until accepted"],
      },
    ]);

    seedEdge(handle, {
      id: "edge-suggested-llm",
      fromMemoryId: "mem_decision_seed",
      toMemoryId: "mem_decision_neighbor",
      status: "suggested",
      origin: "llm",
    });

    const hits = await recall(ctx, "why did we choose this", { mode: "lexical", topK: 5 });

    assert.deepEqual(hits.map((hit) => hit.id), ["mem_decision_seed"]);
  } finally {
    cleanup();
  }
});

test("rejected neighbors never get injected", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [
      {
        id: "mem_related_seed",
        title: "Context anchor",
        content: "This note is the anchor for related context queries.",
        chunks: ["related context for the main project thread"],
      },
      {
        id: "mem_rejected_neighbor",
        title: "Rejected context",
        content: "This linked note was explicitly rejected and should not surface.",
        chunks: ["rejected context note"],
      },
    ]);

    seedEdge(handle, {
      id: "edge-rejected-manual",
      fromMemoryId: "mem_related_seed",
      toMemoryId: "mem_rejected_neighbor",
      status: "rejected",
      origin: "manual",
    });

    const hits = await recall(ctx, "related context", { mode: "lexical", topK: 5 });

    assert.deepEqual(hits.map((hit) => hit.id), ["mem_related_seed"]);
  } finally {
    cleanup();
  }
});

test("graph expansion stays at depth 1 by default", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemories(handle, [
      {
        id: "mem_history_seed",
        title: "History anchor",
        content: "This memory captures what changed across the recent rollout.",
        chunks: ["what changed during the recent rollout"],
      },
      {
        id: "mem_history_neighbor",
        title: "Immediate neighbor",
        content: "Immediate prior context for the rollout.",
        chunks: ["immediate prior context"],
      },
      {
        id: "mem_history_far",
        title: "Second hop detail",
        content: "Older detail that should require a second graph hop.",
        chunks: ["second hop detail"],
      },
    ]);

    seedEdge(handle, {
      id: "edge-depth-one",
      fromMemoryId: "mem_history_seed",
      toMemoryId: "mem_history_neighbor",
      status: "accepted",
      origin: "manual",
    });
    seedEdge(handle, {
      id: "edge-depth-two",
      fromMemoryId: "mem_history_neighbor",
      toMemoryId: "mem_history_far",
      status: "accepted",
      origin: "manual",
    });

    const hits = await recall(ctx, "what changed", { mode: "lexical", topK: 10 });

    assert(hits.some((hit) => hit.id === "mem_history_neighbor"), "expected first-hop neighbor to be injected");
    assert(!hits.some((hit) => hit.id === "mem_history_far"), "second-hop neighbor should not be injected by default");
  } finally {
    cleanup();
  }
});
