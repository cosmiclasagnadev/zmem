import type { CoreContext } from "./context.js";
import type { RecallFilters, RecallHit } from "./types.js";
import { queryMemories } from "../search/index.js";
import { CoreError, RecallFiltersSchema } from "./types.js";
import { ZodError } from "zod";

const metricsEnabled = process.env.ZMEM_RECALL_METRICS === "true";
const metricsWindowSize = 200;
const metricsLogEvery = 25;
const recallDurationsMs: number[] = [];
let recallCount = 0;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function recordRecallMetrics(durationMs: number, mode: string, resultCount: number): void {
  if (!metricsEnabled) {
    return;
  }

  recallDurationsMs.push(durationMs);
  if (recallDurationsMs.length > metricsWindowSize) {
    recallDurationsMs.shift();
  }

  recallCount += 1;
  if (recallCount % metricsLogEvery !== 0) {
    return;
  }

  const p50 = percentile(recallDurationsMs, 50);
  const p95 = percentile(recallDurationsMs, 95);
  process.stderr.write(
    `[zmem:metrics] recall count=${recallCount} window=${recallDurationsMs.length} mode=${mode} results=${resultCount} lastMs=${durationMs.toFixed(1)} p50Ms=${p50.toFixed(1)} p95Ms=${p95.toFixed(1)}\n`
  );
}

/**
 * Search memories using hybrid retrieval (lexical + vector)
 * 
 * @param ctx - Core context with dependencies
 * @param query - Search query string
 * @param filters - Optional filters (scopes, types, includeSuperseded, etc.)
 * @returns Array of RecallHit with scores and metadata
 * @throws CoreError if embedding fails or search errors
 */
export async function recall(
  ctx: CoreContext,
  query: string,
  filters: RecallFilters = {}
): Promise<RecallHit[]> {
  const startedAt = performance.now();

  // Validate query
  if (!query || query.trim().length === 0) {
    throw new CoreError("Query cannot be empty", "VALIDATION");
  }
  
  try {
    const parsed = RecallFiltersSchema.parse(filters);

    const results = await queryMemories(
      ctx.db,
      ctx.embedProvider,
      ctx.vectorCollection,
      {
        query: query.trim(),
        workspace: ctx.workspace,
        scopes: parsed.scopes ?? ["workspace", "global"],
        types: parsed.types,
        includeSuperseded: parsed.includeSuperseded,
        topK: parsed.topK,
        minScore: parsed.minScore,
        mode: parsed.mode,
      }
    );
    
    const mapped = results.map((r) => ({
      id: r.id,
      title: r.title,
      score: r.score,
      source: r.source,
      snippet: r.snippet,
      scope: r.scope,
      type: r.type,
    }));

    recordRecallMetrics(performance.now() - startedAt, parsed.mode ?? "hybrid", mapped.length);
    return mapped;
  } catch (error) {
    if (error instanceof CoreError) {
      throw error;
    }

    if (error instanceof ZodError) {
      throw new CoreError("Invalid recall filters", "VALIDATION", error);
    }

    throw new CoreError(
      `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}
