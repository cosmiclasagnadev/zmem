import type { DbHandle } from "../db/index.js";
import type { EmbeddingProvider } from "../embed/types.js";
import type { VectorCollection } from "../vectors/index.js";
import type { MemoryScope, MemoryType } from "../types/memory.js";
import { searchLexical, type LexicalHit } from "./lexical.js";
import { searchVector, type VectorSearchHit } from "./vector.js";
import { rrfFusion, type SearchHit, type FusionOptions } from "./fusion.js";

export interface QueryInput {
  query: string;
  workspace?: string;
  scopes?: Array<"workspace" | "global" | "user">;
  types?: MemoryType[];
  includeSuperseded?: boolean;
  topK?: number;
  minScore?: number;
  mode?: "hybrid" | "lexical" | "vector";
}

export interface QueryHit {
  id: string;
  title: string;
  score: number;
  source: "lex" | "vec" | "hybrid";
  snippet: string;
  scope: MemoryScope;
  type: MemoryType;
}

function tokenizeForArchivedLookup(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/["'`]/g, " ")
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function searchArchivedByKeyword(
  db: DbHandle,
  input: {
    query: string;
    workspace: string;
    scopes: MemoryScope[];
    types?: MemoryType[];
    topK: number;
  }
): SearchHit[] {
  const tokens = tokenizeForArchivedLookup(input.query);
  if (tokens.length === 0) {
    return [];
  }

  const clauses: string[] = ["workspace = ?", "status = 'archived'"];
  const params: unknown[] = [input.workspace];

  if (input.scopes.length > 0) {
    const scopePlaceholders = input.scopes.map(() => "?").join(", ");
    clauses.push(`scope IN (${scopePlaceholders})`);
    params.push(...input.scopes);
  }

  if (input.types && input.types.length > 0) {
    const typePlaceholders = input.types.map(() => "?").join(", ");
    clauses.push(`type IN (${typePlaceholders})`);
    params.push(...input.types);
  }

  const tokenClauses = tokens.map(() => "(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)").join(" AND ");
  clauses.push(tokenClauses);
  for (const token of tokens) {
    const pattern = `%${token}%`;
    params.push(pattern, pattern);
  }

  params.push(input.topK);

  const rows = db.db
    .prepare(
      `
      SELECT id, title, content, scope, type
      FROM memory_items
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT ?
      `
    )
    .all(...params) as Array<{
    id: string;
    title: string;
    content: string;
    scope: MemoryScope;
    type: MemoryType;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    snippet: row.content.slice(0, 200),
    score: 0.35,
    source: "lex" as const,
    scope: row.scope,
    type: row.type,
    status: "archived",
  }));
}

export async function queryMemories(
  db: DbHandle,
  embedProvider: EmbeddingProvider,
  vectorCollection: VectorCollection,
  input: QueryInput
): Promise<QueryHit[]> {
  const {
    query,
    workspace = "default",
    scopes = ["workspace", "global"],
    types,
    includeSuperseded = false,
    topK = 30,
    minScore = 0.25,
    mode = "hybrid",
  } = input;
  const statuses = includeSuperseded ? ["active", "archived"] : ["active"];

  const fusionOptions: FusionOptions = {
    candidateLimit: 30,
    minScore,
  };

  let lexResults: LexicalHit[] = [];
  let vecResults: VectorSearchHit[] = [];

  if (mode === "hybrid" || mode === "lexical") {
    lexResults = searchLexical(db, {
      query,
      workspace,
      topK,
      scopes: scopes as MemoryScope[],
      types,
      statuses,
    });
  }

  if (mode === "hybrid" || mode === "vector") {
    vecResults = await searchVector(db, embedProvider, vectorCollection, {
      query,
      workspace,
      topK,
      scopes: scopes as MemoryScope[],
      types,
      statuses,
    });
  }

  let results: SearchHit[];

  if (mode === "lexical") {
    results = lexResults;
  } else if (mode === "vector") {
    results = vecResults;
  } else {
    results = rrfFusion(
      lexResults as SearchHit[],
      vecResults as SearchHit[],
      fusionOptions
    );
  }

  if (includeSuperseded) {
    const archivedHits = searchArchivedByKeyword(db, {
      query,
      workspace,
      scopes: scopes as MemoryScope[],
      types,
      topK,
    });
    if (archivedHits.length > 0) {
      const byId = new Map<string, SearchHit>();
      for (const hit of [...results, ...archivedHits]) {
        const existing = byId.get(hit.id);
        if (!existing || hit.score > existing.score) {
          byId.set(hit.id, hit);
        }
      }
      results = [...byId.values()].sort((a, b) => b.score - a.score);
    }
  }

  return results.slice(0, topK).map((r) => ({
    id: r.id,
    title: r.title,
    score: r.score,
    source: r.source,
    snippet: r.snippet,
    scope: r.scope,
    type: r.type,
  }));
}
