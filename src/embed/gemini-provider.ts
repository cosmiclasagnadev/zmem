import type { EmbedRequest, EmbedResult, EmbeddingProvider, EmbeddingProviderConfig } from "./types.js";
import { debug, info } from "../utils/logger.js";

type GeminiEmbedding = { values?: unknown } | { embedding?: { values?: unknown } };

type GeminiBatchResponse = {
  embeddings?: GeminiEmbedding[];
};

type GeminiSingleResponse = {
  embedding?: { values?: unknown };
};

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  public readonly dimensions: number;
  public readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly taskType?: string;
  private disposed = false;
  private initialized = false;

  constructor(config: EmbeddingProviderConfig) {
    if (!config.apiKey) {
      throw new Error("Gemini embedding provider requires apiKey");
    }

    this.dimensions = config.dimensions;
    this.model = config.model;
    this.batchSize = config.batchSize;
    this.baseUrl = (config.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.taskType = config.taskType;
  }

  async initialize(): Promise<void> {
    if (this.disposed) {
      throw new Error("Provider has been disposed");
    }

    if (this.initialized) {
      return;
    }

    info(() => `[GeminiProvider] Ready: ${this.model}`);
    debug(() => `[GeminiProvider] Dimensions: ${this.dimensions}, Batch size: ${this.batchSize}`);
    this.initialized = true;
  }

  async embed(text: string): Promise<number[]> {
    this.assertReady();

    const response = await this.post<GeminiSingleResponse>(
      `${this.baseUrl}/models/${this.model}:embedContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: this.taskType,
        outputDimensionality: this.dimensions,
      }
    );

    return this.parseEmbedding(response.embedding, `embedContent:${this.model}`);
  }

  async embedBatch(requests: EmbedRequest[]): Promise<EmbedResult[]> {
    this.assertReady();

    if (requests.length === 0) {
      return [];
    }

    const results: EmbedResult[] = [];
    for (let index = 0; index < requests.length; index += this.batchSize) {
      const batch = requests.slice(index, index + this.batchSize);
      const response = await this.post<GeminiBatchResponse>(
        `${this.baseUrl}/models/${this.model}:batchEmbedContents?key=${encodeURIComponent(this.apiKey)}`,
        {
          requests: batch.map((request) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text: request.text }] },
            taskType: this.taskType,
            outputDimensionality: this.dimensions,
          })),
        }
      );

      if (!Array.isArray(response.embeddings) || response.embeddings.length !== batch.length) {
        throw new Error(
          `Gemini batch response mismatch: expected ${batch.length} embeddings, received ${Array.isArray(response.embeddings) ? response.embeddings.length : 0}`
        );
      }

      batch.forEach((request, offset) => {
        results.push({
          id: request.id,
          embedding: this.parseEmbedding(response.embeddings?.[offset], `batchEmbedContents:${this.model}:${offset}`),
          dimensions: this.dimensions,
        });
      });
    }

    return results;
  }

  async healthCheck(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    try {
      await this.embed("health check");
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.initialized = false;
  }

  private assertReady(): void {
    if (this.disposed) {
      throw new Error("Provider has been disposed");
    }

    if (!this.initialized) {
      throw new Error("Provider not initialized. Call initialize() first.");
    }
  }

  private async post<T>(url: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${message}`);
    }

    return (await response.json()) as T;
  }

  private parseEmbedding(payload: GeminiEmbedding | undefined, context: string): number[] {
    let rawValues: unknown;
    if (payload && "embedding" in payload) {
      rawValues = payload.embedding?.values;
    } else if (payload) {
      rawValues = (payload as { values?: unknown }).values;
    }
    if (!Array.isArray(rawValues)) {
      throw new Error(`Gemini returned invalid embedding shape for ${context}`);
    }

    const values = rawValues.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Gemini returned non-numeric embedding value for ${context}`);
      }
      return value;
    });

    if (values.length !== this.dimensions) {
      throw new Error(
        `Gemini embedding dimension mismatch for ${context}: expected ${this.dimensions}, received ${values.length}`
      );
    }

    return values;
  }
}
