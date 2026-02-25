import type { CoreContext } from "./context.js";
import type { MemoryScope, MemoryType } from "../types/memory.js";
import type { ReindexResult } from "./types.js";
import { CoreError } from "./types.js";
import { chunkDocument } from "../ingest/chunker.js";
import { deleteVectorsForMemories } from "./vector-sync.js";

/**
 * Reindex all active memory items in the workspace
 * 
 * This operation:
 * 1. Clears existing vectors from the vector collection
 * 2. Retrieves all active memory items
 * 3. Re-chunks and re-embeds each item's content
 * 4. Updates chunk_embeddings timestamps
 * 
 * @param ctx - Core context with dependencies
 * @returns ReindexResult with counts and duration
 * @throws CoreError if embedding fails or database errors
 */
export async function reindex(ctx: CoreContext): Promise<ReindexResult> {
  const startTime = Date.now();
  const result: ReindexResult = {
    processed: 0,
    errors: 0,
    duration: 0,
  };
  
  try {
    // Get all active memory items in the workspace
    const items = ctx.db.db
      .prepare(`
        SELECT id, type, scope, content
        FROM memory_items
        WHERE workspace = ? AND status = 'active'
        ORDER BY created_at DESC
      `)
      .all(ctx.workspace) as Array<{
        id: string;
        type: MemoryType;
        scope: MemoryScope;
        content: string;
      }>;
    
    if (items.length === 0) {
      result.duration = Date.now() - startTime;
      return result;
    }
    
    // Process in batches for memory efficiency
    const batchSize = ctx.config.ai.embedding.batchSize || 8;
    const now = new Date().toISOString();

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      try {
        await reindexBatch(ctx, batch, now);
        result.processed += batch.length;
      } catch (error) {
        result.errors += batch.length;
        for (const item of batch) {
          console.error(`Failed to reindex item ${item.id}:`, error);
        }
      }
    }
    
    result.duration = Date.now() - startTime;
    return result;
  } catch (error) {
    throw new CoreError(
      `Reindex failed: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Reindex a batch of memory items with one embedding call
 */
async function reindexBatch(
  ctx: CoreContext,
  items: Array<{ id: string; type: MemoryType; scope: MemoryScope; content: string }>,
  timestamp: string
): Promise<void> {
  const deleteEmbeddingsForItem = ctx.db.db.prepare(`
    DELETE FROM chunk_embeddings
    WHERE chunk_id IN (
      SELECT id FROM content_chunks WHERE memory_id = ?
    )
  `);
  const deleteChunksForItem = ctx.db.db.prepare(`
    DELETE FROM content_chunks WHERE memory_id = ?
  `);
  const insertChunk = ctx.db.db.prepare(`
    INSERT INTO content_chunks (id, memory_id, seq, pos, token_count, chunk_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEmbedding = ctx.db.db.prepare(`
    INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedded_at, model)
    VALUES (?, ?, ?)
  `);
  const updateMemoryTimestamp = ctx.db.db.prepare(`
    UPDATE memory_items SET updated_at = ? WHERE id = ?
  `);

  const prepared: Array<{
    itemId: string;
    type: MemoryType;
    scope: MemoryScope;
    chunkId: string;
    seq: number;
    pos: number;
    tokenCount: number;
    text: string;
  }> = [];

  // Delete DB rows first (source of truth), then vectors
  for (const item of items) {
    deleteEmbeddingsForItem.run(item.id);
    deleteChunksForItem.run(item.id);

    const { chunks } = chunkDocument(item.content);
    for (const chunk of chunks) {
      prepared.push({
        itemId: item.id,
        type: item.type,
        scope: item.scope,
        chunkId: `${item.id}_${chunk.seq}`,
        seq: chunk.seq,
        pos: chunk.pos,
        tokenCount: chunk.tokenCount,
        text: chunk.text,
      });
    }
  }

  // Remove stale vectors after DB cleanup
  deleteVectorsForMemories(
    ctx,
    items.map((item) => item.id)
  );

  if (prepared.length === 0) {
    for (const item of items) {
      updateMemoryTimestamp.run(timestamp, item.id);
    }
    return;
  }

  const embeddings = await ctx.embedProvider.embedBatch(
    prepared.map((chunk) => ({ id: chunk.chunkId, text: chunk.text }))
  );
  const embeddingMap = new Map(embeddings.map((e) => [e.id, e.embedding]));

  for (const chunk of prepared) {
    insertChunk.run(
      chunk.chunkId,
      chunk.itemId,
      chunk.seq,
      chunk.pos,
      chunk.tokenCount,
      chunk.text,
      timestamp
    );
    insertEmbedding.run(chunk.chunkId, timestamp, ctx.embedProvider.model);

    const embedding = embeddingMap.get(chunk.chunkId);
    if (!embedding) {
      throw new CoreError(`Missing embedding for chunk '${chunk.chunkId}'`, "EMBEDDING");
    }

    ctx.vectorCollection.insert(chunk.chunkId, embedding, {
      workspace: ctx.workspace,
      scope: chunk.scope,
      type: chunk.type,
      status: "active",
    });
  }

  for (const item of items) {
    updateMemoryTimestamp.run(timestamp, item.id);
  }
}
