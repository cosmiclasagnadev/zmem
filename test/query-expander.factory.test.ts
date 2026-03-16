import test from "node:test";
import assert from "node:assert/strict";
import { appConfigSchema } from "../src/config/schema.js";
import { createQueryExpander } from "../src/search/query-expander-factory.js";

test("query expansion config defaults to local-first Q4 models", () => {
  const config = appConfigSchema.parse({
    defaults: { retrieval: {} },
  });

  assert.equal(config.ai.queryExpansion.enabled, true);
  assert.equal(config.ai.queryExpansion.provider, "llamacpp");
  assert.equal(config.ai.queryExpansion.model, "hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_M");
  assert.equal(config.ai.queryExpansion.fallbackModel, "hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_S");
});

test("deterministic query expander remains available via config", async () => {
  const config = appConfigSchema.parse({
    defaults: { retrieval: {} },
    ai: {
      embedding: {},
      rerank: {},
      queryExpansion: {
        enabled: true,
        provider: "deterministic",
        maxExpansions: 3,
      },
    },
  });

  const expander = createQueryExpander(config);
  const plan = await expander.expand({
    query: "why did we choose this",
    mode: "llm",
    maxExpansions: 3,
    includeLexical: true,
  });

  assert.equal(plan.mode, "deterministic");
  assert(plan.variants.some((variant) => variant.strategy === "hyde"));
});
