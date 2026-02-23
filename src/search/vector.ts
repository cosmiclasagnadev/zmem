import type { EmbeddingProvider } from "../embed/types.js";
import type { VectorCollection } from "../vectors/index.js";
import type { DbHandle } from "../db/index.js";
import type { MemoryScope, MemoryType } from "../types/memory.js";
import { error } from "../utils/logger.js";

export interface VectorSearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: "vec";
  scope: MemoryScope;
  type: MemoryType;
  status: string;
}

export interface VectorSearchOptions {
  query: string;
  workspace?: string;
  topK?: number;
  scopes?: MemoryScope[];
  types?: MemoryType[];
  status?: string;
}

function buildZvecFilter(
  workspace?: string,
  scopes?: MemoryScope[],
  types?: MemoryType[],
  status?: string
): string | undefined {
  const conditions: string[] = [];

  if (workspace) {
    conditions.push(`workspace = "${workspace}"`);
  }

  if (status) {
    conditions.push(`status = "${status}"`);
  }

  if (scopes && scopes.length > 0) {
    const scopeConditions = scopes.map((s) => `scope = "${s}"`).join(" or ");
    conditions.push(`(${scopeConditions})`);
  }

  if (types && types.length > 0) {
    const typeConditions = types.map((t) => `type = "${t}"`).join(" or ");
    conditions.push(`(${typeConditions})`);
  }

  return conditions.length > 0 ? conditions.join(" and ") : undefined;
}

interface MemoryLookup {
  title: string;
  content: string;
}

function batchLookupMemories(
  db: DbHandle,
  memoryIds: string[]
): Map<string, MemoryLookup> {
  const result = new Map<string, MemoryLookup>();
  if (memoryIds.length === 0) return result;

  const unique = [...new Set(memoryIds)];
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db.db
    .prepare(
      `SELECT id, title, content FROM memory_items WHERE id IN (${placeholders})`
    )
    .all(...unique) as Array<{ id: string; title: string; content: string }>;

  for (const row of rows) {
    result.set(row.id, { title: row.title, content: row.content });
  }

  return result;
}

function extractSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  for (const word of queryWords) {
    const idx = lowerContent.indexOf(word);
    if (idx !== -1) {
      const start = Math.max(0, idx - 50);
      const end = Math.min(content.length, idx + 150);
      let snippet = content.slice(start, end);
      if (start > 0) snippet = "..." + snippet;
      if (end < content.length) snippet = snippet + "...";
      return snippet;
    }
  }

  return content.slice(0, 200) + (content.length > 200 ? "..." : "");
}

export async function searchVector(
  db: DbHandle,
  embedProvider: EmbeddingProvider,
  vectorCollection: VectorCollection,
  options: VectorSearchOptions
): Promise<VectorSearchHit[]> {
  const { query, workspace, topK = 30, scopes, types, status = "active" } = options;

  if (!query.trim()) {
    return [];
  }

  try {
    const embedding = await embedProvider.embed(query);
    const filter = buildZvecFilter(workspace, scopes, types, status);

    const results = vectorCollection.query(embedding, topK, filter);

    if (!results || results.length === 0) {
      return [];
    }

    // Extract unique memory IDs and batch-fetch from DB
    const memoryIds = results.map((hit) => hit.id.replace(/_[0-9]+$/, ""));
    const lookup = batchLookupMemories(db, memoryIds);

    return results.map((hit, i) => {
      const memoryId = memoryIds[i];
      const mem = lookup.get(memoryId);
      return {
        id: memoryId,
        title: mem?.title || "",
        snippet: mem ? extractSnippet(mem.content, query) : "",
        score: hit.score,
        source: "vec" as const,
        scope: (hit.fields.scope as MemoryScope) || "workspace",
        type: (hit.fields.type as MemoryType) || "fact",
        status: (hit.fields.status as string) || "active",
      };
    });
  } catch (err) {
    error(() => `[VectorSearch] Error: ${err}`);
    return [];
  }
}
