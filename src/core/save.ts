import type { CoreContext } from "./context.js";
import type { MemoryScope, MemoryType } from "../types/memory.js";
import type { SaveMemoryInput, SaveResult } from "./types.js";
import { SaveMemoryInputSchema, CoreError } from "./types.js";
import { generateMemoryId, getMemoryItemStatus } from "./utils.js";
import { chunkDocument } from "../ingest/chunker.js";
import { createHash } from "node:crypto";
import { deleteVectorsForMemory } from "./vector-sync.js";

/**
 * Save a memory item using a two-phase commit strategy.
 * 
 * Phase 1: Insert the item as 'pending' in DB, write chunks/embeddings,
 *          then insert vectors into zvec.
 * Phase 2: Finalize by setting the new item to 'active' and archiving
 *          the superseded item (if any), then remove superseded vectors.
 * 
 * On failure at any phase, compensation logic rolls back partial state
 * to prevent DB/vector drift.
 * 
 * @param ctx - Core context with dependencies
 * @param input - SaveMemoryInput with item data
 * @returns SaveResult with ID and status info
 * @throws CoreError if validation fails, old item not found, or database errors
 */
export async function save(
  ctx: CoreContext,
  input: SaveMemoryInput
): Promise<SaveResult> {
  // Validate input
  const validation = SaveMemoryInputSchema.safeParse(input);
  if (!validation.success) {
    const errors = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new CoreError(`Validation failed: ${errors}`, "VALIDATION");
  }
  
  const data = validation.data;
  const now = new Date().toISOString();
  const id = generateMemoryId();
  
  // Handle supersedes logic
  let supersededId: string | undefined;
  if (data.supersedesId) {
    const oldStatus = getMemoryItemStatus(ctx, data.supersedesId);
    
    if (oldStatus === null) {
      throw new CoreError(
        `Cannot supersede: item '${data.supersedesId}' not found`,
        "NOT_FOUND"
      );
    }
    
    if (oldStatus !== "active") {
      throw new CoreError(
        `Cannot supersede: item '${data.supersedesId}' has status '${oldStatus}'`,
        "CONFLICT"
      );
    }
    
    supersededId = data.supersedesId;
  }
  
  try {
    // Generate content hash for change detection
    const contentHash = generateContentHash(data.content);
    const prepared = await prepareChunkEmbeddings(
      ctx,
      id,
      data.content,
      data.type,
      data.scope
    );

    const insertMemoryItem = ctx.db.db.prepare(`
      INSERT INTO memory_items (
        id, type, title, content, summary, source, scope, workspace,
        tags, importance, status, supersedes_id, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateMemoryStatus = ctx.db.db.prepare(`
      UPDATE memory_items
      SET status = ?, updated_at = ?
      WHERE id = ? AND workspace = ?
    `);
    const insertChunk = ctx.db.db.prepare(`
      INSERT INTO content_chunks (id, memory_id, seq, pos, token_count, chunk_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEmbedding = ctx.db.db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedded_at, model)
      VALUES (?, ?, ?)
    `);
    const deleteNewMemory = ctx.db.db.prepare(`
      DELETE FROM memory_items WHERE id = ? AND workspace = ?
    `);

    const createPendingTx = ctx.db.db.transaction(() => {
      insertMemoryItem.run(
        id,
        data.type,
        data.title,
        data.content,
        data.summary,
        data.source,
        data.scope,
        ctx.workspace,
        JSON.stringify(data.tags),
        data.importance,
        "pending",
        supersededId ?? null,
        contentHash,
        now,
        now
      );

      for (const chunk of prepared.chunks) {
        insertChunk.run(
          chunk.chunkId,
          id,
          chunk.seq,
          chunk.pos,
          chunk.tokenCount,
          chunk.text,
          now
        );
      }

      for (const chunk of prepared.chunks) {
        insertEmbedding.run(chunk.chunkId, now, ctx.embedProvider.model);
      }
    });

    createPendingTx();

    try {
      for (const chunk of prepared.chunks) {
        ctx.vectorCollection.insert(chunk.chunkId, chunk.embedding, chunk.metadata);
      }
    } catch (vectorError) {
      // Roll back the pending item if vector writes fail.
      ctx.db.db.transaction(() => {
        deleteNewMemory.run(id, ctx.workspace);
      })();
      throw new CoreError(
        `Vector sync failed while creating memory item: ${vectorError instanceof Error ? vectorError.message : String(vectorError)}`,
        "DATABASE",
        vectorError instanceof Error ? vectorError : undefined
      );
    }

    const finalizeNow = new Date().toISOString();
    const finalizeTx = ctx.db.db.transaction(() => {
      updateMemoryStatus.run("active", finalizeNow, id, ctx.workspace);
      if (supersededId) {
        updateMemoryStatus.run("archived", finalizeNow, supersededId, ctx.workspace);
      }
    });

    try {
      finalizeTx();
    } catch (finalizeError) {
      // Compensate vector side and remove pending/new row.
      try {
        deleteVectorsForMemory(ctx, id);
      } catch {
        // Best effort cleanup.
      }
      ctx.db.db.transaction(() => {
        deleteNewMemory.run(id, ctx.workspace);
      })();
      throw new CoreError(
        `Failed finalizing save transaction: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`,
        "DATABASE",
        finalizeError instanceof Error ? finalizeError : undefined
      );
    }

    if (supersededId) {
      try {
        deleteVectorsForMemory(ctx, supersededId);
      } catch (cleanupError) {
        throw new CoreError(
          `Saved memory but failed retiring superseded vectors: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          "DATABASE",
          cleanupError instanceof Error ? cleanupError : undefined
        );
      }
    }
    
    return {
      id,
      isNew: true,
      supersededId,
    };
  } catch (error) {
    if (error instanceof CoreError) {
      throw error;
    }
    
    throw new CoreError(
      `Failed to save memory item: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Generate a content hash for change detection
 */
function generateContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Chunk content and generate embeddings before persistence
 */
async function prepareChunkEmbeddings(
  ctx: CoreContext,
  memoryId: string,
  content: string,
  type: MemoryType,
  scope: MemoryScope
): Promise<{
  chunks: Array<{
    chunkId: string;
    seq: number;
    pos: number;
    tokenCount: number;
    text: string;
    embedding: number[];
    metadata: Record<string, unknown>;
  }>;
}> {
  try {
    const { chunks } = chunkDocument(content);
    if (chunks.length === 0) return { chunks: [] };

    const chunkInputs = chunks.map(chunk => ({
      id: `${memoryId}_${chunk.seq}`,
      text: chunk.text,
    }));

    const embeddings = await ctx.embedProvider.embedBatch(chunkInputs);

    const embeddingMap = new Map(embeddings.map((e) => [e.id, e.embedding]));
    const preparedChunks = chunks.map((chunk) => {
      const chunkId = `${memoryId}_${chunk.seq}`;
      const embedding = embeddingMap.get(chunkId);
      if (!embedding) {
        throw new CoreError(`Missing embedding for chunk '${chunkId}'`, "EMBEDDING");
      }

      return {
        chunkId,
        seq: chunk.seq,
        pos: chunk.pos,
        tokenCount: chunk.tokenCount,
        text: chunk.text,
        embedding,
        // Vector metadata uses "active" even though the DB row is still "pending"
        // at insertion time. This is deliberate: zvec has no cheap metadata-update
        // API, and on failure the vectors are deleted during compensation anyway.
        metadata: {
          workspace: ctx.workspace,
          scope,
          type,
          status: "active",
        },
      };
    });

    return { chunks: preparedChunks };
  } catch (error) {
    throw new CoreError(
      `Failed to prepare chunk embeddings: ${error instanceof Error ? error.message : String(error)}`,
      "EMBEDDING",
      error instanceof Error ? error : undefined
    );
  }
}
