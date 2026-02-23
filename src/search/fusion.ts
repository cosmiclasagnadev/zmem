import type { MemoryScope, MemoryType } from "../types/memory.js";

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: "lex" | "vec" | "hybrid";
  scope: MemoryScope;
  type: MemoryType;
  status: string;
}

const RRF_K = 60;
const FIRST_LIST_WEIGHT = 2.0;
const TOP_RANK_BONUS = 0.05;

export interface FusionOptions {
  candidateLimit?: number;
  firstListWeight?: number;
  topRankBonus?: number;
  minScore?: number;
}

const DEFAULT_OPTIONS: Required<FusionOptions> = {
  candidateLimit: 30,
  firstListWeight: FIRST_LIST_WEIGHT,
  topRankBonus: TOP_RANK_BONUS,
  minScore: 0.25,
};

export function rrfFusion(
  lexResults: SearchHit[],
  vecResults: SearchHit[],
  options: FusionOptions = {}
): SearchHit[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { candidateLimit, firstListWeight, topRankBonus, minScore } = opts;

  const rrfMap = new Map<
    string,
    { hit: SearchHit; rrfScore: number; sources: Set<string> }
  >();

  const lexCandidates = lexResults.slice(0, candidateLimit);
  const vecCandidates = vecResults.slice(0, candidateLimit);

  lexCandidates.forEach((hit, rank) => {
    const isFirst = rank === 0;
    const bonus = isFirst ? topRankBonus : 0;
    const score = firstListWeight * (1 / (rank + RRF_K)) + bonus;

    rrfMap.set(hit.id, {
      hit,
      rrfScore: score,
      sources: new Set(["lex"]),
    });
  });

  vecCandidates.forEach((hit, rank) => {
    const isFirst = rank === 0;
    const bonus = isFirst ? topRankBonus : 0;
    const score = 1 / (rank + RRF_K) + bonus;

    const existing = rrfMap.get(hit.id);
    if (existing) {
      existing.rrfScore += score;
      existing.sources.add("vec");
    } else {
      rrfMap.set(hit.id, {
        hit,
        rrfScore: score,
        sources: new Set(["vec"]),
      });
    }
  });

  const merged = Array.from(rrfMap.values());

  if (merged.length === 0) return [];

  const maxScore = Math.max(...merged.map((r) => r.rrfScore));

  // First normalize, THEN filter by minScore
  const normalized: SearchHit[] = merged
    .map((r) => {
      const finalSource: "lex" | "vec" | "hybrid" =
        r.sources.size > 1
          ? "hybrid"
          : r.sources.has("lex")
            ? "lex"
            : "vec";

      return {
        ...r.hit,
        score: maxScore > 0 ? r.rrfScore / maxScore : 0,
        source: finalSource,
      };
    })
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return normalized;
}
