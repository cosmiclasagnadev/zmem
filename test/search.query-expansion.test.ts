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
import { expandQuery } from "../src/search/query-expansion.js";
import type { VectorCollection } from "../src/vectors/index.js";
import { createMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

function createTestCoreContext(): {
  ctx: CoreContext;
  handle: DbHandle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zmem-search-expansion-test-"));
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
    workspace: "ws-search-expansion-test",
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

function seedMemory(handle: DbHandle, input: { id: string; title: string; content: string; chunk: string }): void {
  const now = new Date().toISOString();
  handle.db.prepare(`
    INSERT INTO memory_items (
      id, type, title, content, summary, source, scope, workspace,
      tags, importance, status, supersedes_id, content_hash, created_at, updated_at
    ) VALUES (?, 'fact', ?, ?, '', 'test', 'workspace', 'ws-search-expansion-test', '[]', 0.5, 'active', NULL, ?, ?, ?)
  `).run(
    input.id,
    input.title,
    input.content,
    createHash("sha256").update(input.content).digest("hex"),
    now,
    now
  );

  handle.db.prepare(`
    INSERT INTO content_chunks (id, memory_id, seq, pos, token_count, chunk_text, created_at)
    VALUES (?, ?, 0, 0, ?, ?, ?)
  `).run(`${input.id}_0`, input.id, input.chunk.split(/\s+/).length, input.chunk, now);
}

test("deterministic expansion outputs stay bounded and labeled by strategy", async () => {
  const plan = await expandQuery("why did we choose this", "deterministic");

  assert(plan.variants.length <= 4);
  assert.deepEqual(plan.variants.map((variant) => variant.strategy), ["original", "lexical", "semantic", "semantic"]);
  assert.deepEqual(plan.variants.map((variant) => variant.label), [
    "original:raw",
    "lexical:compact-keywords",
    "semantic:decision-rationale",
    "semantic:tradeoff-analysis",
  ]);
});

test("disabling expansion returns the original lexical behavior", async () => {
  const { ctx, handle, cleanup } = createTestCoreContext();

  try {
    seedMemory(handle, {
      id: "mem_expansion_only",
      title: "Decision rationale",
      content: "Decision rationale and tradeoff analysis for the selected approach.",
      chunk: "decision rationale tradeoff analysis selected approach",
    });

    const disabledHits = await recall(ctx, "why did we choose this", {
      mode: "lexical",
      topK: 5,
      expansionMode: "off",
    });
    assert.deepEqual(disabledHits, []);

    const expandedHits = await recall(ctx, "why did we choose this", {
      mode: "lexical",
      topK: 5,
      expansionMode: "deterministic",
    });
    assert.deepEqual(expandedHits.map((hit) => hit.id), ["mem_expansion_only"]);
  } finally {
    cleanup();
  }
});

test("off mode keeps only the original variant", async () => {
  const plan = await expandQuery("related context", "off");
  assert.deepEqual(plan.variants, [
    {
      query: "related context",
      strategy: "original",
      label: "original:raw",
      weight: 1,
    },
  ]);
});
