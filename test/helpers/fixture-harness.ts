import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appConfigSchema } from "../../src/config/schema.js";
import { createCoreContext, type CoreContext } from "../../src/core/index.js";
import { closeDatabase, openDatabase, persistMemoryEdge, type DbHandle } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { EmbeddingProvider } from "../../src/embed/types.js";
import type { MemoryScope, MemoryType } from "../../src/types/memory.js";
import type { VectorCollection, VectorHit } from "../../src/vectors/index.js";

export type FixtureMemory = {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  chunks?: string[];
  createdAt: string;
  updatedAt?: string;
  importance?: number;
  summary?: string;
  source?: string;
  scope?: MemoryScope;
  tags?: string[];
  status?: "active" | "archived" | "deleted";
  supersedesId?: string | null;
};

export type FixtureEdge = {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: "related_to" | "supports" | "contradicts" | "caused_by" | "derived_from" | "preferred_with";
  confidence: number;
  origin: "manual" | "llm";
  status: "suggested" | "accepted" | "rejected";
  justification: string;
  acceptedBy: "user" | "agent" | "system" | null;
};

export function createFixtureTestCoreContext(options?: {
  workspace?: string;
  vectorHits?: VectorHit[];
  throwOnEmbed?: boolean;
  throwOnVectorQuery?: boolean;
}): {
  ctx: CoreContext;
  handle: DbHandle;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "zmem-fixture-harness-"));
  const dbPath = join(dir, "test.db");
  const handle = openDatabase(dbPath);
  runMigrations(handle);

  const embedProvider: EmbeddingProvider = {
    dimensions: 3,
    model: "test-embed",
    async initialize() {},
    async embed() {
      if (options?.throwOnEmbed) {
        throw new Error("embed should not run");
      }
      return [0, 0, 0];
    },
    async embedBatch(texts) {
      return texts.map((text) => ({ id: text.id, embedding: [0, 0, 0], dimensions: 3 }));
    },
    async healthCheck() {
      return true;
    },
    async dispose() {},
  };

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
    workspace: options?.workspace ?? "ws-fixture-harness",
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

export function seedFixtureWorkspace(
  handle: DbHandle,
  workspace: string,
  memories: FixtureMemory[],
  edges: FixtureEdge[] = []
): void {
  const insertMemory = handle.db.prepare(`
    INSERT INTO memory_items (
      id, type, title, content, summary, source, scope, workspace,
      tags, importance, status, supersedes_id, content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunk = handle.db.prepare(`
    INSERT INTO content_chunks (id, memory_id, seq, pos, token_count, chunk_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const memory of memories) {
    const createdAt = memory.createdAt;
    const updatedAt = memory.updatedAt ?? createdAt;
    const chunks = memory.chunks && memory.chunks.length > 0 ? memory.chunks : [memory.content];
    insertMemory.run(
      memory.id,
      memory.type,
      memory.title,
      memory.content,
      memory.summary ?? "",
      memory.source ?? "fixture",
      memory.scope ?? "workspace",
      workspace,
      JSON.stringify(memory.tags ?? []),
      memory.importance ?? 0.5,
      memory.status ?? "active",
      memory.supersedesId ?? null,
      createHash("sha256").update(memory.content).digest("hex"),
      createdAt,
      updatedAt
    );

    let position = 0;
    chunks.forEach((chunk, index) => {
      insertChunk.run(
        `${memory.id}_${index}`,
        memory.id,
        index,
        position,
        chunk.split(/\s+/).length,
        chunk,
        createdAt
      );
      position += chunk.length + 1;
    });
  }

  for (const edge of edges) {
    persistMemoryEdge(handle, edge);
  }
}

export function assertTopIds(
  results: Array<{ id: string }>,
  expectedIds: string[],
  message: string
): void {
  assert.deepEqual(
    results.slice(0, expectedIds.length).map((result) => result.id),
    expectedIds,
    message
  );
}
