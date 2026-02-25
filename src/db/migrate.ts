import type { DbHandle } from "./index.js";

export function runMigrations(handle: DbHandle): void {
  const { db } = handle;

  // Main memory items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('fact', 'decision', 'preference', 'event', 'goal', 'todo')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('global', 'workspace', 'user')),
      workspace TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'archived', 'deleted')),
      supersedes_id TEXT,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (supersedes_id) REFERENCES memory_items(id) ON DELETE SET NULL
    );
  `);

  // Indexes for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_workspace ON memory_items(workspace);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_scope ON memory_items(scope);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items(type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_status ON memory_items(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_status ON memory_items(workspace, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_supersedes ON memory_items(supersedes_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_content_hash ON memory_items(content_hash);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_source_workspace_status ON memory_items(source, workspace, status);`);

  // Content chunks table for embedding storage
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_chunks (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      pos INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
      UNIQUE(memory_id, seq)
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_memory ON content_chunks(memory_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_deleted ON content_chunks(deleted_at) WHERE deleted_at IS NULL;`);

  // Track which chunks have been embedded (zvec stores the actual vectors)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      embedded_at TEXT NOT NULL,
      model TEXT NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES content_chunks(id) ON DELETE CASCADE
    );
  `);

  // FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
      title,
      content,
      tags,
      content_rowid,
      tokenize='porter unicode61'
    );
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items
    WHEN new.status = 'active'
    BEGIN
      INSERT INTO memory_items_fts(content_rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items
    BEGIN
      DELETE FROM memory_items_fts WHERE content_rowid = old.rowid;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items
    WHEN old.status = 'active' OR new.status = 'active'
    BEGIN
      DELETE FROM memory_items_fts WHERE content_rowid = old.rowid;
      INSERT INTO memory_items_fts(content_rowid, title, content, tags)
      SELECT new.rowid, new.title, new.content, new.tags
      WHERE new.status = 'active';
    END;
  `);

  // Migration tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // Insert migration record
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (1, datetime('now'))
  `).run();

  // Migration v2: Fix broken FTS UPDATE trigger (was missing re-insert)
  const v2Applied = db.prepare(
    `SELECT 1 FROM schema_migrations WHERE version = 2`
  ).get();

  if (!v2Applied) {
    db.exec(`DROP TRIGGER IF EXISTS memory_items_au;`);
    db.exec(`
      CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items
      WHEN old.status = 'active' OR new.status = 'active'
      BEGIN
        DELETE FROM memory_items_fts WHERE content_rowid = old.rowid;
        INSERT INTO memory_items_fts(content_rowid, title, content, tags)
        SELECT new.rowid, new.title, new.content, new.tags
        WHERE new.status = 'active';
      END;
    `);

    db.prepare(`
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (2, datetime('now'))
    `).run();
  }

  const v3Applied = db.prepare(
    `SELECT 1 FROM schema_migrations WHERE version = 3`
  ).get();

  if (!v3Applied) {
    db.exec(`PRAGMA foreign_keys = OFF;`);
    try {
      db.exec(`BEGIN TRANSACTION;`);

      db.exec(`
      CREATE TABLE memory_items_v3 (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('fact', 'decision', 'preference', 'event', 'goal', 'todo')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'workspace', 'user')),
        workspace TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'archived', 'deleted')),
        supersedes_id TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (supersedes_id) REFERENCES memory_items_v3(id) ON DELETE SET NULL
      );
      `);

      db.exec(`
      INSERT INTO memory_items_v3 (
        id, type, title, content, summary, source, scope, workspace,
        tags, importance, status, supersedes_id, content_hash, created_at, updated_at
      )
      SELECT
        id, type, title, content, summary, source, scope, workspace,
        tags, importance, status, supersedes_id, content_hash, created_at, updated_at
      FROM memory_items;
      `);

      db.exec(`DROP TABLE memory_items;`);
      db.exec(`ALTER TABLE memory_items_v3 RENAME TO memory_items;`);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_workspace ON memory_items(workspace);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_scope ON memory_items(scope);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items(type);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_status ON memory_items(status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_status ON memory_items(workspace, status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_supersedes ON memory_items(supersedes_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_content_hash ON memory_items(content_hash);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_items_source_workspace_status ON memory_items(source, workspace, status);`);

      db.exec(`DROP TRIGGER IF EXISTS memory_items_ai;`);
      db.exec(`DROP TRIGGER IF EXISTS memory_items_ad;`);
      db.exec(`DROP TRIGGER IF EXISTS memory_items_au;`);

      db.exec(`
      CREATE TRIGGER memory_items_ai AFTER INSERT ON memory_items
      WHEN new.status = 'active'
      BEGIN
        INSERT INTO memory_items_fts(content_rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      `);

      db.exec(`
      CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items
      BEGIN
        DELETE FROM memory_items_fts WHERE content_rowid = old.rowid;
      END;
      `);

      db.exec(`
      CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items
      WHEN old.status = 'active' OR new.status = 'active'
      BEGIN
        DELETE FROM memory_items_fts WHERE content_rowid = old.rowid;
        INSERT INTO memory_items_fts(content_rowid, title, content, tags)
        SELECT new.rowid, new.title, new.content, new.tags
        WHERE new.status = 'active';
      END;
      `);

      db.exec(`DELETE FROM memory_items_fts;`);
      db.exec(`
      INSERT INTO memory_items_fts(content_rowid, title, content, tags)
      SELECT rowid, title, content, tags
      FROM memory_items
      WHERE status = 'active';
      `);

      db.prepare(`
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (3, datetime('now'))
      `).run();

      db.exec(`COMMIT;`);
    } catch (error) {
      db.exec(`ROLLBACK;`);
      throw error;
    } finally {
      db.exec(`PRAGMA foreign_keys = ON;`);
    }
  }
}
