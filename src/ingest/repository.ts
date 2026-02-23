import type { DbHandle } from "../db/index.js";
import type { ParsedDocument, Chunk } from "./types.js";
import type { MemoryType } from "../types/memory.js";

export interface ExistingDocument {
  id: string;
  contentHash: string;
  status: string;
}

/**
 * Check if document exists and get its current state
 */
export function findExistingDocument(
  db: DbHandle,
  source: string,
  workspace: string
): ExistingDocument | null {
  const row = db.db
    .prepare(
      `
      SELECT id, content_hash, status
      FROM memory_items
      WHERE source = ? AND workspace = ? AND status = 'active'
    `
    )
    .get(source, workspace) as
    | { id: string; content_hash: string; status: string }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    contentHash: row.content_hash,
    status: row.status,
  };
}

/**
 * Insert a new memory item
 */
export function insertMemoryItem(
  db: DbHandle,
  doc: ParsedDocument
): string {
  const now = new Date().toISOString();
  const id = doc.id;

  db.db
    .prepare(
      `
      INSERT INTO memory_items (
        id, type, title, content, summary, source, scope, workspace,
        tags, importance, status, supersedes_id, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      id,
      doc.frontmatter.type || "fact",
      doc.title,
      doc.content,
      "", // summary (empty for now)
      doc.source,
      "workspace", // default scope
      doc.workspace,
      JSON.stringify(doc.frontmatter.tags || []),
      doc.frontmatter.importance || 0.5,
      "active",
      null, // supersedes_id
      doc.contentHash,
      now,
      now
    );

  return id;
}

/**
 * Update an existing memory item (new version)
 */
export function updateMemoryItem(
  db: DbHandle,
  oldId: string,
  doc: ParsedDocument
): string {
  const now = new Date().toISOString();
  const newId = doc.id;

  const doUpdate = db.db.transaction(() => {
    db.db
      .prepare(
        `
        UPDATE content_chunks
        SET deleted_at = ?
        WHERE memory_id = ?
      `
      )
      .run(now, oldId);

    db.db
      .prepare(
        `
        UPDATE memory_items
        SET status = 'archived', updated_at = ?
        WHERE id = ?
      `
      )
      .run(now, oldId);

    db.db
      .prepare(
        `
        INSERT INTO memory_items (
          id, type, title, content, summary, source, scope, workspace,
          tags, importance, status, supersedes_id, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        newId,
        doc.frontmatter.type || "fact",
        doc.title,
        doc.content,
        "",
        doc.source,
        "workspace",
        doc.workspace,
        JSON.stringify(doc.frontmatter.tags || []),
        doc.frontmatter.importance || 0.5,
        "active",
        oldId,
        doc.contentHash,
        now,
        now
      );
  });

  doUpdate();
  return newId;
}

/**
 * Insert chunks for a memory item
 */
export function insertChunks(
  db: DbHandle,
  memoryId: string,
  chunks: Chunk[]
): string[] {
  const now = new Date().toISOString();
  const chunkIds: string[] = [];

  const insert = db.db.prepare(
    `
    INSERT INTO content_chunks (id, memory_id, seq, pos, token_count, chunk_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  );

  for (const chunk of chunks) {
    const chunkId = `${memoryId}_${chunk.seq}`;
    chunkIds.push(chunkId);

    insert.run(
      chunkId,
      memoryId,
      chunk.seq,
      chunk.pos,
      chunk.tokenCount,
      chunk.text,
      now
    );
  }

  return chunkIds;
}

/**
 * Mark chunks as embedded
 */
export function markChunksEmbedded(
  db: DbHandle,
  chunkIds: string[],
  model: string
): void {
  const now = new Date().toISOString();

  const insert = db.db.prepare(
    `
    INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedded_at, model)
    VALUES (?, ?, ?)
  `
  );

  for (const chunkId of chunkIds) {
    insert.run(chunkId, now, model);
  }
}

/**
 * Get all active document sources in a workspace
 */
export function getActiveDocumentSources(
  db: DbHandle,
  workspace: string
): string[] {
  const rows = db.db
    .prepare(
      `
      SELECT source FROM memory_items
      WHERE workspace = ? AND status = 'active'
    `
    )
    .all(workspace) as Array<{ source: string }>;

  return rows.map((r) => r.source);
}

/**
 * Soft-delete documents that are no longer present
 */
export function softDeleteMissingDocuments(
  db: DbHandle,
  workspace: string,
  existingSources: string[]
): number {
  const now = new Date().toISOString();

  const placeholders = existingSources.map(() => "?").join(",");
  const query = `
    UPDATE memory_items
    SET status = 'deleted', updated_at = ?
    WHERE workspace = ? 
      AND status = 'active'
      AND source NOT IN (${placeholders || "''"})
  `;

  const result = db.db.prepare(query).run(now, workspace, ...existingSources);

  return result.changes;
}

/**
 * Get ingestion statistics
 */
export function getIngestStats(db: DbHandle, workspace: string) {
  const stats = db.db
    .prepare(
      `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) as deleted,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived
      FROM memory_items
      WHERE workspace = ?
    `
    )
    .get(workspace) as {
    total: number;
    active: number;
    deleted: number;
    archived: number;
  };

  const chunkCount = db.db
    .prepare(
      `
      SELECT COUNT(*) as count
      FROM content_chunks c
      JOIN memory_items m ON c.memory_id = m.id
      WHERE m.workspace = ? AND c.deleted_at IS NULL
    `
    )
    .get(workspace) as { count: number };

  return {
    ...stats,
    chunks: chunkCount.count,
  };
}
