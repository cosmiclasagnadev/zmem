import type { DbHandle } from "../db/index.js";
import type { MemoryScope, MemoryType } from "../types/memory.js";
import type { MemoryRollup, QueryHit } from "./rollup.js";

const CHUNK_EVIDENCE_WEIGHT = 0.7;
const METADATA_WEIGHT = 0.1;
const RECENCY_WEIGHT = 0.05;
const IMPORTANCE_WEIGHT = 0.06;
const LINEAGE_WEIGHT = 0.12;
const GRAPH_WEIGHT = 0.14;
const SEED_COUNT = 3;

type RerankProfile = "default" | "important";

type GraphEdgeStatus = "accepted" | "suggested" | "rejected";
type GraphEdgeOrigin = "manual" | "llm";

type CandidateMetadataRow = {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string;
  importance: number;
  status: "pending" | "active" | "archived" | "deleted";
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
  scope: MemoryScope;
  type: MemoryType;
};

type GraphEdgeRow = {
  from_memory_id: string;
  to_memory_id: string;
  relation_type: string;
  confidence: number;
  origin: GraphEdgeOrigin;
  status: GraphEdgeStatus;
};

interface CandidateMetadata {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  importance: number;
  status: "pending" | "active" | "archived" | "deleted";
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
  scope: MemoryScope;
  type: MemoryType;
}

interface GraphSignalDetail {
  seedId: string;
  seedTitle: string;
  relationType: string;
  status: GraphEdgeStatus;
  origin: GraphEdgeOrigin;
  confidence: number;
}

export interface MemoryRerankSignals {
  chunkEvidence: number;
  metadata: number;
  recency: number;
  importance: number;
  lineage: number;
  graph: number;
}

export interface MemoryRerankExplanation {
  text: string;
  appliedSignals: string[];
}

export interface MemoryRerankCandidate extends QueryHit {
  explanation?: string;
}

export interface MemoryRerankResult extends MemoryRerankCandidate {
  signals: MemoryRerankSignals;
}

export interface MemoryItemReranker {
  rerank(args: {
    db: DbHandle;
    workspace: string;
    query: string;
    topK: number;
    candidates: QueryHit[];
    rollupsById?: Map<string, MemoryRollup>;
    mode?: RerankProfile;
  }): MemoryRerankResult[];
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

function hasHistoryIntent(query: string): boolean {
  const normalized = query.toLowerCase();
  return ["what changed", "history", "previous", "prior", "before", "after", "timeline"].some((term) =>
    normalized.includes(term)
  );
}

function hasDecisionIntent(query: string): boolean {
  const normalized = query.toLowerCase();
  return ["why did we choose", "why did we decide", "decision", "rationale", "tradeoff", "because"].some((term) =>
    normalized.includes(term)
  );
}

function normalizeTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function scoreOverlap(terms: string[], text: string): { score: number; matches: string[] } {
  if (terms.length === 0 || text.trim().length === 0) {
    return { score: 0, matches: [] };
  }

  const lower = text.toLowerCase();
  const matches = [...new Set(terms.filter((term) => lower.includes(term)))];
  return {
    score: matches.length === 0 ? 0 : matches.length / terms.length,
    matches,
  };
}

function relationBonus(relationType: string, query: string): number {
  if (hasHistoryIntent(query) && (relationType === "derived_from" || relationType === "caused_by")) {
    return 0.02;
  }

  if (hasDecisionIntent(query) && (relationType === "supports" || relationType === "contradicts")) {
    return 0.02;
  }

  if (relationType === "related_to") {
    return 0.01;
  }

  return 0;
}

function graphEdgeWeight(edge: GraphEdgeRow, query: string): number {
  if (edge.status === "rejected") {
    return 0;
  }

  const base = edge.status === "accepted"
    ? edge.origin === "manual"
      ? 0.1
      : 0.075
    : edge.origin === "manual"
      ? 0.05
      : 0.035;
  return clamp01(base * edge.confidence + relationBonus(edge.relation_type, query));
}

function loadCandidateMetadata(db: DbHandle, workspace: string, ids: string[]): Map<string, CandidateMetadata> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db.db
    .prepare(
      `
        SELECT id, title, summary, content, tags, importance, status, supersedes_id, created_at, updated_at, scope, type
        FROM memory_items
        WHERE workspace = ?
          AND id IN (${placeholders})
      `
    )
    .all(workspace, ...uniqueIds) as CandidateMetadataRow[];

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        title: row.title,
        summary: row.summary,
        content: row.content,
        tags: normalizeTags(row.tags),
        importance: row.importance,
        status: row.status,
        supersedesId: row.supersedes_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        scope: row.scope,
        type: row.type,
      } satisfies CandidateMetadata,
    ])
  );
}

function loadGraphEdges(db: DbHandle, seedIds: string[], candidateIds: string[]): GraphEdgeRow[] {
  const uniqueSeedIds = [...new Set(seedIds)];
  const uniqueCandidateIds = [...new Set(candidateIds)];
  if (uniqueSeedIds.length === 0 || uniqueCandidateIds.length === 0) {
    return [];
  }

  const seedPlaceholders = uniqueSeedIds.map(() => "?").join(", ");
  const candidatePlaceholders = uniqueCandidateIds.map(() => "?").join(", ");
  return db.db
    .prepare(
      `
        SELECT from_memory_id, to_memory_id, relation_type, confidence, origin, status
        FROM memory_edges
        WHERE status IN ('accepted', 'suggested')
          AND (
            (from_memory_id IN (${seedPlaceholders}) AND to_memory_id IN (${candidatePlaceholders}))
            OR
            (to_memory_id IN (${seedPlaceholders}) AND from_memory_id IN (${candidatePlaceholders}))
          )
      `
    )
    .all(...uniqueSeedIds, ...uniqueCandidateIds, ...uniqueSeedIds, ...uniqueCandidateIds) as GraphEdgeRow[];
}

function buildExplanation(args: {
  signals: MemoryRerankSignals;
  titleMatches: string[];
  tagMatches: string[];
  metadata: CandidateMetadata;
  graphDetails: GraphSignalDetail[];
  lineageSeedTitles: string[];
}): MemoryRerankExplanation {
  const appliedSignals: string[] = [];

  if (args.signals.chunkEvidence >= 0.45) {
    appliedSignals.push("strong chunk evidence");
  } else if (args.signals.chunkEvidence >= 0.25) {
    appliedSignals.push("relevant chunk evidence");
  }

  if (args.titleMatches.length > 0 || args.tagMatches.length > 0) {
    const matched = [...args.titleMatches, ...args.tagMatches].slice(0, 3).join(", ");
    appliedSignals.push(`metadata match for ${matched}`);
  }

  if (args.signals.lineage > 0 && args.lineageSeedTitles.length > 0) {
    appliedSignals.push(`same history chain as ${args.lineageSeedTitles.slice(0, 2).join(", ")}`);
  }

  const acceptedManualLinks = args.graphDetails
    .filter((detail) => detail.status === "accepted" && detail.origin === "manual")
    .map((detail) => detail.seedTitle);
  const acceptedLinks = args.graphDetails
    .filter((detail) => detail.status === "accepted" && detail.origin !== "manual")
    .map((detail) => detail.seedTitle);
  const suggestedLinks = args.graphDetails
    .filter((detail) => detail.status === "suggested")
    .map((detail) => detail.seedTitle);

  if (acceptedManualLinks.length > 0) {
    appliedSignals.push(`accepted manual link to ${[...new Set(acceptedManualLinks)].slice(0, 2).join(", ")}`);
  } else if (acceptedLinks.length > 0) {
    appliedSignals.push(`accepted link to ${[...new Set(acceptedLinks)].slice(0, 2).join(", ")}`);
  } else if (suggestedLinks.length > 0) {
    appliedSignals.push(`suggested link to ${[...new Set(suggestedLinks)].slice(0, 2).join(", ")}`);
  }

  if (args.signals.recency >= 0.04) {
    appliedSignals.push("recent memory");
  }

  if (args.metadata.importance >= 0.75 && args.signals.importance > 0) {
    appliedSignals.push("high-importance item");
  }

  if (appliedSignals.length === 0) {
    appliedSignals.push("baseline chunk match");
  }

  // TODO: Story 10/11 may optionally swap this for LLM-generated explanations.
  return {
    text: appliedSignals.join("; "),
    appliedSignals,
  };
}

export class HeuristicMemoryItemReranker implements MemoryItemReranker {
  rerank(args: {
    db: DbHandle;
    workspace: string;
    query: string;
    topK: number;
    candidates: QueryHit[];
    rollupsById?: Map<string, MemoryRollup>;
    mode?: RerankProfile;
  }): MemoryRerankResult[] {
    if (args.candidates.length === 0) {
      return [];
    }

    const rollupsById = args.rollupsById ?? new Map<string, MemoryRollup>();
    const queryTerms = buildQueryTerms(args.query);
    const historyIntent = hasHistoryIntent(args.query);
    const decisionIntent = hasDecisionIntent(args.query);
    const profile = args.mode ?? "default";
    const chunkEvidenceWeight = profile === "important" ? 0.52 : CHUNK_EVIDENCE_WEIGHT;
    const metadataWeight = profile === "important" ? 0.08 : METADATA_WEIGHT;
    const recencyWeight = profile === "important" ? 0.08 : RECENCY_WEIGHT;
    const importanceWeight = profile === "important" ? 0.18 : IMPORTANCE_WEIGHT;
    const lineageWeight = profile === "important" ? 0.1 : LINEAGE_WEIGHT;
    const graphWeight = profile === "important" ? 0.16 : GRAPH_WEIGHT;
    const seedIds = args.candidates.slice(0, SEED_COUNT).map((candidate) => candidate.id);
    const candidateIds = args.candidates.map((candidate) => candidate.id);
    const metadataById = loadCandidateMetadata(args.db, args.workspace, candidateIds);
    const seedMetadataById = loadCandidateMetadata(args.db, args.workspace, seedIds);
    const graphEdges = loadGraphEdges(args.db, seedIds, candidateIds);

    const graphDetailsByCandidateId = new Map<string, GraphSignalDetail[]>();
    const seedAcceptedNeighborCounts = new Map<string, number>();
    for (const edge of graphEdges) {
      const candidateId = seedIds.includes(edge.from_memory_id) ? edge.to_memory_id : edge.from_memory_id;
      const seedId = candidateId === edge.from_memory_id ? edge.to_memory_id : edge.from_memory_id;
      const seedTitle = seedMetadataById.get(seedId)?.title ?? seedId;
      const existing = graphDetailsByCandidateId.get(candidateId) ?? [];
      existing.push({
        seedId,
        seedTitle,
        relationType: edge.relation_type,
        status: edge.status,
        origin: edge.origin,
        confidence: edge.confidence,
      });
      graphDetailsByCandidateId.set(candidateId, existing);

      if (edge.status === "accepted" && edge.origin === "manual") {
        seedAcceptedNeighborCounts.set(seedId, (seedAcceptedNeighborCounts.get(seedId) ?? 0) + 1);
      }
    }

    const timestamps = [...metadataById.values()].map((metadata) => Date.parse(metadata.updatedAt || metadata.createdAt)).filter(Number.isFinite);
    const minTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
    const maxTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : minTimestamp;
    const timestampSpan = Math.max(1, maxTimestamp - minTimestamp);

    return args.candidates
      .map((candidate, index) => {
        const metadata = metadataById.get(candidate.id) ?? {
          id: candidate.id,
          title: candidate.title,
          summary: "",
          content: candidate.snippet,
          tags: [],
          importance: 0.5,
          status: "active",
          supersedesId: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          scope: candidate.scope,
          type: candidate.type,
        } satisfies CandidateMetadata;
        const rollup = rollupsById.get(candidate.id);
        const titleOverlap = scoreOverlap(queryTerms, metadata.title);
        const summaryOverlap = scoreOverlap(queryTerms, metadata.summary || metadata.content);
        const tagOverlap = scoreOverlap(queryTerms, metadata.tags.join(" "));
        const metadataScore = clamp01(
          titleOverlap.score * metadataWeight * 0.6 +
            summaryOverlap.score * metadataWeight * 0.25 +
            tagOverlap.score * metadataWeight * 0.3 +
            (decisionIntent && metadata.type === "decision" ? metadataWeight * 0.2 : 0) +
            (historyIntent && (metadata.type === "event" || metadata.type === "decision") ? metadataWeight * 0.2 : 0)
        );

        const timestamp = Date.parse(metadata.updatedAt || metadata.createdAt);
        const recencyScore = Number.isFinite(timestamp)
          ? clamp01(((timestamp - minTimestamp) / timestampSpan) * recencyWeight)
          : 0;
        const importanceScore = clamp01(metadata.importance * importanceWeight);

        const lineageSeedTitles = seedIds
          .filter((seedId) => {
            const seedMetadata = seedMetadataById.get(seedId);
            if (!seedMetadata || seedId === candidate.id) {
              return false;
            }
            return metadata.supersedesId === seedId || seedMetadata.supersedesId === candidate.id;
          })
          .map((seedId) => seedMetadataById.get(seedId)?.title ?? seedId);
        const lineageScore = lineageSeedTitles.length === 0
          ? 0
          : clamp01(
              (historyIntent ? lineageWeight : lineageWeight * 0.55) +
                (metadata.status === "archived" && historyIntent ? 0.03 : 0)
            );

        const graphDetails = graphDetailsByCandidateId.get(candidate.id) ?? [];
        const graphScore = clamp01(
          Math.min(
            graphWeight,
            graphDetails.reduce((sum, detail) => {
              const edgeScore = graphEdgeWeight(
                {
                  from_memory_id: detail.seedId,
                  to_memory_id: candidate.id,
                  relation_type: detail.relationType,
                  confidence: detail.confidence,
                  origin: detail.origin,
                  status: detail.status,
                },
                args.query
              );
              return sum + edgeScore;
            }, 0) + (seedAcceptedNeighborCounts.get(candidate.id) ?? 0) * 0.03
          )
        );

        const chunkEvidenceScore = clamp01(
          rollup
            ? rollup.score * 0.6 +
                rollup.evidence.bestHitScore * 0.06 +
                rollup.evidence.multiChunkSupport * 0.025 +
                rollup.evidence.chunkDiversity * 0.015
            : candidate.score * 0.5
        );

        const signals: MemoryRerankSignals = {
          chunkEvidence: clamp01(chunkEvidenceScore * chunkEvidenceWeight),
          metadata: metadataScore,
          recency: recencyScore,
          importance: importanceScore,
          lineage: lineageScore,
          graph: graphScore,
        };
        const explanation = buildExplanation({
          signals,
          titleMatches: titleOverlap.matches,
          tagMatches: tagOverlap.matches,
          metadata,
          graphDetails,
          lineageSeedTitles,
        });

        return {
          ...candidate,
          title: metadata.title,
          snippet: candidate.snippet,
          explanation: explanation.text,
          score: clamp01(
            signals.chunkEvidence +
              signals.metadata +
              signals.recency +
              signals.importance +
              signals.lineage +
              signals.graph
          ),
          signals,
          _originalRank: index,
        } as MemoryRerankResult & { _originalRank: number };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.signals.graph !== a.signals.graph) return b.signals.graph - a.signals.graph;
        if (b.signals.lineage !== a.signals.lineage) return b.signals.lineage - a.signals.lineage;
        return a._originalRank - b._originalRank;
      })
      .slice(0, args.topK)
      .map(({ _originalRank, ...candidate }) => candidate);
  }
}

export function createHeuristicMemoryItemReranker(): MemoryItemReranker {
  return new HeuristicMemoryItemReranker();
}
