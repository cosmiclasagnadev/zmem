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

export interface ChunkLexicalHit {
  id: string;
  memoryId: string;
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
  statuses?: string[];
}

function tokenizeForFts(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/["'`]/g, " ")
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

function buildMatchQuery(tokens: string[], mode: "and" | "or"): string {
  const connector = mode === "and" ? " AND " : " OR ";
  return tokens.map((token) => `"${token}"`).join(connector);
}

function buildFilterClause(
  workspace?: string,
  scopes?: MemoryScope[],
  types?: MemoryType[],
  statuses?: string[]
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

  if (statuses && statuses.length > 0) {
    const placeholders = statuses.map(() => "?").join(", ");
    conditions.push(`m.status IN (${placeholders})`);
    params.push(...statuses);
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
  const { query, workspace, topK = 30, scopes, types, statuses = ["active"] } = options;

  if (!query.trim()) {
    return [];
  }

  const filter = buildFilterClause(workspace, scopes, types, statuses);

  const mapRows = (rows: Array<{
    id: string;
    title: string;
    content: string;
    scope: MemoryScope;
    type: MemoryType;
    status: string;
    bm25_score: number;
    snippet: string;
  }>): LexicalHit[] => {
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
  };

  const executeSearch = (matchQuery: string): LexicalHit[] => {
    const params = [matchQuery, ...filter.params, topK];
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
    return mapRows(rows ?? []);
  };

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

  const tokens = tokenizeForFts(query);
  if (tokens.length === 0) {
    debug(() => `[LexicalSearch] Query produced no searchable tokens (len=${query.length})`);
    return [];
  }

  try {
    const strictQuery = buildMatchQuery(tokens, "and");
    const strictHits = executeSearch(strictQuery);
    if (strictHits.length > 0) {
      return strictHits;
    }

    if (tokens.length === 1) {
      return strictHits;
    }

    const relaxedQuery = buildMatchQuery(tokens, "or");
    return executeSearch(relaxedQuery);
  } catch (err) {
    error(() => `[LexicalSearch] FTS query error (queryLen=${query.length}): ${err}`);
    return [];
  }
}

export function searchLexicalChunks(
  db: DbHandle,
  options: LexicalSearchOptions
): ChunkLexicalHit[] {
  const { query, workspace, topK = 30, scopes, types, statuses = ["active"] } = options;

  if (!query.trim()) {
    return [];
  }

  const filter = buildFilterClause(workspace, scopes, types, statuses);
  const chunkFilterClause = ["c.deleted_at IS NULL", filter.clause].filter(Boolean).join(" AND ");

  const sql = `
    SELECT
      c.id AS chunk_id,
      c.memory_id,
      m.title,
      m.scope,
      m.type,
      m.status,
      c.chunk_text,
      bm25(content_chunks_fts) AS bm25_score,
      snippet(content_chunks_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet
    FROM content_chunks_fts
    JOIN content_chunks c ON content_chunks_fts.rowid = c.rowid
    JOIN memory_items m ON c.memory_id = m.id
    WHERE content_chunks_fts MATCH ?
    ${chunkFilterClause ? "AND " + chunkFilterClause : ""}
    ORDER BY bm25_score
    LIMIT ?
  `;

  const mapRows = (rows: Array<{
    chunk_id: string;
    memory_id: string;
    title: string;
    scope: MemoryScope;
    type: MemoryType;
    status: string;
    chunk_text: string;
    bm25_score: number;
    snippet: string;
  }>): ChunkLexicalHit[] => {
    return rows.map((row) => ({
      id: row.chunk_id,
      memoryId: row.memory_id,
      title: row.title,
      snippet: row.snippet || row.chunk_text.slice(0, 200),
      score: 1 / (1 + Math.abs(row.bm25_score)),
      source: "lex",
      scope: row.scope,
      type: row.type,
      status: row.status,
    }));
  };

  const executeSearch = (matchQuery: string): ChunkLexicalHit[] => {
    const params = [matchQuery, ...filter.params, topK];
    const rows = db.db.prepare(sql).all(...params) as Array<{
      chunk_id: string;
      memory_id: string;
      title: string;
      scope: MemoryScope;
      type: MemoryType;
      status: string;
      chunk_text: string;
      bm25_score: number;
      snippet: string;
    }>;
    return mapRows(rows ?? []);
  };

  const tokens = tokenizeForFts(query);
  if (tokens.length === 0) {
    debug(() => `[LexicalChunkSearch] Query produced no searchable tokens (len=${query.length})`);
    return [];
  }

  try {
    const strictHits = executeSearch(buildMatchQuery(tokens, "and"));
    if (strictHits.length > 0 || tokens.length === 1) {
      return strictHits;
    }

    return executeSearch(buildMatchQuery(tokens, "or"));
  } catch (err) {
    error(() => `[LexicalChunkSearch] FTS query error (queryLen=${query.length}): ${err}`);
    return [];
  }
}
