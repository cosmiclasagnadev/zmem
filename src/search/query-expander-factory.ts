import type { AppConfig } from "../config/schema.js";
import { createCachedQueryExpander, createDeterministicQueryExpander, type QueryExpander } from "./query-expansion.js";
import { LlamaCppQueryExpander } from "./query-expander-llamacpp.js";

export function createQueryExpander(config: AppConfig): QueryExpander {
  if (!config.ai.queryExpansion.enabled || config.ai.queryExpansion.provider === "deterministic") {
    return createCachedQueryExpander(
      createDeterministicQueryExpander({ maxTotalVariants: config.ai.queryExpansion.maxExpansions + 1 }),
      config.ai.queryExpansion.cacheSize
    );
  }

  return createCachedQueryExpander(new LlamaCppQueryExpander(config), config.ai.queryExpansion.cacheSize);
}
