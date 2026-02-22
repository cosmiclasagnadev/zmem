export interface EmbedRequest {
  id: string;
  text: string;
}

export interface EmbedResult {
  id: string;
  embedding: number[];
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  
  /**
   * Initialize the provider (load model, etc.)
   */
  initialize(): Promise<void>;
  
  /**
   * Generate embedding for a single text
   */
  embed(text: string): Promise<number[]>;
  
  /**
   * Generate embeddings for multiple texts in batch
   */
  embedBatch(texts: EmbedRequest[]): Promise<EmbedResult[]>;
  
  /**
   * Check if the provider is healthy and ready
   */
  healthCheck(): Promise<boolean>;
  
  /**
   * Clean up resources
   */
  dispose(): Promise<void>;
}

export interface EmbeddingProviderConfig {
  provider: string;
  model: string;
  dimensions: number;
  batchSize: number;
  maxTokens: number;
  baseUrl?: string;
  apiKey?: string;
}
