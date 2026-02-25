// ============================================================================
// Core API - Service layer for MCP and CLI
// ============================================================================

// Export context
export { createCoreContext, type CoreContext, type CreateCoreContextOptions } from "./context.js";

// Export operations
export { save } from "./save.js";
export { get } from "./get.js";
export { list } from "./list.js";
export { deleteMemory, deleteMemory as delete } from "./delete.js";
export { recall } from "./recall.js";
export { reindex } from "./reindex.js";
export { status } from "./status.js";

// Export types and schemas
export {
  // Schemas
  SaveMemoryInputSchema,
  ListMemoryFiltersSchema,
  RecallFiltersSchema,
  
  // Types
  type SaveMemoryInput,
  type SaveMemoryData,
  type ListMemoryFilters,
  type ListMemoryFilterData,
  type RecallFilters,
  type RecallFilterData,
  type SaveResult,
  type ListResult,
  type RecallHit,
  type MemoryStatus,
  type ReindexResult,
  type CoreErrorCode,
  CoreError,
} from "./types.js";

// Export utilities
export {
  generateMemoryId,
  memoryItemExists,
  getMemoryItemStatus,
  buildListFilter,
  isValidId,
} from "./utils.js";
