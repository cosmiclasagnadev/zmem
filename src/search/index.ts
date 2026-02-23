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

function getSupersededIds(
  db: DbHandle,
  includeSuperseded: boolean
): Set<string> {
  if (includeSuperseded) {
    return new Set();
  }

  const rows = db.db
    .prepare(
      `
    SELECT m.id FROM memory_items m
    WHERE m.status = 'active'
    AND m.supersedes_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM memory_items r
      WHERE r.id = m.supersedes_id AND r.status = 'active'
    )
  `
    )
    .all() as { id: string }[];

  return new Set(rows.map((r) => r.id));
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

  const supersededIds = getSupersededIds(db, includeSuperseded);

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
      status: "active",
    });
  }

  if (mode === "hybrid" || mode === "vector") {
    vecResults = await searchVector(db, embedProvider, vectorCollection, {
      query,
      workspace,
      topK,
      scopes: scopes as MemoryScope[],
      types,
      status: "active",
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

  const filtered = results.filter((r) => !supersededIds.has(r.id));

  return filtered.slice(0, topK).map((r) => ({
    id: r.id,
    title: r.title,
    score: r.score,
    source: r.source,
    snippet: r.snippet,
    scope: r.scope,
    type: r.type,
  }));
}
