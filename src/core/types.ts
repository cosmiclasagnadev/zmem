import { z } from "zod";
import type { MemoryType, MemoryScope, MemoryItem } from "../types/memory.js";

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
  mode: z.enum(["hybrid", "lexical", "vector"]).default("hybrid"),
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
}

export interface MemoryStatus {
  totalItems: number;
  totalVectors: number;
  pendingEmbeddings: number;
  lastIndexedAt: string | null;
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

export type ListMemoryFilters = z.input<typeof ListMemoryFiltersSchema>;
export type ListMemoryFilterData = z.output<typeof ListMemoryFiltersSchema>;

export type RecallFilters = z.input<typeof RecallFiltersSchema>;
export type RecallFilterData = z.output<typeof RecallFiltersSchema>;
