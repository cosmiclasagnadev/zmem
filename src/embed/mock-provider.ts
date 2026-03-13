import type { EmbedRequest, EmbedResult, EmbeddingProvider, EmbeddingProviderConfig } from "./types.js";
import { createDeterministicEmbedding } from "./deterministic.js";

export class MockEmbeddingProvider implements EmbeddingProvider {
  public readonly dimensions: number;
  public readonly model: string;

  constructor(private readonly config: EmbeddingProviderConfig) {
    this.dimensions = config.dimensions;
    this.model = config.model;
  }

  async initialize(): Promise<void> {}

  async embed(text: string): Promise<number[]> {
    return createDeterministicEmbedding(text, this.dimensions, this.model);
  }

  async embedBatch(requests: EmbedRequest[]): Promise<EmbedResult[]> {
    return Promise.all(
      requests.map(async (request) => ({
        id: request.id,
        embedding: await this.embed(request.text),
        dimensions: this.dimensions,
      }))
    );
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async dispose(): Promise<void> {}
}
