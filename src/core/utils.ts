import type { MemoryItem, MemoryType, MemoryScope } from "../types/memory.js";
import type { DbHandle } from "../db/index.js";
import type { CoreContext } from "./context.js";

/**
 * Safely parse tags JSON from DB row, returning [] on malformed data.
 */
function safeParseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Database row shape for memory_items queries
 */
export interface MemoryItemRow {
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
}

/**
 * Map a database row to a MemoryItem
 */
export function mapRowToMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    type: row.type as MemoryType,
    title: row.title,
    content: row.content,
    summary: row.summary,
    source: row.source,
    scope: row.scope as MemoryScope,
    tags: safeParseTags(row.tags),
    importance: row.importance,
    status: row.status as "pending" | "active" | "archived" | "deleted",
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Generate a unique ID for memory items
 * Uses timestamp + random suffix for uniqueness
 */
export function generateMemoryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `mem_${timestamp}_${random}`;
}

/**
 * Check if an item with the given ID exists in the workspace
 */
export function memoryItemExists(ctx: CoreContext, id: string): boolean {
  const row = ctx.db.db
    .prepare(`
      SELECT 1 FROM memory_items 
      WHERE id = ? AND workspace = ?
    `)
    .get(id, ctx.workspace);
  
  return row !== undefined;
}

/**
 * Get the status of a memory item
 */
export function getMemoryItemStatus(
  ctx: CoreContext, 
  id: string
): "pending" | "active" | "archived" | "deleted" | null {
  const row = ctx.db.db
    .prepare(`
      SELECT status FROM memory_items 
      WHERE id = ? AND workspace = ?
    `)
    .get(id, ctx.workspace) as { status: string } | undefined;
  
  if (!row) return null;
  return row.status as "pending" | "active" | "archived" | "deleted";
}

/**
 * Build WHERE clause and parameters for list filtering
 */
export function buildListFilter(
  ctx: CoreContext,
  filters: {
    workspace?: string;
    type?: MemoryType;
    scope?: MemoryScope;
    status?: "pending" | "active" | "archived" | "deleted";
  }
): { whereClause: string; params: (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  
  // Always filter by workspace
  conditions.push("workspace = ?");
  params.push(filters.workspace ?? ctx.workspace);
  
  if (filters.type) {
    conditions.push("type = ?");
    params.push(filters.type);
  }
  
  if (filters.scope) {
    conditions.push("scope = ?");
    params.push(filters.scope);
  }
  
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  
  const whereClause = conditions.length > 0 
    ? `WHERE ${conditions.join(" AND ")}` 
    : "";
  
  return { whereClause, params };
}

/**
 * Get the last indexed timestamp from the database
 */
export function getLastIndexedTimestamp(db: DbHandle, workspace: string): string | null {
  const row = db.db
    .prepare(`
      SELECT MAX(updated_at) as last_update 
      FROM memory_items 
      WHERE status = 'active' AND workspace = ?
    `)
    .get(workspace) as { last_update: string | null } | undefined;

  return row?.last_update ?? null;
}

/**
 * Validate that a string is a valid UUID or memory ID format
 */
export function isValidId(id: string): boolean {
  return typeof id === "string" && id.length > 0;
}
