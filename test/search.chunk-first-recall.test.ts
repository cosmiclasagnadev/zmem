import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appConfigSchema } from "../src/config/schema.js";
import { createCoreContext, recall, type CoreContext } from "../src/core/index.js";
import { closeDatabase, openDatabase, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import type { VectorCollection, VectorHit } from "../src/vectors/index.js";
import { createMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

type SeedMemory = {
  id: string;
  title: string;
  content: string;
  chunks: string[];
};

function createTestCoreContext(vectorHits: VectorHit[]): {
  ctx: CoreContext;
  handle: DbHandle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zmem-search-chunk-test-"));
  const dbPath = join(dir, "test.db");
  const handle = openDatabase(dbPath);
  runMigrations(handle);

  const embedProvider = createMockEmbeddingProvider(3);

  const vectorCollection: VectorCollection = {
    insert() {},
    query() {
      return vectorHits;
    },
    delete() {},
    close() {},
  };

  const ctx = createCoreContext({
    db: handle,
    embedProvider,
    vectorCollection,
    workspace: "ws-search-test",
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
    ) VALUES (?, 'fact', ?, ?, '', 'test', 'workspace', 'ws-search-test', '[]', 0.5, 'active', NULL, ?, ?, ?)
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

test("recall rolls multiple chunk hits into one memory and uses the best chunk snippet", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext([
    {
      id: "mem_alpha_0",
      distance: 0.3,
      score: 0.7,
      fields: { scope: "workspace", type: "fact" },
    },
    {
      id: "mem_alpha_1",
      distance: 0.08,
      score: 0.92,
      fields: { scope: "workspace", type: "fact" },
    },
    {
      id: "mem_beta_0",
      distance: 0.2,
      score: 0.81,
      fields: { scope: "workspace", type: "fact" },
    },
  ]);

  try {
    seedMemories(handle, [
      {
        id: "mem_alpha",
        title: "Alpha memory",
        content: "Alpha document with repeated sections.",
        chunks: [
          "alpha context chunk with broad background",
          "alpha decisive evidence chunk with story5proof marker and unique supporting detail",
        ],
      },
      {
        id: "mem_beta",
        title: "Beta memory",
        content: "Beta document",
        chunks: ["beta competing chunk with story5proof marker but lower relevance"],
      },
    ]);

    const hits = await recall(ctx, "story5proof", { mode: "vector", topK: 10 });

    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((hit) => hit.id), ["mem_alpha", "mem_beta"]);
    assert.match(hits[0]?.snippet ?? "", /decisive evidence chunk/i);
    assert.equal("chunkId" in (hits[0] as unknown as Record<string, unknown>), false);
    assert.equal("memoryId" in (hits[0] as unknown as Record<string, unknown>), false);
  } finally {
    cleanup();
  }
});

test("lexical recall stays memory-only for multi-chunk documents", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext([]);

  try {
    seedMemories(handle, [
      {
        id: "mem_doc",
        title: "Chunked lexical doc",
        content: "Chunked lexical document",
        chunks: [
          "introductory chunk without the anchor",
          "second chunk carries story5lexicalanchor and the snippet evidence we expect",
          "closing chunk also without the anchor",
        ],
      },
    ]);

    const hits = await recall(ctx, "story5lexicalanchor", { mode: "lexical", topK: 10 });

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "mem_doc");
    assert.match(hits[0]?.snippet ?? "", /story5lexicalanchor/i);
    assert.equal("id" in (hits[0] as unknown as Record<string, unknown>), true);
    assert.equal("memoryId" in (hits[0] as unknown as Record<string, unknown>), false);
  } finally {
    cleanup();
  }
});
