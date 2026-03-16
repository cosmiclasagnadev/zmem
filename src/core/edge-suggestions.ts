import type { CoreContext, EdgeSuggestionProvider } from "./context.js";
import { createEdgeRecord } from "./edges.js";
import type {
  CreateEdgeInput,
  EdgeAcceptanceProvenance,
  EdgeOrigin,
  EdgeRelationType,
  EdgeStatus,
  SaveMemoryData,
} from "./types.js";
import { buildEdgeEquivalenceKey, findEquivalentEdgeMatch } from "./edge-rules.js";
import { mapRowToMemoryItem, type MemoryItemRow } from "./utils.js";
import { searchVector } from "../search/vector.js";

export const DEFAULT_EDGE_SUGGESTION_TOP_K = 3;
export const DEFAULT_EDGE_SUGGESTION_SEMANTIC_LIMIT = 6;
export const DEFAULT_EDGE_SUGGESTION_RECENT_LIMIT = 6;
export const DEFAULT_REJECTED_EDGE_CONFIDENCE_DELTA = 0.15;

export const EdgeSuggestionCandidateSourceValues = ["semantic", "recent"] as const;

export type EdgeSuggestionCandidateSource = (typeof EdgeSuggestionCandidateSourceValues)[number];

export interface EdgeSuggestionCandidate {
  memoryId: string;
  title: string;
  content: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  sources: EdgeSuggestionCandidateSource[];
  semanticScore: number | null;
  recencyRank: number | null;
}

export interface SaveEdgeSuggestionCandidatePool {
  semanticCandidates: EdgeSuggestionCandidate[];
  recentCandidates: EdgeSuggestionCandidate[];
  allCandidates: EdgeSuggestionCandidate[];
}

export interface EdgeSuggestionDraft {
  toMemoryId: string;
  relationType: EdgeRelationType;
  confidence?: number;
  evidenceScore?: number;
  origin?: EdgeOrigin;
  status?: EdgeStatus;
  justification?: string;
  acceptedBy?: EdgeAcceptanceProvenance | null;
}

export interface EdgeSuggestionGenerator {
  suggest(args: {
    memoryId: string;
    workspace: string;
    input: SaveMemoryData;
    candidatePool: SaveEdgeSuggestionCandidatePool;
  }): Promise<EdgeSuggestionDraft[]>;
}

export interface SaveEdgeSuggestionPipelineOptions {
  generator: EdgeSuggestionGenerator;
  topK?: number;
  semanticCandidateLimit?: number;
  recentCandidateLimit?: number;
  rejectedConfidenceDelta?: number;
}

export function createHeuristicEdgeSuggestionGenerator(): EdgeSuggestionGenerator {
  return {
    async suggest({ input, candidatePool }) {
      const queryTerms = tokenize(input.title + " " + input.content);
      return candidatePool.allCandidates.slice(0, 6).map((candidate, index) => {
        const candidateTerms = tokenize(candidate.title + " " + candidate.summary + " " + candidate.content);
        const overlap = computeOverlapScore(queryTerms, candidateTerms);
        const semanticScore = candidate.semanticScore ?? 0;
        const recencyBoost = candidate.recencyRank === null ? 0 : Math.max(0, 1 - (candidate.recencyRank - 1) * 0.1);
        const evidenceScore = normalizeScore(0.55 * semanticScore + 0.25 * overlap + 0.2 * recencyBoost - index * 0.02);

        return {
          toMemoryId: candidate.memoryId,
          relationType: "related_to" as const,
          confidence: evidenceScore,
          evidenceScore,
          justification: buildHeuristicJustification(candidate),
        };
      });
    },
  };
}

type ResolvedPipelineOptions = Required<
  Pick<
    SaveEdgeSuggestionPipelineOptions,
    "generator" | "topK" | "semanticCandidateLimit" | "recentCandidateLimit" | "rejectedConfidenceDelta"
  >
>;

type EdgeRow = {
  id: string;
  status: EdgeStatus;
  confidence: number;
};

export function createSaveEdgeSuggestionProvider(
  options: SaveEdgeSuggestionPipelineOptions
): EdgeSuggestionProvider {
  const resolved = resolvePipelineOptions(options);

  return {
    async suggestForSave(args) {
      const candidatePool = await buildSaveEdgeSuggestionCandidatePool(args.ctx, args, resolved);
      const drafts = await resolved.generator.suggest({
        memoryId: args.memoryId,
        workspace: args.workspace,
        input: args.input,
        candidatePool,
      });

      return finalizeSaveEdgeSuggestions(args.ctx, args.memoryId, candidatePool, drafts, resolved);
    },
  };
}

export function persistSuggestedEdgeRecord(ctx: CoreContext, edge: CreateEdgeInput): void {
  const existing = getExistingCanonicalEdge(ctx, edge.fromMemoryId, edge.toMemoryId, edge.relationType);
  if (!existing) {
    createEdgeRecord(ctx, edge);
    return;
  }

  if (existing.status !== "rejected") {
    return;
  }

  ctx.db.db.prepare(`
    UPDATE memory_edges
    SET confidence = ?,
        origin = 'llm',
        status = 'suggested',
        justification = ?,
        accepted_by = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(getConfidence(edge), edge.justification ?? "", new Date().toISOString(), existing.id);
}

export async function buildSaveEdgeSuggestionCandidatePool(
  ctx: CoreContext,
  args: {
    memoryId: string;
    workspace: string;
    input: SaveMemoryData;
  },
  options?: Omit<SaveEdgeSuggestionPipelineOptions, "generator">
): Promise<SaveEdgeSuggestionCandidatePool> {
  const resolved = resolvePipelineOptions({
    generator: { suggest: async () => [] },
    ...options,
  });

  const [semanticCandidates, recentCandidates] = await Promise.all([
    loadSemanticCandidates(ctx, args, resolved.semanticCandidateLimit),
    loadRecentCandidates(ctx, args, resolved.recentCandidateLimit),
  ]);

  return {
    semanticCandidates,
    recentCandidates,
    allCandidates: mergeCandidates(semanticCandidates, recentCandidates),
  };
}

function resolvePipelineOptions(options: SaveEdgeSuggestionPipelineOptions): ResolvedPipelineOptions {
  return {
    generator: options.generator,
    topK: options.topK ?? DEFAULT_EDGE_SUGGESTION_TOP_K,
    semanticCandidateLimit: options.semanticCandidateLimit ?? DEFAULT_EDGE_SUGGESTION_SEMANTIC_LIMIT,
    recentCandidateLimit: options.recentCandidateLimit ?? DEFAULT_EDGE_SUGGESTION_RECENT_LIMIT,
    rejectedConfidenceDelta: options.rejectedConfidenceDelta ?? DEFAULT_REJECTED_EDGE_CONFIDENCE_DELTA,
  };
}

async function loadSemanticCandidates(
  ctx: CoreContext,
  args: { memoryId: string; workspace: string; input: SaveMemoryData },
  limit: number
): Promise<EdgeSuggestionCandidate[]> {
  if (limit <= 0) {
    return [];
  }

  const hits = await searchVector(ctx.db, ctx.embedProvider, ctx.vectorCollection, {
    query: args.input.content,
    workspace: args.workspace,
    topK: limit + 1,
    statuses: ["active"],
  });
  const orderedIds = hits.map((hit) => hit.id).filter((id) => id !== args.memoryId);
  const rowsById = getMemoryRowsById(ctx, args.workspace, orderedIds);
  const seen = new Set<string>();
  const candidates: EdgeSuggestionCandidate[] = [];

  for (const hit of hits) {
    if (hit.id === args.memoryId || seen.has(hit.id)) {
      continue;
    }
    const row = rowsById.get(hit.id);
    if (!row) {
      continue;
    }
    seen.add(hit.id);
    candidates.push(toCandidate(row, {
      semanticScore: hit.score,
      recencyRank: null,
      sources: ["semantic"],
    }));
    if (candidates.length >= limit) {
      break;
    }
  }

  return candidates;
}

async function loadRecentCandidates(
  ctx: CoreContext,
  args: { memoryId: string; workspace: string },
  limit: number
): Promise<EdgeSuggestionCandidate[]> {
  if (limit <= 0) {
    return [];
  }

  const rows = ctx.db.db.prepare(`
    SELECT
      id,
      type,
      title,
      content,
      summary,
      source,
      scope,
      workspace,
      tags,
      importance,
      status,
      supersedes_id,
      content_hash,
      created_at,
      updated_at
    FROM memory_items
    WHERE workspace = ?
      AND status = 'active'
      AND id != ?
    ORDER BY created_at DESC, id ASC
    LIMIT ?
  `).all(args.workspace, args.memoryId, limit) as MemoryItemRow[];

  return rows.map((row, index) =>
    toCandidate(row, {
      semanticScore: null,
      recencyRank: index + 1,
      sources: ["recent"],
    })
  );
}

function getMemoryRowsById(ctx: CoreContext, workspace: string, ids: string[]): Map<string, MemoryItemRow> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = ctx.db.db.prepare(`
    SELECT
      id,
      type,
      title,
      content,
      summary,
      source,
      scope,
      workspace,
      tags,
      importance,
      status,
      supersedes_id,
      content_hash,
      created_at,
      updated_at
    FROM memory_items
    WHERE workspace = ?
      AND status = 'active'
      AND id IN (${placeholders})
  `).all(workspace, ...uniqueIds) as MemoryItemRow[];

  return new Map(rows.map((row) => [row.id, row]));
}

function toCandidate(
  row: MemoryItemRow,
  metadata: {
    semanticScore: number | null;
    recencyRank: number | null;
    sources: EdgeSuggestionCandidateSource[];
  }
): EdgeSuggestionCandidate {
  const memory = mapRowToMemoryItem(row);
  return {
    memoryId: memory.id,
    title: memory.title,
    content: memory.content,
    summary: memory.summary,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    sources: sortSources(metadata.sources),
    semanticScore: metadata.semanticScore,
    recencyRank: metadata.recencyRank,
  };
}

function mergeCandidates(...lists: EdgeSuggestionCandidate[][]): EdgeSuggestionCandidate[] {
  const merged = new Map<string, EdgeSuggestionCandidate>();

  for (const list of lists) {
    for (const candidate of list) {
      const existing = merged.get(candidate.memoryId);
      if (!existing) {
        merged.set(candidate.memoryId, candidate);
        continue;
      }

      merged.set(candidate.memoryId, {
        ...existing,
        sources: sortSources([...existing.sources, ...candidate.sources]),
        semanticScore:
          existing.semanticScore === null && candidate.semanticScore === null
            ? null
            : Math.max(existing.semanticScore ?? 0, candidate.semanticScore ?? 0),
        recencyRank: pickLower(existing.recencyRank, candidate.recencyRank),
      });
    }
  }

  return [...merged.values()].sort((left, right) => compareCandidateStrength(right) - compareCandidateStrength(left) || left.memoryId.localeCompare(right.memoryId));
}

function finalizeSaveEdgeSuggestions(
  ctx: CoreContext,
  memoryId: string,
  candidatePool: SaveEdgeSuggestionCandidatePool,
  drafts: EdgeSuggestionDraft[],
  options: ResolvedPipelineOptions
): CreateEdgeInput[] {
  const allowedCandidates = new Set(candidatePool.allCandidates.map((candidate) => candidate.memoryId));
  const canonical = new Map<string, { edge: CreateEdgeInput; rank: number }>();

  for (const draft of drafts) {
    if (!allowedCandidates.has(draft.toMemoryId) || draft.toMemoryId === memoryId) {
      continue;
    }

    const confidence = normalizeScore(draft.confidence ?? draft.evidenceScore ?? 0.5);
    const edge: CreateEdgeInput = {
      fromMemoryId: memoryId,
      toMemoryId: draft.toMemoryId,
      relationType: draft.relationType,
      confidence,
      origin: "llm",
      status: "suggested",
      justification: draft.justification ?? "",
      acceptedBy: null,
    };
    const rank = draft.evidenceScore ?? confidence;
      const key = toSuggestionKey(edge);
      const existing = canonical.get(key);
      if (!existing || rank > existing.rank) {
        canonical.set(key, { edge, rank });
      }
  }

  return [...canonical.values()]
    .sort((left, right) => right.rank - left.rank || getConfidence(right.edge) - getConfidence(left.edge) || left.edge.toMemoryId.localeCompare(right.edge.toMemoryId) || left.edge.relationType.localeCompare(right.edge.relationType))
    .map((entry) => entry.edge)
    .filter((edge) => shouldSuggestEdge(ctx, edge, options.rejectedConfidenceDelta))
    .slice(0, options.topK);
}

function shouldSuggestEdge(ctx: CoreContext, edge: CreateEdgeInput, rejectedConfidenceDelta: number): boolean {
  const existing = getExistingCanonicalEdge(ctx, edge.fromMemoryId, edge.toMemoryId, edge.relationType);
  if (!existing) {
    return true;
  }

  if (existing.status !== "rejected") {
    return false;
  }

  return getConfidence(edge) >= existing.confidence + rejectedConfidenceDelta;
}

function getExistingCanonicalEdge(
  ctx: CoreContext,
  fromMemoryId: string,
  toMemoryId: string,
  relationType: EdgeRelationType
): EdgeRow | null {
  return findEquivalentEdgeMatch(fromMemoryId, toMemoryId, relationType, (pair) =>
    (ctx.db.db.prepare(`
      SELECT id, status, confidence
      FROM memory_edges
      WHERE from_memory_id = ?
        AND to_memory_id = ?
        AND relation_type = ?
    `).get(pair.fromMemoryId, pair.toMemoryId, relationType) as EdgeRow | undefined) ?? null
  );
}

function toSuggestionKey(edge: CreateEdgeInput): string {
  return buildEdgeEquivalenceKey(edge.fromMemoryId, edge.toMemoryId, edge.relationType);
}

function compareCandidateStrength(candidate: EdgeSuggestionCandidate): number {
  const sourceScore = candidate.sources.length * 10;
  const semanticScore = candidate.semanticScore ?? 0;
  const recencyScore = candidate.recencyRank === null ? 0 : Math.max(0, 1 - (candidate.recencyRank - 1) * 0.1);
  return sourceScore + semanticScore + recencyScore;
}

function sortSources(sources: EdgeSuggestionCandidateSource[]): EdgeSuggestionCandidateSource[] {
  return [...new Set(sources)].sort((left, right) => {
    const leftIndex = EdgeSuggestionCandidateSourceValues.indexOf(left);
    const rightIndex = EdgeSuggestionCandidateSourceValues.indexOf(right);
    return leftIndex - rightIndex;
  });
}

function pickLower(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.min(left, right);
}

function normalizeScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function getConfidence(edge: CreateEdgeInput): number {
  return edge.confidence ?? 0.5;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function computeOverlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right);
  let matches = 0;
  for (const token of new Set(left)) {
    if (rightSet.has(token)) {
      matches += 1;
    }
  }

  return matches / Math.max(new Set(left).size, 1);
}

function buildHeuristicJustification(candidate: EdgeSuggestionCandidate): string {
  if (candidate.sources.length === 2) {
    return "Suggested from semantic similarity and recent memory overlap";
  }

  if (candidate.sources.includes("semantic")) {
    return "Suggested from semantic similarity to existing memory";
  }

  return "Suggested from recent related memory context";
}
