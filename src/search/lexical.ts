import type { DbHandle } from "../db/index.js";
import type { MemoryScope, MemoryType } from "../types/memory.js";
import { error, debug } from "../utils/logger.js";

export interface LexicalHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: "lex";
  scope: MemoryScope;
  type: MemoryType;
  status: string;
}

export interface LexicalSearchOptions {
  query: string;
  workspace?: string;
  topK?: number;
  scopes?: MemoryScope[];
  types?: MemoryType[];
  status?: string;
}

function buildFilterClause(
  workspace?: string,
  scopes?: MemoryScope[],
  types?: MemoryType[],
  status?: string
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (workspace) {
    conditions.push("m.workspace = ?");
    params.push(workspace);
  }

  if (scopes && scopes.length > 0) {
    const placeholders = scopes.map(() => "?").join(", ");
    conditions.push(`m.scope IN (${placeholders})`);
    params.push(...scopes);
  }

  if (types && types.length > 0) {
    const placeholders = types.map(() => "?").join(", ");
    conditions.push(`m.type IN (${placeholders})`);
    params.push(...types);
  }

  if (status) {
    conditions.push("m.status = ?");
    params.push(status);
  }

  if (conditions.length === 0) {
    return { clause: "", params: [] };
  }

  return { clause: conditions.join(" AND "), params };
}

export function searchLexical(
  db: DbHandle,
  options: LexicalSearchOptions
): LexicalHit[] {
  const { query, workspace, topK = 30, scopes, types, status = "active" } = options;

  if (!query.trim()) {
    return [];
  }

  const filter = buildFilterClause(workspace, scopes, types, status);

  const sql = `
    SELECT
      m.id,
      m.title,
      m.content,
      m.scope,
      m.type,
      m.status,
      bm25(memory_items_fts) as bm25_score,
      snippet(memory_items_fts, 1, '<mark>', '</mark>', '...', 64) as snippet
    FROM memory_items_fts
    JOIN memory_items m ON memory_items_fts.content_rowid = m.rowid
    WHERE memory_items_fts MATCH ?
    ${filter.clause ? "AND " + filter.clause : ""}
    ORDER BY bm25_score
    LIMIT ?
  `;

  const params = [query, ...filter.params, topK];

  try {
    const rows = db.db.prepare(sql).all(...params) as {
      id: string;
      title: string;
      content: string;
      scope: MemoryScope;
      type: MemoryType;
      status: string;
      bm25_score: number;
      snippet: string;
    }[];

    if (!rows || rows.length === 0) {
      return [];
    }

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      snippet: row.snippet || row.content.slice(0, 200),
      score: 1 / (1 + Math.abs(row.bm25_score)),
      source: "lex" as const,
      scope: row.scope,
      type: row.type,
      status: row.status,
    }));
  } catch (err) {
    error(() => `[LexicalSearch] FTS query error: ${err}`);
    return [];
  }
}
