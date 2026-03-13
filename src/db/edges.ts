import type { DbHandle } from "./index.js";

export interface PersistMemoryEdgeInput {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: string;
  confidence: number;
  origin: "manual" | "llm";
  status: "suggested" | "accepted" | "rejected";
  justification?: string;
  acceptedBy?: "user" | "agent" | "system" | null;
  createdAt?: string;
  updatedAt?: string;
}

export function persistMemoryEdge(handle: DbHandle, input: PersistMemoryEdgeInput): void {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;

  handle.db.prepare(`
    INSERT INTO memory_edges (
      id,
      from_memory_id,
      to_memory_id,
      relation_type,
      confidence,
      origin,
      status,
      justification,
      accepted_by,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(from_memory_id, to_memory_id, relation_type) DO NOTHING
  `).run(
    input.id,
    input.fromMemoryId,
    input.toMemoryId,
    input.relationType,
    input.confidence,
    input.origin,
    input.status,
    input.justification ?? "",
    input.acceptedBy ?? null,
    createdAt,
    updatedAt
  );
}
