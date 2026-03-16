import { createEmbeddingProvider } from "../../src/embed/factory.js";
import type { EmbeddingProvider } from "../../src/embed/types.js";

export function createMockEmbeddingProvider(dimensions = 3, model = "test-embed"): EmbeddingProvider {
  return createEmbeddingProvider({
    provider: "mock",
    model,
    dimensions,
    batchSize: 8,
    maxTokens: 8192,
  });
}
