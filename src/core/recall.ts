import type { CoreContext } from "./context.js";
import type { RecallFilters, RecallHit } from "./types.js";
import { queryMemories } from "../search/index.js";
import { CoreError, RecallFiltersSchema } from "./types.js";
import { ZodError } from "zod";

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
    
    return results.map((r) => ({
      id: r.id,
      title: r.title,
      score: r.score,
      source: r.source,
      snippet: r.snippet,
      scope: r.scope,
      type: r.type,
    }));
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
