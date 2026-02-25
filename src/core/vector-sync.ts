import type { CoreContext } from "./context.js";
import { CoreError } from "./types.js";

function getChunkIdsForMemory(ctx: CoreContext, memoryId: string): string[] {
  const rows = ctx.db.db
    .prepare(`SELECT id FROM content_chunks WHERE memory_id = ?`)
    .all(memoryId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function deleteVectorsByChunkIds(ctx: CoreContext, chunkIds: string[]): void {
  for (const chunkId of chunkIds) {
    try {
      ctx.vectorCollection.delete(chunkId);
    } catch (error) {
      throw new CoreError(
        `Failed deleting vector '${chunkId}': ${error instanceof Error ? error.message : String(error)}`,
        "DATABASE",
        error instanceof Error ? error : undefined
      );
    }
  }
}

export function deleteVectorsForMemory(ctx: CoreContext, memoryId: string): void {
  const chunkIds = getChunkIdsForMemory(ctx, memoryId);
  if (chunkIds.length === 0) return;
  deleteVectorsByChunkIds(ctx, chunkIds);
}

export function deleteVectorsForMemories(ctx: CoreContext, memoryIds: string[]): void {
  if (memoryIds.length === 0) return;

  const placeholders = memoryIds.map(() => "?").join(", ");
  const rows = ctx.db.db
    .prepare(`SELECT id FROM content_chunks WHERE memory_id IN (${placeholders})`)
    .all(...memoryIds) as Array<{ id: string }>;

  if (rows.length === 0) return;
  deleteVectorsByChunkIds(
    ctx,
    rows.map((row) => row.id)
  );
}
