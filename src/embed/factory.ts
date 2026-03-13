import type { EmbeddingProvider, EmbeddingProviderConfig } from "./types.js";
import { GeminiEmbeddingProvider } from "./gemini-provider.js";
import { LlamaCppEmbeddingProvider } from "./llamacpp-provider.js";
import { MockEmbeddingProvider } from "./mock-provider.js";

function validateEmbeddingConfig(config: EmbeddingProviderConfig): void {
  if (!config.model) {
    throw new Error(`Embedding provider \"${config.provider}\" requires a model`);
  }

  if (!Number.isInteger(config.dimensions) || config.dimensions <= 0) {
    throw new Error(`Embedding provider \"${config.provider}\" requires a positive integer dimensions value`);
  }

  if (!Number.isInteger(config.batchSize) || config.batchSize <= 0) {
    throw new Error(`Embedding provider \"${config.provider}\" requires a positive integer batchSize value`);
  }

  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    throw new Error(`Embedding provider \"${config.provider}\" requires a positive integer maxTokens value`);
  }

  if (config.provider === "gemini" && !config.apiKey) {
    throw new Error("Gemini embedding provider requires apiKey");
  }
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  validateEmbeddingConfig(config);

  switch (config.provider) {
    case "llamacpp":
      return new LlamaCppEmbeddingProvider(config);
    case "gemini":
      return new GeminiEmbeddingProvider(config);
    case "mock":
      return new MockEmbeddingProvider(config);
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
}
