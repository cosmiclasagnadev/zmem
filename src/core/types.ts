import { z } from "zod";
import type { MemoryType, MemoryScope, MemoryItem } from "../types/memory.js";

export const EdgeRelationValues = [
  "related_to",
  "supports",
  "contradicts",
  "caused_by",
  "derived_from",
  "preferred_with",
] as const;

export const EdgeOriginValues = ["manual", "llm"] as const;

export const EdgeStatusValues = ["suggested", "accepted", "rejected"] as const;

export const EdgeAcceptanceProvenanceValues = ["user", "agent", "system"] as const;

export const NeighborDirectionValues = ["outbound", "inbound", "both"] as const;

export const EdgeRelationSchema = z.enum(EdgeRelationValues);
export const EdgeOriginSchema = z.enum(EdgeOriginValues);
export const EdgeStatusSchema = z.enum(EdgeStatusValues);
export const EdgeAcceptanceProvenanceSchema = z.enum(EdgeAcceptanceProvenanceValues);
export const NeighborDirectionSchema = z.enum(NeighborDirectionValues);

export const SaveMemoryLinkSchema = z.object({
  toMemoryId: z.string().min(1, "toMemoryId is required"),
  relationType: EdgeRelationSchema,
  confidence: z.number().min(0).max(1).default(0.5),
  justification: z.string().default(""),
  acceptedBy: EdgeAcceptanceProvenanceSchema.default("agent"),
}).strict();

// ============================================================================
// Input Schemas
// ============================================================================

export const SaveMemoryInputSchema = z.object({
  type: z.enum(["fact", "decision", "preference", "event", "goal", "todo"]),
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
  summary: z.string().optional().default(""),
  source: z.string().min(1, "Source is required"),
  scope: z.enum(["global", "workspace", "user"]).default("workspace"),
  tags: z.array(z.string()).default([]),
  importance: z.number().min(0).max(1).default(0.5),
  supersedesId: z.string().nullable().optional(),
  links: z.array(SaveMemoryLinkSchema).default([]),
  suggestEdges: z.boolean().default(true),
}).strict();

export const ListMemoryFiltersSchema = z.object({
  workspace: z.string().optional(),
  type: z.enum(["fact", "decision", "preference", "event", "goal", "todo"]).optional(),
  scope: z.enum(["global", "workspace", "user"]).optional(),
  status: z.enum(["pending", "active", "archived", "deleted"]).default("active"),
  limit: z.number().int().positive().default(50),
  offset: z.number().int().nonnegative().default(0),
}).strict();

export const RecallFiltersSchema = z.object({
  scopes: z.array(z.enum(["workspace", "global", "user"])).optional(),
  types: z.array(z.enum(["fact", "decision", "preference", "event", "goal", "todo"])).optional(),
  includeSuperseded: z.boolean().default(false),
  topK: z.number().int().positive().default(30),
  minScore: z.number().min(0).max(1).default(0.25),
  mode: z.enum(["hybrid", "lexical", "vector", "recent", "important", "typed"]).default("hybrid"),
  expansionMode: z.enum(["off", "deterministic", "llm"]).optional(),
}).strict();

export const CreateEdgeInputSchema = z.object({
  id: z.string().min(1).optional(),
  fromMemoryId: z.string().min(1, "fromMemoryId is required"),
  toMemoryId: z.string().min(1, "toMemoryId is required"),
  relationType: EdgeRelationSchema,
  confidence: z.number().min(0).max(1).default(0.5),
  origin: EdgeOriginSchema.default("manual"),
  status: EdgeStatusSchema.optional(),
  justification: z.string().default(""),
  acceptedBy: EdgeAcceptanceProvenanceSchema.nullable().optional(),
}).strict();

export const UpdateEdgeInputSchema = z.object({
  id: z.string().min(1, "id is required"),
  confidence: z.number().min(0).max(1).optional(),
  status: EdgeStatusSchema.optional(),
  justification: z.string().optional(),
  acceptedBy: EdgeAcceptanceProvenanceSchema.nullable().optional(),
}).strict().refine(
  (value) =>
    value.confidence !== undefined ||
    value.status !== undefined ||
    value.justification !== undefined ||
    value.acceptedBy !== undefined,
  { message: "At least one edge field must be updated" }
);

export const UpdateEdgeStatusInputSchema = z.object({
  id: z.string().min(1, "id is required"),
  status: EdgeStatusSchema,
  justification: z.string().optional(),
  acceptedBy: EdgeAcceptanceProvenanceSchema.nullable().optional(),
}).strict();

export const ListNeighborsInputSchema = z.object({
  direction: NeighborDirectionSchema.default("both"),
  relationTypes: z.array(EdgeRelationSchema).optional(),
  origins: z.array(EdgeOriginSchema).optional(),
  statuses: z.array(EdgeStatusSchema).optional(),
  depth: z.number().int().positive().default(1),
  limit: z.number().int().positive().default(100),
}).strict();

// ============================================================================
// Output Types
// ============================================================================

export interface SaveResult {
  id: string;
  isNew: boolean;
  supersededId?: string;
}

export interface ListResult {
  items: MemoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface RecallHit {
  id: string;
  title: string;
  score: number;
  source: "lex" | "vec" | "hybrid";
  snippet: string;
  scope: MemoryScope;
  type: MemoryType;
  explanation?: string;
}

export interface MemoryStatus {
  totalItems: number;
  totalVectors: number;
  pendingEmbeddings: number;
  lastIndexedAt: string | null;
}

export interface MemoryEdge {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: EdgeRelationType;
  confidence: number;
  origin: EdgeOrigin;
  status: EdgeStatus;
  justification: string;
  acceptedBy: EdgeAcceptanceProvenance | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryNeighbor {
  memory: MemoryItem;
  edge: MemoryEdge;
  direction: NeighborTraversalDirection;
  depth: number;
}

export interface ReindexResult {
  processed: number;
  errors: number;
  duration: number;
}

// ============================================================================
// Error Types
// ============================================================================

export type CoreErrorCode = 
  | "VALIDATION" 
  | "NOT_FOUND" 
  | "DATABASE" 
  | "EMBEDDING"
  | "CONFLICT";

export class CoreError extends Error {
  constructor(
    message: string,
    public code: CoreErrorCode,
    public cause?: Error
  ) {
    super(message);
    this.name = "CoreError";
  }
}

// ============================================================================
// Type Exports
// ============================================================================

export type SaveMemoryInput = z.input<typeof SaveMemoryInputSchema>;
export type SaveMemoryData = z.output<typeof SaveMemoryInputSchema>;

export type SaveMemoryLinkInput = z.input<typeof SaveMemoryLinkSchema>;
export type SaveMemoryLinkData = z.output<typeof SaveMemoryLinkSchema>;

export type ListMemoryFilters = z.input<typeof ListMemoryFiltersSchema>;
export type ListMemoryFilterData = z.output<typeof ListMemoryFiltersSchema>;

export type RecallFilters = z.input<typeof RecallFiltersSchema>;
export type RecallFilterData = z.output<typeof RecallFiltersSchema>;

export type EdgeRelationType = z.infer<typeof EdgeRelationSchema>;
export type EdgeOrigin = z.infer<typeof EdgeOriginSchema>;
export type EdgeStatus = z.infer<typeof EdgeStatusSchema>;
export type EdgeAcceptanceProvenance = z.infer<typeof EdgeAcceptanceProvenanceSchema>;
export type NeighborDirection = z.infer<typeof NeighborDirectionSchema>;
export type NeighborTraversalDirection = Exclude<NeighborDirection, "both">;

export type CreateEdgeInput = z.input<typeof CreateEdgeInputSchema>;
export type CreateEdgeData = z.output<typeof CreateEdgeInputSchema>;

export type UpdateEdgeInput = z.input<typeof UpdateEdgeInputSchema>;
export type UpdateEdgeData = z.output<typeof UpdateEdgeInputSchema>;

export type UpdateEdgeStatusInput = z.input<typeof UpdateEdgeStatusInputSchema>;
export type UpdateEdgeStatusData = z.output<typeof UpdateEdgeStatusInputSchema>;

export type ListNeighborsInput = z.input<typeof ListNeighborsInputSchema>;
export type ListNeighborsData = z.output<typeof ListNeighborsInputSchema>;
