import type { CoreContext } from "./context.js";
import { isValidId } from "./utils.js";
import { CoreError } from "./types.js";
import { deleteVectorsForMemory } from "./vector-sync.js";

/**
 * Soft delete a memory item by ID
 * Sets status to "deleted" instead of removing from database
 * 
 * @param ctx - Core context with dependencies
 * @param id - Memory item ID to delete
 * @returns true if item was deleted, false if not found or already deleted
 * @throws CoreError if validation fails or database error occurs
 */
export async function deleteMemory(
  ctx: CoreContext,
  id: string
): Promise<boolean> {
  // Validate ID
  if (!isValidId(id)) {
    throw new CoreError("Invalid memory item ID", "VALIDATION");
  }
  
  try {
    const row = ctx.db.db
      .prepare(`
        SELECT status, updated_at FROM memory_items
        WHERE id = ? AND workspace = ?
      `)
      .get(id, ctx.workspace) as { status: "pending" | "active" | "archived" | "deleted"; updated_at: string } | undefined;

    if (!row || row.status === "deleted") {
      return false;
    }

    // Perform soft delete in DB first.
    const now = new Date().toISOString();
    ctx.db.db
      .prepare(`
        UPDATE memory_items 
        SET status = 'deleted', updated_at = ?
        WHERE id = ? AND workspace = ?
      `)
      .run(now, id, ctx.workspace);

    try {
      deleteVectorsForMemory(ctx, id);
      return true;
    } catch (vectorError) {
      // Compensate DB status to avoid DB/vector drift.
      // Restore original status and updated_at.
      ctx.db.db
        .prepare(`
          UPDATE memory_items
          SET status = ?, updated_at = ?
          WHERE id = ? AND workspace = ?
        `)
        .run(row.status, row.updated_at, id, ctx.workspace);

      throw new CoreError(
        `Vector sync failed during delete: ${vectorError instanceof Error ? vectorError.message : String(vectorError)}`,
        "DATABASE",
        vectorError instanceof Error ? vectorError : undefined
      );
    }
  } catch (error) {
    if (error instanceof CoreError) {
      throw error;
    }

    throw new CoreError(
      `Failed to delete memory item: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}
