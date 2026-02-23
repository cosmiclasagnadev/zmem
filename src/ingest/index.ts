// Types
export type {
  FileDiscoveryOptions,
  DiscoveredFile,
  ParsedDocument,
  Chunk,
  ChunkingOptions,
  IngestResult,
  IngestProgress,
  ProgressCallback,
} from "./types.js";

// Core functions
export { discoverFiles } from "./discovery.js";
export { parseMarkdown, hashContent } from "./parser.js";
export { chunkDocument, DEFAULT_CHUNK_SIZE_TOKENS, DEFAULT_OVERLAP_TOKENS } from "./chunker.js";
export { ingestWorkspace, type IngestOptions } from "./orchestrator.js";
export { ProgressReporter } from "./progress.js";

// Repository functions
export {
  findExistingDocument,
  insertMemoryItem,
  updateMemoryItem,
  insertChunks,
  markChunksEmbedded,
  getActiveDocumentSources,
  softDeleteMissingDocuments,
  getIngestStats,
  type ExistingDocument,
} from "./repository.js";
