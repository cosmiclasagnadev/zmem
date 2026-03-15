import type { CoreContext } from "./context.js";
import type { MemoryItem } from "../types/memory.js";
import { mapRowToMemoryItem, isValidId } from "./utils.js";
import { CoreError } from "./types.js";

/**
 * Fetch a single memory item by ID
 * 
 * @param ctx - Core context with dependencies
 * @param id - Memory item ID to fetch
 * @returns MemoryItem or null if not found
 * @throws CoreError if validation fails
 */
export async function get(
  ctx: CoreContext,
  id: string
): Promise<MemoryItem | null> {
  // Validate ID
  if (!isValidId(id)) {
    throw new CoreError("Invalid memory item ID", "VALIDATION");
  }
  
  try {
    const row = ctx.db.db
      .prepare(`
        SELECT 
          id, type, title, content, summary, source, scope, workspace,
          tags, importance, status, supersedes_id, content_hash,
          created_at, updated_at
        FROM memory_items 
        WHERE id = ? AND workspace = ?
      `)
      .get(id, ctx.workspace) as {
        id: string;
        type: string;
        title: string;
        content: string;
        summary: string;
        source: string;
        scope: string;
        workspace: string;
        tags: string;
        importance: number;
        status: string;
        supersedes_id: string | null;
        content_hash: string;
        created_at: string;
        updated_at: string;
      } | undefined;
    
    if (!row) {
      return null;
    }
    
    return mapRowToMemoryItem(row);
  } catch (error) {
    throw new CoreError(
      `Failed to fetch memory item: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}

export async function getMany(
  ctx: CoreContext,
  ids: string[]
): Promise<MemoryItem[]> {
  const uniqueIds = [...new Set(ids.filter((id) => isValidId(id)))];
  if (uniqueIds.length === 0) {
    return [];
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");

  try {
    const rows = ctx.db.db
      .prepare(`
        SELECT
          id, type, title, content, summary, source, scope, workspace,
          tags, importance, status, supersedes_id, content_hash,
          created_at, updated_at
        FROM memory_items
        WHERE workspace = ?
          AND id IN (${placeholders})
      `)
      .all(ctx.workspace, ...uniqueIds) as Array<{
        id: string;
        type: string;
        title: string;
        content: string;
        summary: string;
        source: string;
        scope: string;
        workspace: string;
        tags: string;
        importance: number;
        status: string;
        supersedes_id: string | null;
        content_hash: string;
        created_at: string;
        updated_at: string;
      }>;

    const rowsById = new Map(rows.map((row) => [row.id, mapRowToMemoryItem(row)]));
    return uniqueIds.flatMap((id) => {
      const item = rowsById.get(id);
      return item ? [item] : [];
    });
  } catch (error) {
    throw new CoreError(
      `Failed to fetch memory items: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}
