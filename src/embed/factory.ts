import type { EmbeddingProvider, EmbeddingProviderConfig } from "./types.js";
import { LlamaCppEmbeddingProvider } from "./llamacpp-provider.js";

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case "llamacpp":
      return new LlamaCppEmbeddingProvider(config);
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
}
