// ============================================================================
// Core API - Service layer for MCP and CLI
// ============================================================================

// Export context
export {
  createCoreContext,
  type CoreContext,
  type CreateCoreContextOptions,
  type EdgeSuggestionProvider,
} from "./context.js";

// Export operations
export { save } from "./save.js";
export { get } from "./get.js";
export { list } from "./list.js";
export { deleteMemory, deleteMemory as delete } from "./delete.js";
export { recall } from "./recall.js";
export { reindex } from "./reindex.js";
export { status } from "./status.js";
export { createEdge, updateEdge, updateEdgeStatus, moderateEdgeState, listNeighbors } from "./edges.js";
export {
  buildSaveEdgeSuggestionCandidatePool,
  createSaveEdgeSuggestionProvider,
  persistSuggestedEdgeRecord,
  DEFAULT_EDGE_SUGGESTION_TOP_K,
  DEFAULT_EDGE_SUGGESTION_SEMANTIC_LIMIT,
  DEFAULT_EDGE_SUGGESTION_RECENT_LIMIT,
  DEFAULT_REJECTED_EDGE_CONFIDENCE_DELTA,
  EdgeSuggestionCandidateSourceValues,
  type EdgeSuggestionCandidate,
  type EdgeSuggestionCandidateSource,
  type EdgeSuggestionDraft,
  type EdgeSuggestionGenerator,
  type SaveEdgeSuggestionCandidatePool,
  type SaveEdgeSuggestionPipelineOptions,
} from "./edge-suggestions.js";

// Export types and schemas
export {
  // Schemas
  SaveMemoryInputSchema,
  SaveMemoryLinkSchema,
  ListMemoryFiltersSchema,
  RecallFiltersSchema,
  EdgeRelationSchema,
  EdgeOriginSchema,
  EdgeStatusSchema,
  EdgeAcceptanceProvenanceSchema,
  NeighborDirectionSchema,
  CreateEdgeInputSchema,
  UpdateEdgeInputSchema,
  UpdateEdgeStatusInputSchema,
  ListNeighborsInputSchema,
  
  // Types
  type SaveMemoryInput,
  type SaveMemoryData,
  type SaveMemoryLinkInput,
  type SaveMemoryLinkData,
  type ListMemoryFilters,
  type ListMemoryFilterData,
  type RecallFilters,
  type RecallFilterData,
  type EdgeRelationType,
  type EdgeOrigin,
  type EdgeStatus,
  type EdgeAcceptanceProvenance,
  type NeighborDirection,
  type NeighborTraversalDirection,
  type CreateEdgeInput,
  type CreateEdgeData,
  type UpdateEdgeInput,
  type UpdateEdgeData,
  type UpdateEdgeStatusInput,
  type UpdateEdgeStatusData,
  type ListNeighborsInput,
  type ListNeighborsData,
  type SaveResult,
  type ListResult,
  type RecallHit,
  type MemoryStatus,
  type MemoryEdge,
  type MemoryNeighbor,
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
