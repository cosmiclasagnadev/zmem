import type { SearchHit } from "./fusion.js";
import type { MemoryScope, MemoryType } from "../types/memory.js";

const BEST_HIT_WEIGHT = 0.72;
const MULTI_CHUNK_SUPPORT_WEIGHT = 0.18;
const CHUNK_DIVERSITY_WEIGHT = 0.1;
const SUPPORT_CHUNK_SATURATION = 4;

export interface ChunkCandidateHit extends SearchHit {
  memoryId: string;
}

export interface MemoryRollupEvidence {
  bestHitScore: number;
  multiChunkSupport: number;
  chunkDiversity: number;
  totalChunkHits: number;
  supportingChunkCount: number;
  uniqueChunkCount: number;
  uniqueSources: Array<"lex" | "vec" | "hybrid">;
  bestChunkId: string;
  bestSnippet: string;
  supportingScoreSum: number;
  averageSupportingScore: number;
}

export interface MemoryRollupDebugHit {
  chunkId: string;
  score: number;
  source: "lex" | "vec" | "hybrid";
  snippet: string;
}

export interface MemoryRollup {
  memoryId: string;
  title: string;
  score: number;
  source: "lex" | "vec" | "hybrid";
  snippet: string;
  scope: MemoryScope;
  type: MemoryType;
  evidence: MemoryRollupEvidence;
  debug: {
    hits: MemoryRollupDebugHit[];
  };
}

export interface QueryHit {
  id: string;
  title: string;
  score: number;
  source: "lex" | "vec" | "hybrid";
  snippet: string;
  scope: MemoryScope;
  type: MemoryType;
  explanation?: string;
}

function clamp01(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function sourcePriority(source: QueryHit["source"]): number {
  if (source === "hybrid") return 2;
  if (source === "vec") return 1;
  return 0;
}

function resolveRollupSource(hits: ChunkCandidateHit[]): QueryHit["source"] {
  const unique = new Set(hits.map((hit) => hit.source));
  if (unique.has("hybrid") || unique.size > 1) {
    return "hybrid";
  }

  return hits[0]?.source ?? "lex";
}

function computeMultiChunkSupport(uniqueChunkCount: number): number {
  if (uniqueChunkCount <= 1) {
    return 0;
  }

  return clamp01(
    Math.log1p(uniqueChunkCount - 1) / Math.log1p(SUPPORT_CHUNK_SATURATION)
  );
}

function computeChunkDiversity(bestHitScore: number, supportingScores: number[]): number {
  if (supportingScores.length === 0 || bestHitScore <= 0) {
    return 0;
  }

  const supportingScoreSum = supportingScores.reduce((sum, score) => sum + score, 0);
  const maxComparableSupport = bestHitScore * supportingScores.length;
  if (maxComparableSupport <= 0) {
    return 0;
  }

  return clamp01(supportingScoreSum / maxComparableSupport);
}

export function buildMemoryRollups(results: ChunkCandidateHit[]): MemoryRollup[] {
  const byMemoryId = new Map<string, ChunkCandidateHit[]>();

  for (const hit of results) {
    const existing = byMemoryId.get(hit.memoryId);
    if (existing) {
      existing.push(hit);
    } else {
      byMemoryId.set(hit.memoryId, [hit]);
    }
  }

  return [...byMemoryId.entries()]
    .map(([memoryId, hits]) => {
      const sortedHits = [...hits].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (sourcePriority(b.source) !== sourcePriority(a.source)) {
          return sourcePriority(b.source) - sourcePriority(a.source);
        }
        return a.id.localeCompare(b.id);
      });
      const bestHit = sortedHits[0];
      const supportingHits = sortedHits.slice(1);
      const supportingScores = supportingHits.map((hit) => hit.score);
      const uniqueSources = [...new Set(sortedHits.map((hit) => hit.source))] as Array<
        "lex" | "vec" | "hybrid"
      >;
      const uniqueChunkIds = new Set(sortedHits.map((hit) => hit.id));
      const multiChunkSupport = computeMultiChunkSupport(uniqueChunkIds.size);
      const chunkDiversity = computeChunkDiversity(bestHit.score, supportingScores);
      const score =
        bestHit.score * BEST_HIT_WEIGHT +
        multiChunkSupport * MULTI_CHUNK_SUPPORT_WEIGHT +
        chunkDiversity * CHUNK_DIVERSITY_WEIGHT;
      const supportingScoreSum = supportingScores.reduce((sum, value) => sum + value, 0);

      return {
        memoryId,
        title: bestHit.title,
        score,
        source: resolveRollupSource(sortedHits),
        snippet: bestHit.snippet,
        scope: bestHit.scope,
        type: bestHit.type,
        evidence: {
          bestHitScore: bestHit.score,
          multiChunkSupport,
          chunkDiversity,
          totalChunkHits: sortedHits.length,
          supportingChunkCount: supportingHits.length,
          uniqueChunkCount: uniqueChunkIds.size,
          uniqueSources,
          bestChunkId: bestHit.id,
          bestSnippet: bestHit.snippet,
          supportingScoreSum,
          averageSupportingScore: supportingHits.length > 0 ? supportingScoreSum / supportingHits.length : 0,
        },
        debug: {
          hits: sortedHits.map((hit) => ({
            chunkId: hit.id,
            score: hit.score,
            source: hit.source,
            snippet: hit.snippet,
          })),
        },
      } satisfies MemoryRollup;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.evidence.bestHitScore !== a.evidence.bestHitScore) {
        return b.evidence.bestHitScore - a.evidence.bestHitScore;
      }
      if (b.evidence.uniqueChunkCount !== a.evidence.uniqueChunkCount) {
        return b.evidence.uniqueChunkCount - a.evidence.uniqueChunkCount;
      }
      if (sourcePriority(b.source) !== sourcePriority(a.source)) {
        return sourcePriority(b.source) - sourcePriority(a.source);
      }
      return a.memoryId.localeCompare(b.memoryId);
    });
}

export function rollupChunkHits(results: ChunkCandidateHit[], topK: number): QueryHit[] {
  return buildMemoryRollups(results)
    .slice(0, topK)
    .map((rollup) => ({
      id: rollup.memoryId,
      title: rollup.title,
      score: rollup.score,
      source: rollup.source,
      snippet: rollup.snippet,
      scope: rollup.scope,
      type: rollup.type,
    }));
}
