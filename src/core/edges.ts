import { randomUUID } from "node:crypto";
import type { CoreContext } from "./context.js";
import {
  CoreError,
  CreateEdgeInputSchema,
  ListNeighborsInputSchema,
  UpdateEdgeInputSchema,
  UpdateEdgeStatusInputSchema,
  type CreateEdgeInput,
  type CreateEdgeData,
  type EdgeAcceptanceProvenance,
  type EdgeOrigin,
  type EdgeStatus,
  type EdgeRelationType,
  type ListNeighborsData,
  type ListNeighborsInput,
  type MemoryEdge,
  type MemoryNeighbor,
  type NeighborTraversalDirection,
  type UpdateEdgeInput,
  type UpdateEdgeStatusInput,
} from "./types.js";
import { isSymmetricEdgeRelation } from "./edge-rules.js";
import { isValidId, mapRowToMemoryItem, memoryItemExists } from "./utils.js";

type EdgeRow = {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation_type: string;
  confidence: number;
  origin: string;
  status: string;
  justification: string;
  accepted_by: string | null;
  created_at: string;
  updated_at: string;
};

type NeighborRow = EdgeRow & {
  depth: number;
  direction: NeighborTraversalDirection;
  neighbor_id: string;
  neighbor_type: string;
  neighbor_title: string;
  neighbor_content: string;
  neighbor_summary: string;
  neighbor_source: string;
  neighbor_scope: string;
  neighbor_workspace: string;
  neighbor_tags: string;
  neighbor_importance: number;
  neighbor_status: string;
  neighbor_supersedes_id: string | null;
  neighbor_content_hash: string;
  neighbor_created_at: string;
  neighbor_updated_at: string;
};

export async function createEdge(ctx: CoreContext, input: CreateEdgeInput): Promise<MemoryEdge> {
  return createEdgeRecord(ctx, input);
}

export function createEdgeRecord(ctx: CoreContext, input: CreateEdgeInput): MemoryEdge {
  const parsed = CreateEdgeInputSchema.parse(input);
  const data = normalizeCreateEdgeInput(parsed);

  assertWorkspaceMemory(ctx, data.fromMemoryId, "fromMemoryId");
  assertWorkspaceMemory(ctx, data.toMemoryId, "toMemoryId");

  const now = new Date().toISOString();
  const id = data.id ?? `edge_${randomUUID()}`;

  const existingSymmetric = getExistingEquivalentEdge(ctx, data.fromMemoryId, data.toMemoryId, data.relationType);
  if (existingSymmetric) {
    return existingSymmetric;
  }

  try {
    ctx.db.db.prepare(`
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
      id,
      data.fromMemoryId,
      data.toMemoryId,
      data.relationType,
      data.confidence,
      data.origin,
      data.status,
      data.justification,
      data.acceptedBy,
      now,
      now
    );

    const edge = getEdgeByCanonicalKey(ctx, data.fromMemoryId, data.toMemoryId, data.relationType);
    if (!edge) {
      throw new CoreError("Failed to load created edge", "DATABASE");
    }

    return edge;
  } catch (error) {
    if (error instanceof CoreError) {
      throw error;
    }

    throw new CoreError(
      `Failed to create memory edge: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}

export async function updateEdge(ctx: CoreContext, input: UpdateEdgeInput): Promise<MemoryEdge> {
  const parsed = UpdateEdgeInputSchema.parse(input);

  if (!isValidId(parsed.id)) {
    throw new CoreError("Invalid edge ID", "VALIDATION");
  }

  const existing = getEdgeById(ctx, parsed.id);
  if (!existing) {
    throw new CoreError(`Edge '${parsed.id}' not found`, "NOT_FOUND");
  }

  const nextStatus = parsed.status ?? existing.status;
  const nextAcceptedBy = resolveAcceptedBy(parsed, existing.status, existing.acceptedBy);

  validateAcceptedState(nextStatus, nextAcceptedBy);

  const nextConfidence = parsed.confidence ?? existing.confidence;
  const nextJustification = parsed.justification ?? existing.justification;
  const updatedAt = new Date().toISOString();

  try {
    const result = ctx.db.db.prepare(`
      UPDATE memory_edges
      SET confidence = ?,
          status = ?,
          justification = ?,
          accepted_by = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextConfidence,
      nextStatus,
      nextJustification,
      nextAcceptedBy,
      updatedAt,
      parsed.id
    );

    if (result.changes === 0) {
      throw new CoreError(`Edge '${parsed.id}' not found`, "NOT_FOUND");
    }

    const updated = getEdgeById(ctx, parsed.id);
    if (!updated) {
      throw new CoreError(`Edge '${parsed.id}' not found after update`, "DATABASE");
    }

    return updated;
  } catch (error) {
    if (error instanceof CoreError) {
      throw error;
    }

    throw new CoreError(
      `Failed to update memory edge: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}

export async function updateEdgeStatus(
  ctx: CoreContext,
  input: UpdateEdgeStatusInput
): Promise<MemoryEdge> {
  const parsed = UpdateEdgeStatusInputSchema.parse(input);

  return updateEdge(ctx, {
    id: parsed.id,
    status: parsed.status,
    justification: parsed.justification,
    acceptedBy: parsed.status === "accepted" ? parsed.acceptedBy ?? null : null,
  });
}

export const moderateEdgeState = updateEdgeStatus;

export async function listNeighbors(
  ctx: CoreContext,
  memoryId: string,
  input: ListNeighborsInput = {}
): Promise<MemoryNeighbor[]> {
  if (!isValidId(memoryId)) {
    throw new CoreError("Invalid memory item ID", "VALIDATION");
  }

  const filters = ListNeighborsInputSchema.parse(input);
  assertWorkspaceMemory(ctx, memoryId, "memoryId");

  const edgeFilter = buildEdgeFilter("e", filters);
  const baseParams: Array<string | number> = [];
  const recursiveParams: Array<string | number> = [];
  const baseBranches: string[] = [];
  const recursiveBranches: string[] = [];

  if (filters.direction === "both" || filters.direction === "outbound") {
    baseBranches.push(`
      SELECT
        e.id,
        e.from_memory_id,
        e.to_memory_id,
        e.relation_type,
        e.confidence,
        e.origin,
        e.status,
        e.justification,
        e.accepted_by,
        e.created_at,
        e.updated_at,
        1 AS depth,
        'outbound' AS direction,
        e.to_memory_id AS node_id,
        '|' || ? || '|' || e.to_memory_id || '|' AS path
      FROM memory_edges e
      INNER JOIN memory_items src ON src.id = e.from_memory_id
      INNER JOIN memory_items dst ON dst.id = e.to_memory_id
      WHERE e.from_memory_id = ?
        AND src.workspace = ?
        AND dst.workspace = ?
        AND src.status = 'active'
        AND dst.status = 'active'
        ${edgeFilter.clause}
    `);
    baseParams.push(memoryId, memoryId, ctx.workspace, ctx.workspace, ...edgeFilter.params);

    recursiveBranches.push(`
      SELECT
        e.id,
        e.from_memory_id,
        e.to_memory_id,
        e.relation_type,
        e.confidence,
        e.origin,
        e.status,
        e.justification,
        e.accepted_by,
        e.created_at,
        e.updated_at,
        t.depth + 1 AS depth,
        'outbound' AS direction,
        e.to_memory_id AS node_id,
        t.path || e.to_memory_id || '|' AS path
      FROM traversal t
      INNER JOIN memory_edges e ON e.from_memory_id = t.node_id
      INNER JOIN memory_items src ON src.id = e.from_memory_id
      INNER JOIN memory_items dst ON dst.id = e.to_memory_id
      WHERE t.depth < ?
        AND src.workspace = ?
        AND dst.workspace = ?
        AND src.status = 'active'
        AND dst.status = 'active'
        AND instr(t.path, '|' || e.to_memory_id || '|') = 0
        ${edgeFilter.clause}
    `);
    recursiveParams.push(filters.depth, ctx.workspace, ctx.workspace, ...edgeFilter.params);
  }

  if (filters.direction === "both" || filters.direction === "inbound") {
    baseBranches.push(`
      SELECT
        e.id,
        e.from_memory_id,
        e.to_memory_id,
        e.relation_type,
        e.confidence,
        e.origin,
        e.status,
        e.justification,
        e.accepted_by,
        e.created_at,
        e.updated_at,
        1 AS depth,
        'inbound' AS direction,
        e.from_memory_id AS node_id,
        '|' || ? || '|' || e.from_memory_id || '|' AS path
      FROM memory_edges e
      INNER JOIN memory_items src ON src.id = e.from_memory_id
      INNER JOIN memory_items dst ON dst.id = e.to_memory_id
      WHERE e.to_memory_id = ?
        AND src.workspace = ?
        AND dst.workspace = ?
        AND src.status = 'active'
        AND dst.status = 'active'
        ${edgeFilter.clause}
    `);
    baseParams.push(memoryId, memoryId, ctx.workspace, ctx.workspace, ...edgeFilter.params);

    recursiveBranches.push(`
      SELECT
        e.id,
        e.from_memory_id,
        e.to_memory_id,
        e.relation_type,
        e.confidence,
        e.origin,
        e.status,
        e.justification,
        e.accepted_by,
        e.created_at,
        e.updated_at,
        t.depth + 1 AS depth,
        'inbound' AS direction,
        e.from_memory_id AS node_id,
        t.path || e.from_memory_id || '|' AS path
      FROM traversal t
      INNER JOIN memory_edges e ON e.to_memory_id = t.node_id
      INNER JOIN memory_items src ON src.id = e.from_memory_id
      INNER JOIN memory_items dst ON dst.id = e.to_memory_id
      WHERE t.depth < ?
        AND src.workspace = ?
        AND dst.workspace = ?
        AND src.status = 'active'
        AND dst.status = 'active'
        AND instr(t.path, '|' || e.from_memory_id || '|') = 0
        ${edgeFilter.clause}
    `);
    recursiveParams.push(filters.depth, ctx.workspace, ctx.workspace, ...edgeFilter.params);
  }

  if (baseBranches.length === 0) {
    return [];
  }

  try {
    const rows = ctx.db.db.prepare(`
      WITH RECURSIVE traversal AS (
        ${baseBranches.join(" UNION ALL ")}
        UNION ALL
        ${recursiveBranches.join(" UNION ALL ")}
      )
      SELECT
        t.id,
        t.from_memory_id,
        t.to_memory_id,
        t.relation_type,
        t.confidence,
        t.origin,
        t.status,
        t.justification,
        t.accepted_by,
        t.created_at,
        t.updated_at,
        t.depth,
        t.direction,
        n.id AS neighbor_id,
        n.type AS neighbor_type,
        n.title AS neighbor_title,
        n.content AS neighbor_content,
        n.summary AS neighbor_summary,
        n.source AS neighbor_source,
        n.scope AS neighbor_scope,
        n.workspace AS neighbor_workspace,
        n.tags AS neighbor_tags,
        n.importance AS neighbor_importance,
        n.status AS neighbor_status,
        n.supersedes_id AS neighbor_supersedes_id,
        n.content_hash AS neighbor_content_hash,
        n.created_at AS neighbor_created_at,
        n.updated_at AS neighbor_updated_at
      FROM traversal t
      INNER JOIN memory_items n ON n.id = t.node_id
      ORDER BY t.depth ASC, n.title ASC, t.id ASC
      LIMIT ?
    `).all(...baseParams, ...recursiveParams, filters.limit) as NeighborRow[];

    const deduped = new Map<string, NeighborRow>();
    for (const row of rows) {
      const key = `${row.neighbor_id}:${row.direction}:${row.relation_type}`;
      const existing = deduped.get(key);
      if (!existing || row.depth < existing.depth || (row.depth === existing.depth && row.id.localeCompare(existing.id) < 0)) {
        deduped.set(key, row);
      }
    }

    return [...deduped.values()]
      .sort((left, right) => left.depth - right.depth || left.neighbor_title.localeCompare(right.neighbor_title) || left.id.localeCompare(right.id))
      .slice(0, filters.limit)
      .map(mapNeighborRow);
  } catch (error) {
    if (error instanceof CoreError) {
      throw error;
    }

    throw new CoreError(
      `Failed to list memory neighbors: ${error instanceof Error ? error.message : String(error)}`,
      "DATABASE",
      error instanceof Error ? error : undefined
    );
  }
}

function normalizeCreateEdgeInput(input: CreateEdgeData): CreateEdgeData & { status: EdgeStatus } {
  const status = input.status ?? (input.origin === "manual" ? "accepted" : "suggested");

  if (input.origin === "llm" && status !== "suggested") {
    throw new CoreError("LLM-created edges must start in suggested status", "VALIDATION");
  }

  validateAcceptedState(status, input.acceptedBy ?? null);

  return {
    ...input,
    status,
    acceptedBy: status === "accepted" ? input.acceptedBy ?? null : null,
  };
}

function assertWorkspaceMemory(ctx: CoreContext, memoryId: string, fieldName: string): void {
  if (!memoryItemExists(ctx, memoryId)) {
    throw new CoreError(`${fieldName} '${memoryId}' not found in workspace '${ctx.workspace}'`, "NOT_FOUND");
  }
}

function resolveAcceptedBy(
  input: { status?: EdgeStatus; acceptedBy?: EdgeAcceptanceProvenance | null },
  existingStatus: EdgeStatus,
  existingAcceptedBy: EdgeAcceptanceProvenance | null
): EdgeAcceptanceProvenance | null {
  const nextStatus = input.status ?? existingStatus;

  if (nextStatus !== "accepted") {
    return null;
  }

  if (input.acceptedBy !== undefined) {
    return input.acceptedBy;
  }

  return existingAcceptedBy;
}

function validateAcceptedState(
  status: EdgeStatus,
  acceptedBy: EdgeAcceptanceProvenance | null
): void {
  if (status === "accepted" && acceptedBy === null) {
    throw new CoreError("acceptedBy is required when edge status is accepted", "VALIDATION");
  }

  if (status !== "accepted" && acceptedBy !== null) {
    throw new CoreError("acceptedBy can only be set when edge status is accepted", "VALIDATION");
  }
}

function getEdgeById(ctx: CoreContext, edgeId: string): MemoryEdge | null {
  const row = ctx.db.db.prepare(`
    SELECT e.*
    FROM memory_edges e
    INNER JOIN memory_items src ON src.id = e.from_memory_id
    INNER JOIN memory_items dst ON dst.id = e.to_memory_id
    WHERE e.id = ?
      AND src.workspace = ?
      AND dst.workspace = ?
  `).get(edgeId, ctx.workspace, ctx.workspace) as EdgeRow | undefined;

  return row ? mapEdgeRow(row) : null;
}

function getEdgeByCanonicalKey(
  ctx: CoreContext,
  fromMemoryId: string,
  toMemoryId: string,
  relationType: EdgeRelationType
): MemoryEdge | null {
  const row = ctx.db.db.prepare(`
    SELECT e.*
    FROM memory_edges e
    INNER JOIN memory_items src ON src.id = e.from_memory_id
    INNER JOIN memory_items dst ON dst.id = e.to_memory_id
    WHERE e.from_memory_id = ?
      AND e.to_memory_id = ?
      AND e.relation_type = ?
      AND src.workspace = ?
      AND dst.workspace = ?
  `).get(fromMemoryId, toMemoryId, relationType, ctx.workspace, ctx.workspace) as EdgeRow | undefined;

  return row ? mapEdgeRow(row) : null;
}

function getExistingEquivalentEdge(
  ctx: CoreContext,
  fromMemoryId: string,
  toMemoryId: string,
  relationType: EdgeRelationType
): MemoryEdge | null {
  const direct = getEdgeByCanonicalKey(ctx, fromMemoryId, toMemoryId, relationType);
  if (direct) {
    return direct;
  }

  if (!isSymmetricEdgeRelation(relationType)) {
    return null;
  }

  return getEdgeByCanonicalKey(ctx, toMemoryId, fromMemoryId, relationType);
}

function buildEdgeFilter(
  alias: string,
  input: Pick<ListNeighborsData, "relationTypes" | "origins" | "statuses">
): { clause: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];

  if (input.relationTypes && input.relationTypes.length > 0) {
    conditions.push(`${alias}.relation_type IN (${input.relationTypes.map(() => "?").join(", ")})`);
    params.push(...input.relationTypes);
  }

  if (input.origins && input.origins.length > 0) {
    conditions.push(`${alias}.origin IN (${input.origins.map(() => "?").join(", ")})`);
    params.push(...input.origins);
  }

  if (input.statuses && input.statuses.length > 0) {
    conditions.push(`${alias}.status IN (${input.statuses.map(() => "?").join(", ")})`);
    params.push(...input.statuses);
  }

  return {
    clause: conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

function mapEdgeRow(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    relationType: row.relation_type as EdgeRelationType,
    confidence: row.confidence,
    origin: row.origin as EdgeOrigin,
    status: row.status as EdgeStatus,
    justification: row.justification,
    acceptedBy: row.accepted_by as EdgeAcceptanceProvenance | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNeighborRow(row: NeighborRow): MemoryNeighbor {
  return {
    memory: mapRowToMemoryItem({
      id: row.neighbor_id,
      type: row.neighbor_type,
      title: row.neighbor_title,
      content: row.neighbor_content,
      summary: row.neighbor_summary,
      source: row.neighbor_source,
      scope: row.neighbor_scope,
      workspace: row.neighbor_workspace,
      tags: row.neighbor_tags,
      importance: row.neighbor_importance,
      status: row.neighbor_status,
      supersedes_id: row.neighbor_supersedes_id,
      content_hash: row.neighbor_content_hash,
      created_at: row.neighbor_created_at,
      updated_at: row.neighbor_updated_at,
    }),
    edge: mapEdgeRow(row),
    direction: row.direction,
    depth: row.depth,
  };
}
