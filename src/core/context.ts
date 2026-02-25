import type { DbHandle } from "../db/index.js";
import type { EmbeddingProvider } from "../embed/types.js";
import type { VectorCollection } from "../vectors/index.js";
import type { AppConfig } from "../config/schema.js";

/**
 * CoreContext holds all dependencies needed by core operations.
 * This allows for clean dependency injection and easier testing.
 */
export interface CoreContext {
  /** Database handle for SQLite operations */
  db: DbHandle;
  
  /** Embedding provider for generating vectors */
  embedProvider: EmbeddingProvider;
  
  /** Vector collection for storing/retrieving embeddings */
  vectorCollection: VectorCollection;
  
  /** Current workspace name */
  workspace: string;
  
  /** Application configuration */
  config: AppConfig;
}

/**
 * Options for creating a CoreContext
 */
export interface CreateCoreContextOptions {
  db: DbHandle;
  embedProvider: EmbeddingProvider;
  vectorCollection: VectorCollection;
  workspace: string;
  config: AppConfig;
}

/**
 * Factory function to create a CoreContext
 */
export function createCoreContext(options: CreateCoreContextOptions): CoreContext {
  return {
    db: options.db,
    embedProvider: options.embedProvider,
    vectorCollection: options.vectorCollection,
    workspace: options.workspace,
    config: options.config,
  };
}
