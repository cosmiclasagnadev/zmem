import type { DbHandle } from "../db/index.js";
import type { EmbeddingProvider } from "../embed/types.js";
import type { QueryExpansionConfig } from "../config/schema.js";
import type { QueryExpander } from "./query-expansion.js";
import type { VectorCollection } from "../vectors/index.js";
import type { MemoryScope, MemoryType } from "../types/memory.js";
import { debug } from "../utils/logger.js";
import { searchLexicalChunks, type ChunkLexicalHit } from "./lexical.js";
import { searchVectorChunks, type ChunkVectorHit } from "./vector.js";
import { rrfFusion, type SearchHit, type FusionOptions } from "./fusion.js";
import { buildMemoryRollups, type ChunkCandidateHit, type MemoryRollup, type QueryHit } from "./rollup.js";
import { expandQuery, type QueryExpansionMode, type QueryExpansionTarget } from "./query-expansion.js";
import { createHeuristicMemoryItemReranker } from "./rerank.js";

export {
  buildMemoryRollups,
  rollupChunkHits,
  type ChunkCandidateHit,
  type MemoryRollup,
  type MemoryRollupEvidence,
  type QueryHit,
} from "./rollup.js";

export {
  createHeuristicMemoryItemReranker,
  HeuristicMemoryItemReranker,
  type MemoryItemReranker,
  type MemoryRerankCandidate,
  type MemoryRerankExplanation,
  type MemoryRerankResult,
  type MemoryRerankSignals,
} from "./rerank.js";

export {
  createCachedQueryExpander,
  createDeterministicQueryExpander,
  createOffExpansionPlan,
  type QueryExpander,
  type QueryExpansionPlan,
  type QueryExpansionRequest,
  type QueryExpansionTarget,
  type QueryExpansionVariant,
  type QueryExpansionMode,
} from "./query-expansion.js";

export interface QueryInput {
  query: string;
  workspace?: string;
  scopes?: Array<"workspace" | "global" | "user">;
  types?: MemoryType[];
  includeSuperseded?: boolean;
  topK?: number;
  minScore?: number;
  mode?: "hybrid" | "lexical" | "vector" | "recent" | "important" | "typed";
  expansionMode?: QueryExpansionMode;
  queryExpansionConfig?: QueryExpansionConfig;
}

const GRAPH_TRAVERSAL_DEFAULT_DEPTH = 1;
const GRAPH_INJECTION_LIMIT = 6;
const GRAPH_INJECTION_PER_SEED_LIMIT = 2;
const GRAPH_INJECTION_SEED_WEIGHT = 0.7;
const GRAPH_INJECTION_EDGE_WEIGHT = 0.2;

interface GraphNeighborRow {
  seed_memory_id: string;
  neighbor_id: string;
  relation_type: string;
  confidence: number;
  direction: "outbound" | "inbound";
  title: string;
  content: string;
  summary: string;
  scope: MemoryScope;
  type: MemoryType;
}

interface GraphNeighborCandidate {
  seedMemoryId: string;
  memoryId: string;
  title: string;
  content: string;
  summary: string;
  scope: MemoryScope;
  type: MemoryType;
  edgeConfidence: number;
  relationType: string;
  direction: "outbound" | "inbound";
}

interface ModeMemoryRow {
  id: string;
  title: string;
  content: string;
  summary: string;
  scope: MemoryScope;
  type: MemoryType;
  importance: number;
  created_at: string;
  updated_at: string;
}

function clamp01(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function buildQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function extractSupportSnippet(content: string, summary: string, query: string): string {
  if (summary.trim().length > 0) {
    return summary.slice(0, 200);
  }

  const normalizedContent = content.trim();
  if (normalizedContent.length === 0) {
    return "";
  }

  const terms = buildQueryTerms(query);
  const lowerContent = normalizedContent.toLowerCase();
  for (const term of terms) {
    const index = lowerContent.indexOf(term);
    if (index === -1) continue;
    const start = Math.max(0, index - 60);
    const end = Math.min(normalizedContent.length, index + 160);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < normalizedContent.length ? "..." : "";
    return `${prefix}${normalizedContent.slice(start, end)}${suffix}`;
  }

  const fallback = normalizedContent.slice(0, 200);
  return normalizedContent.length > 200 ? `${fallback}...` : fallback;
}

function sortByTimestampDesc(a: ModeMemoryRow, b: ModeMemoryRow): number {
  const aUpdated = Date.parse(a.updated_at || "");
  const bUpdated = Date.parse(b.updated_at || "");
  const safeUpdatedA = Number.isFinite(aUpdated) ? aUpdated : 0;
  const safeUpdatedB = Number.isFinite(bUpdated) ? bUpdated : 0;
  if (safeUpdatedB !== safeUpdatedA) {
    return safeUpdatedB - safeUpdatedA;
  }

  const aCreated = Date.parse(a.created_at || "");
  const bCreated = Date.parse(b.created_at || "");
  const safeCreatedA = Number.isFinite(aCreated) ? aCreated : 0;
  const safeCreatedB = Number.isFinite(bCreated) ? bCreated : 0;
  if (safeCreatedB !== safeCreatedA) {
    return safeCreatedB - safeCreatedA;
  }

  return a.id.localeCompare(b.id);
}

function getNormalizedRecencyById(rows: ModeMemoryRow[]): Map<string, number> {
  const timestamps = rows.map((row) => {
    const timestamp = Date.parse(row.updated_at || row.created_at);
    return Number.isFinite(timestamp) ? timestamp : 0;
  });
  const minTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : minTimestamp;
  const span = Math.max(1, maxTimestamp - minTimestamp);
  return new Map(
    rows.map((row) => {
      const timestamp = Date.parse(row.updated_at || row.created_at);
      const safeTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
      return [row.id, clamp01((safeTimestamp - minTimestamp) / span)];
    })
  );
}

function hasRelationalIntent(query: string): boolean {
  const normalized = query.toLowerCase().trim();
  const phraseMatchers = [
    "what changed",
    "why did we choose",
    "why did we decide",
    "related context",
    "what happened before",
    "what happened after",
  ];
  if (phraseMatchers.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  const terms = new Set(buildQueryTerms(query));
  const signalTerms = [
    "change",
    "changed",
    "history",
    "historical",
    "why",
    "choose",
    "chose",
    "decision",
    "decide",
    "related",
    "context",
    "previous",
    "prior",
    "because",
    "timeline",
  ];
  return signalTerms.some((term) => terms.has(term));
}

function buildScopedFilter(
  alias: string,
  scopes?: MemoryScope[],
  types?: MemoryType[]
): { clause: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];

  if (scopes && scopes.length > 0) {
    conditions.push(`${alias}.scope IN (${scopes.map(() => "?").join(", ")})`);
    params.push(...scopes);
  }

  if (types && types.length > 0) {
    conditions.push(`${alias}.type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }

  return {
    clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

function loadModeMemoryRows(args: {
  db: DbHandle;
  workspace: string;
  scopes?: MemoryScope[];
  types?: MemoryType[];
  statuses: string[];
  topK: number;
  mode: "recent" | "important" | "typed";
}): ModeMemoryRow[] {
  const statusPlaceholders = args.statuses.map(() => "?").join(", ");
  const filter = buildScopedFilter("m", args.scopes, args.types);
  const orderBy = args.mode === "recent"
    ? "m.updated_at DESC, m.created_at DESC, m.id ASC"
    : "m.importance DESC, m.updated_at DESC, m.created_at DESC, m.id ASC";
  const candidateLimit = args.mode === "recent"
    ? args.topK
    : Math.min(Math.max(args.topK * 5, 50), 200);
  const sql = `
    SELECT
      m.id,
      m.title,
      m.content,
      m.summary,
      m.scope,
      m.type,
      m.importance,
      m.created_at,
      m.updated_at
    FROM memory_items m
    WHERE m.workspace = ?
      AND m.status IN (${statusPlaceholders})
      ${filter.clause}
    ORDER BY ${orderBy}
    LIMIT ?
  `;

  return args.db.db.prepare(sql).all(
    args.workspace,
    ...args.statuses,
    ...filter.params,
    candidateLimit
  ) as ModeMemoryRow[];
}

function loadAcceptedManualCentrality(args: {
  db: DbHandle;
  workspace: string;
  candidateIds: string[];
  statuses: string[];
}): Map<string, number> {
  const uniqueIds = [...new Set(args.candidateIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const candidatePlaceholders = uniqueIds.map(() => "?").join(", ");
  const statusPlaceholders = args.statuses.map(() => "?").join(", ");
  const sql = `
    SELECT candidate_id, COUNT(*) AS edge_count
    FROM (
      SELECT e.from_memory_id AS candidate_id
      FROM memory_edges e
      INNER JOIN memory_items neighbor ON neighbor.id = e.to_memory_id
      WHERE e.from_memory_id IN (${candidatePlaceholders})
        AND e.origin = 'manual'
        AND e.status = 'accepted'
        AND neighbor.workspace = ?
        AND neighbor.status IN (${statusPlaceholders})
      UNION ALL
      SELECT e.to_memory_id AS candidate_id
      FROM memory_edges e
      INNER JOIN memory_items neighbor ON neighbor.id = e.from_memory_id
      WHERE e.to_memory_id IN (${candidatePlaceholders})
        AND e.origin = 'manual'
        AND e.status = 'accepted'
        AND neighbor.workspace = ?
        AND neighbor.status IN (${statusPlaceholders})
    ) counts
    GROUP BY candidate_id
  `;
  const rows = args.db.db.prepare(sql).all(
    ...uniqueIds,
    args.workspace,
    ...args.statuses,
    ...uniqueIds,
    args.workspace,
    ...args.statuses
  ) as Array<{ candidate_id: string; edge_count: number }>;

  return new Map(rows.map((row) => [row.candidate_id, row.edge_count]));
}

function queryByRecency(args: {
  db: DbHandle;
  workspace: string;
  scopes?: MemoryScope[];
  types?: MemoryType[];
  statuses: string[];
  topK: number;
  query: string;
}): QueryHit[] {
  const rows = loadModeMemoryRows({
    db: args.db,
    workspace: args.workspace,
    scopes: args.scopes,
    types: args.types,
    statuses: args.statuses,
    topK: args.topK,
    mode: "recent",
  }).sort(sortByTimestampDesc);

  return rows.slice(0, args.topK).map((row, index) => ({
    id: row.id,
    title: row.title,
    score: clamp01(1 - index * 0.01),
    source: "hybrid" as const,
    snippet: extractSupportSnippet(row.content, row.summary, args.query),
    scope: row.scope,
    type: row.type,
  }));
}

function queryByImportance(args: {
  db: DbHandle;
  workspace: string;
  scopes?: MemoryScope[];
  types?: MemoryType[];
  statuses: string[];
  topK: number;
  query: string;
  mode: "important" | "typed";
}): QueryHit[] {
  const rows = loadModeMemoryRows({
    db: args.db,
    workspace: args.workspace,
    scopes: args.scopes,
    types: args.types,
    statuses: args.statuses,
    topK: args.topK,
    mode: args.mode,
  });
  const recencyById = getNormalizedRecencyById(rows);
  const centralityCounts = loadAcceptedManualCentrality({
    db: args.db,
    workspace: args.workspace,
    candidateIds: rows.map((row) => row.id),
    statuses: args.statuses,
  });
  const maxCentrality = Math.max(1, ...centralityCounts.values());

  return rows
    .map((row) => {
      const centralityScore = clamp01((centralityCounts.get(row.id) ?? 0) / maxCentrality);
      const recencyScore = recencyById.get(row.id) ?? 0;
      return {
        id: row.id,
        title: row.title,
        score: clamp01(row.importance * 0.82 + centralityScore * 0.1 + recencyScore * 0.08),
        source: "hybrid" as const,
        snippet: extractSupportSnippet(row.content, row.summary, args.query),
        scope: row.scope,
        type: row.type,
        _importance: row.importance,
        _centrality: centralityScore,
        _recency: recencyScore,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b._importance !== a._importance) return b._importance - a._importance;
      if (b._centrality !== a._centrality) return b._centrality - a._centrality;
      if (b._recency !== a._recency) return b._recency - a._recency;
      return a.id.localeCompare(b.id);
    })
    .slice(0, args.topK)
    .map(({ _importance, _centrality, _recency, ...hit }) => hit);
}

function loadGraphNeighbors(args: {
  db: DbHandle;
  workspace: string;
  seedIds: string[];
  scopes?: MemoryScope[];
  types?: MemoryType[];
  statuses: string[];
  depth?: number;
}): GraphNeighborCandidate[] {
  const uniqueSeedIds = [...new Set(args.seedIds)];
  if (uniqueSeedIds.length === 0) {
    return [];
  }

  const depth = args.depth ?? GRAPH_TRAVERSAL_DEFAULT_DEPTH;
  if (depth !== 1) {
    throw new Error(`Graph expansion only supports depth ${GRAPH_TRAVERSAL_DEFAULT_DEPTH} in v1`);
  }

  const seedPlaceholders = uniqueSeedIds.map(() => "?").join(", ");
  const statusPlaceholders = args.statuses.map(() => "?").join(", ");
  const memoryFilter = buildScopedFilter("neighbor", args.scopes, args.types);

  const sql = `
    SELECT
      e.from_memory_id AS seed_memory_id,
      e.to_memory_id AS neighbor_id,
      e.relation_type,
      e.confidence,
      'outbound' AS direction,
      neighbor.title,
      neighbor.content,
      neighbor.summary,
      neighbor.scope,
      neighbor.type
    FROM memory_edges e
    INNER JOIN memory_items seed ON seed.id = e.from_memory_id
    INNER JOIN memory_items neighbor ON neighbor.id = e.to_memory_id
    WHERE e.from_memory_id IN (${seedPlaceholders})
      AND e.origin = 'manual'
      AND e.status = 'accepted'
      AND seed.workspace = ?
      AND neighbor.workspace = ?
      AND seed.status IN (${statusPlaceholders})
      AND neighbor.status IN (${statusPlaceholders})
      ${memoryFilter.clause}
    UNION ALL
    SELECT
      e.to_memory_id AS seed_memory_id,
      e.from_memory_id AS neighbor_id,
      e.relation_type,
      e.confidence,
      'inbound' AS direction,
      neighbor.title,
      neighbor.content,
      neighbor.summary,
      neighbor.scope,
      neighbor.type
    FROM memory_edges e
    INNER JOIN memory_items seed ON seed.id = e.to_memory_id
    INNER JOIN memory_items neighbor ON neighbor.id = e.from_memory_id
    WHERE e.to_memory_id IN (${seedPlaceholders})
      AND e.origin = 'manual'
      AND e.status = 'accepted'
      AND seed.workspace = ?
      AND neighbor.workspace = ?
      AND seed.status IN (${statusPlaceholders})
      AND neighbor.status IN (${statusPlaceholders})
      ${memoryFilter.clause}
  `;

  const params = [
    ...uniqueSeedIds,
    args.workspace,
    args.workspace,
    ...args.statuses,
    ...args.statuses,
    ...memoryFilter.params,
    ...uniqueSeedIds,
    args.workspace,
    args.workspace,
    ...args.statuses,
    ...args.statuses,
    ...memoryFilter.params,
  ];

  const rows = args.db.db.prepare(sql).all(...params) as GraphNeighborRow[];
  return rows.map((row) => ({
    seedMemoryId: row.seed_memory_id,
    memoryId: row.neighbor_id,
    title: row.title,
    content: row.content,
    summary: row.summary,
    scope: row.scope,
    type: row.type,
    edgeConfidence: row.confidence,
    relationType: row.relation_type,
    direction: row.direction,
  }));
}

function applyGraphExpansion(args: {
  db: DbHandle;
  workspace: string;
  query: string;
  scopes?: MemoryScope[];
  types?: MemoryType[];
  statuses: string[];
  rollups: MemoryRollup[];
  topK: number;
}): QueryHit[] {
  if (args.rollups.length === 0) {
    return [];
  }

  const seedIds = args.rollups.map((rollup) => rollup.memoryId);
  const neighbors = loadGraphNeighbors({
    db: args.db,
    workspace: args.workspace,
    seedIds,
    scopes: args.scopes,
    types: args.types,
    statuses: args.statuses,
    depth: GRAPH_TRAVERSAL_DEFAULT_DEPTH,
  });

  const boosted = args.rollups.map((rollup) => {
    return {
      id: rollup.memoryId,
      title: rollup.title,
      score: clamp01(rollup.score),
      source: rollup.source,
      snippet: rollup.snippet,
      scope: rollup.scope,
      type: rollup.type,
    } satisfies QueryHit;
  });

  if (!hasRelationalIntent(args.query)) {
    return boosted;
  }

  const existingIds = new Set(boosted.map((rollup) => rollup.id));
  const seedScoreById = new Map(args.rollups.map((rollup) => [rollup.memoryId, rollup.score]));
  const injectedById = new Map<string, QueryHit>();
  const perSeedCounts = new Map<string, number>();

  for (const neighbor of neighbors) {
    if (existingIds.has(neighbor.memoryId)) {
      continue;
    }

    const seedCount = perSeedCounts.get(neighbor.seedMemoryId) ?? 0;
    if (seedCount >= GRAPH_INJECTION_PER_SEED_LIMIT) {
      continue;
    }

    const seedScore = seedScoreById.get(neighbor.seedMemoryId) ?? 0;
    const score = clamp01(seedScore * GRAPH_INJECTION_SEED_WEIGHT + neighbor.edgeConfidence * GRAPH_INJECTION_EDGE_WEIGHT);
    const candidate: QueryHit = {
      id: neighbor.memoryId,
      title: neighbor.title,
      score,
      source: "hybrid",
      snippet: extractSupportSnippet(neighbor.content, neighbor.summary, args.query),
      scope: neighbor.scope,
      type: neighbor.type,
    };

    const existing = injectedById.get(candidate.id);
    if (!existing || candidate.score > existing.score) {
      injectedById.set(candidate.id, candidate);
    }
    perSeedCounts.set(neighbor.seedMemoryId, seedCount + 1);
  }

  const injected = [...injectedById.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    })
    .slice(0, GRAPH_INJECTION_LIMIT);

  return [...boosted, ...injected]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    });
}

export async function queryMemories(
  db: DbHandle,
  embedProvider: EmbeddingProvider,
  vectorCollection: VectorCollection,
  input: QueryInput,
  queryExpander?: QueryExpander
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
    expansionMode,
    queryExpansionConfig,
  } = input;
  const statuses = includeSuperseded ? ["active", "archived"] : ["active"];
  const effectiveExpansionMode = expansionMode ?? (queryExpansionConfig?.enabled === false ? "off" : "llm");

  if (mode === "recent") {
    return queryByRecency({
      db,
      workspace,
      scopes: scopes as MemoryScope[],
      types,
      statuses,
      topK,
      query,
    });
  }

  if ((mode === "important" || mode === "typed") && query.trim().length === 0) {
    return queryByImportance({
      db,
      workspace,
      scopes: scopes as MemoryScope[],
      types,
      statuses,
      topK,
      query,
      mode,
    });
  }

  const fusionOptions: FusionOptions = {
    candidateLimit: 30,
    minScore,
  };

  const shouldAttemptStrongSignalBypass =
    queryExpansionConfig?.strongSignalBypass !== false &&
    effectiveExpansionMode === "llm" &&
    (mode === "hybrid" || mode === "important" || mode === "typed") &&
    query.trim().length > 0 &&
    !hasRelationalIntent(query);

  const initialLexicalProbe = shouldAttemptStrongSignalBypass
    ? searchLexicalChunks(db, {
        query,
        workspace,
        topK: 5,
        scopes: scopes as MemoryScope[],
        types,
        statuses,
      })
    : [];

  const topProbeScore = initialLexicalProbe[0]?.score ?? 0;
  const secondProbeScore = initialLexicalProbe[1]?.score ?? 0;
  const shouldBypassExpansion =
    shouldAttemptStrongSignalBypass &&
    topProbeScore >= (queryExpansionConfig?.strongSignalMinScore ?? 0.72) &&
    topProbeScore - secondProbeScore >= (queryExpansionConfig?.strongSignalMinGap ?? 0.12);

  const expansionPlan = shouldBypassExpansion
    ? await expandQuery(query, "off", queryExpander, {
        maxExpansions: queryExpansionConfig?.maxExpansions,
        includeLexical: queryExpansionConfig?.includeLexical,
        workspace,
      })
    : await expandQuery(query, effectiveExpansionMode, queryExpander, {
        maxExpansions: queryExpansionConfig?.maxExpansions,
        includeLexical: queryExpansionConfig?.includeLexical,
        workspace,
      });
  debug(() =>
    `[QueryExpansion] mode=${expansionPlan.mode} variants=${expansionPlan.variants
      .map((variant) => `${variant.label}=>${variant.query}`)
      .join(" | ")}`
  );

  let lexResults: ChunkLexicalHit[] = [];
  let vecResults: ChunkVectorHit[] = [];
  const runLexical = mode === "hybrid" || mode === "lexical" || mode === "important" || mode === "typed";
  const runVector = mode === "hybrid" || mode === "vector" || mode === "important" || mode === "typed";

  const shouldRunLexicalForTarget = (target: QueryExpansionTarget): boolean => target === "both" || target === "lex";
  const shouldRunVectorForTarget = (target: QueryExpansionTarget): boolean => target === "both" || target === "vec";

  for (const variant of expansionPlan.variants) {
    if (runLexical && shouldRunLexicalForTarget(variant.target)) {
      const variantHits = searchLexicalChunks(db, {
        query: variant.query,
        workspace,
        topK,
        scopes: scopes as MemoryScope[],
        types,
        statuses,
      }).map((hit) => ({ ...hit, score: clamp01(hit.score * variant.weight) }));
      lexResults.push(...variantHits);
    }

    if (runVector && shouldRunVectorForTarget(variant.target)) {
      const variantHits = (await searchVectorChunks(db, embedProvider, vectorCollection, {
        query: variant.query,
        workspace,
        topK,
        scopes: scopes as MemoryScope[],
        types,
        statuses,
      })).map((hit) => ({ ...hit, score: clamp01(hit.score * variant.weight) }));
      vecResults.push(...variantHits);
    }
  }

  lexResults.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  vecResults.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  let results: ChunkCandidateHit[];

  if (mode === "lexical") {
    results = lexResults as ChunkCandidateHit[];
  } else if (mode === "vector") {
    results = vecResults as ChunkCandidateHit[];
  } else {
    results = rrfFusion(
      lexResults as SearchHit[],
      vecResults as SearchHit[],
      fusionOptions
    ) as ChunkCandidateHit[];
  }

  const rollups = buildMemoryRollups(results);
  const candidatePool = applyGraphExpansion({
    db,
    workspace,
    query,
    scopes: scopes as MemoryScope[],
    types,
    statuses,
    rollups,
    topK,
  });
  const reranker = createHeuristicMemoryItemReranker();
  return reranker.rerank({
    db,
    workspace,
    query,
    topK,
    candidates: candidatePool,
    rollupsById: new Map(rollups.map((rollup) => [rollup.memoryId, rollup])),
    mode: mode === "important" ? "important" : "default",
  });
}
