import type { CoreContext } from "./context.js";
import type { ListMemoryFilters, ListResult } from "./types.js";
import { mapRowToMemoryItem, buildListFilter } from "./utils.js";
import { CoreError, ListMemoryFiltersSchema } from "./types.js";
import { ZodError } from "zod";

/**
 * List memory items with filtering and pagination
 * 
 * @param ctx - Core context with dependencies
 * @param filters - Filter options (type, scope, status, limit, offset)
 * @returns ListResult with items and total count
 * @throws CoreError if database operation fails
 */
export async function list(
  ctx: CoreContext,
  filters: ListMemoryFilters = {}
): Promise<ListResult> {
  try {
    const parsed = ListMemoryFiltersSchema.parse(filters);
    const { limit, offset } = parsed;
    const filterFields = {
      workspace: parsed.workspace,
      type: parsed.type,
      scope: parsed.scope,
      status: parsed.status,
    };
    const { whereClause, params } = buildListFilter(ctx, filterFields);
    
    // Get total count
    const countRow = ctx.db.db
      .prepare(`SELECT COUNT(*) as total FROM memory_items ${whereClause}`)
      .get(...params) as { total: number };
    
    const total = countRow.total;
    
    // Get paginated results
    const query = `
      SELECT 
        id, type, title, content, summary, source, scope, workspace,
        tags, importance, status, supersedes_id, content_hash,
        created_at, updated_at
      FROM memory_items 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    const rows = ctx.db.db
      .prepare(query)
      .all(...params, limit, offset) as Array<{
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
    
    const items = rows.map(mapRowToMemoryItem);
    
    return {
      items,
      total,
      limit,
      offset,
    };
  } catch (error) {
    if (error instanceof CoreError) {
      throw error;
    }

    if (error instanceof ZodError) {
      throw new CoreError("Invalid list filters", "VALIDATION", error);
    }

    throw new CoreError(
      `Failed to list memory items: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}
