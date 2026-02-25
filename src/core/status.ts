import type { CoreContext } from "./context.js";
import type { MemoryStatus } from "./types.js";
import { getLastIndexedTimestamp } from "./utils.js";
import { CoreError } from "./types.js";

/**
 * Get system status including item counts and indexing info
 * 
 * @param ctx - Core context with dependencies
 * @returns MemoryStatus with counts and timestamps
 * @throws CoreError if database operation fails
 */
export async function status(ctx: CoreContext): Promise<MemoryStatus> {
  try {
    // Get total items in workspace
    const totalItemsRow = ctx.db.db
      .prepare(`
        SELECT COUNT(*) as count 
        FROM memory_items 
        WHERE workspace = ?
      `)
      .get(ctx.workspace) as { count: number };
    
    // Get total vectors (estimate from zvec collection)
    // Note: zvec doesn't expose a direct count method in the interface,
    // so we estimate from chunk_embeddings table
    const totalVectorsRow = ctx.db.db
      .prepare(`
        SELECT COUNT(*) as count 
        FROM chunk_embeddings e
        JOIN content_chunks c ON e.chunk_id = c.id
        JOIN memory_items m ON c.memory_id = m.id
        WHERE m.workspace = ? AND c.deleted_at IS NULL
      `)
      .get(ctx.workspace) as { count: number };
    
    // Get pending embeddings (chunks without embeddings)
    const pendingRow = ctx.db.db
      .prepare(`
        SELECT COUNT(*) as count 
        FROM content_chunks c
        JOIN memory_items m ON c.memory_id = m.id
        LEFT JOIN chunk_embeddings e ON c.id = e.chunk_id
        WHERE e.chunk_id IS NULL 
          AND c.deleted_at IS NULL 
          AND m.workspace = ?
      `)
      .get(ctx.workspace) as { count: number };
    
    const lastIndexedAt = getLastIndexedTimestamp(ctx.db, ctx.workspace);
    
    return {
      totalItems: totalItemsRow.count,
      totalVectors: totalVectorsRow.count,
      pendingEmbeddings: pendingRow.count,
      lastIndexedAt,
    };
  } catch (error) {
    throw new CoreError(
      `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}
