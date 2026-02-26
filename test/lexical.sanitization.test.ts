import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createHash } from "node:crypto";
import { openDatabase, closeDatabase, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { searchLexical } from "../src/search/lexical.js";

type SeedRow = {
  id: string;
  title: string;
  content: string;
  status?: "active" | "archived" | "deleted" | "pending";
  type?: "fact" | "decision" | "preference" | "event" | "goal" | "todo";
  scope?: "workspace" | "global" | "user";
  workspace?: string;
};

function createTestDb(): { handle: DbHandle; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zmem-lexical-test-"));
  const dbPath = join(dir, "test.db");
  const handle = openDatabase(dbPath);
  runMigrations(handle);

  return {
    handle,
    cleanup: () => {
      closeDatabase(handle);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedMemory(handle: DbHandle, rows: SeedRow[]): void {
  const now = new Date().toISOString();
  const stmt = handle.db.prepare(`
    INSERT INTO memory_items (
      id, type, title, content, summary, source, scope, workspace,
      tags, importance, status, supersedes_id, content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'test', ?, ?, '[]', 0.5, ?, NULL, ?, ?, ?)
  `);

  for (const row of rows) {
    const status = row.status ?? "active";
    const type = row.type ?? "fact";
    const scope = row.scope ?? "workspace";
    const workspace = row.workspace ?? "ws-test";
    const contentHash = createHash("sha256").update(row.content).digest("hex");

    stmt.run(
      row.id,
      type,
      row.title,
      row.content,
      scope,
      workspace,
      status,
      contentHash,
      now,
      now
    );
  }
}

function makeNoisyCorpus(size: number, workspace = "ws-scale"): SeedRow[] {
  const rows: SeedRow[] = [];
  for (let i = 0; i < size; i += 1) {
    rows.push({
      id: `noise_${i}`,
      title: `Noise document ${i}`,
      content: `Random operational text ${i} telemetry cache queue shard replication heartbeat`,
      workspace,
    });
  }
  return rows;
}

test("lexical handles punctuation-heavy query safely", () => {
  const { handle, cleanup } = createTestDb();
  try {
    seedMemory(handle, [
      {
        id: "doc_1",
        title: "OAuth token flow beta",
        content: "Use oauth2 token beta users flow for auth exchange in gateway",
      },
    ]);

    const hits = searchLexical(handle, {
      query: `oauth2/token (beta) user's-flow`,
      workspace: "ws-test",
      topK: 10,
    });

    assert.equal(hits.length > 0, true);
    assert.equal(hits[0].id, "doc_1");
  } finally {
    cleanup();
  }
});

test("lexical returns empty for non-tokenizable query", () => {
  const { handle, cleanup } = createTestDb();
  try {
    seedMemory(handle, [{ id: "doc_1", title: "A", content: "B" }]);
    const hits = searchLexical(handle, {
      query: "/// --- !!!",
      workspace: "ws-test",
      topK: 10,
    });
    assert.equal(hits.length, 0);
  } finally {
    cleanup();
  }
});

test("lexical falls back from strict AND to OR when needed", () => {
  const { handle, cleanup } = createTestDb();
  try {
    seedMemory(handle, [
      {
        id: "doc_1",
        title: "Postgres decision",
        content: "We chose postgres as primary database backend",
      },
    ]);

    const hits = searchLexical(handle, {
      query: "postgres nonexistenttoken",
      workspace: "ws-test",
      topK: 10,
    });

    assert.equal(hits.length > 0, true);
    assert.equal(hits[0].id, "doc_1");
  } finally {
    cleanup();
  }
});

test("status filtering supports active-only and active+archived", () => {
  const { handle, cleanup } = createTestDb();
  try {
    seedMemory(handle, [
      {
        id: "active_1",
        title: "Current architecture",
        content: "current architecture decision",
        status: "active",
      },
      {
        id: "archived_1",
        title: "Old architecture",
        content: "old architecture decision",
        status: "archived",
      },
    ]);

    const activeHits = searchLexical(handle, {
      query: "architecture decision",
      workspace: "ws-test",
      topK: 10,
      statuses: ["active"],
    });
    assert.equal(activeHits.some((h) => h.id === "active_1"), true);
    assert.equal(activeHits.some((h) => h.id === "archived_1"), false);

    const bothHits = searchLexical(handle, {
      query: "architecture decision",
      workspace: "ws-test",
      topK: 10,
      statuses: ["active", "archived"],
    });
    assert.equal(bothHits.some((h) => h.id === "active_1"), true);
    assert.equal(bothHits.some((h) => h.id === "archived_1"), true);
  } finally {
    cleanup();
  }
});

test("lexical scale test across varying corpus sizes", () => {
  const { handle, cleanup } = createTestDb();
  try {
    const sizes = [100, 1000, 5000];
    for (const size of sizes) {
      handle.db.prepare("DELETE FROM memory_items").run();

      const rows = makeNoisyCorpus(size);
      rows.push({
        id: `target_${size}`,
        title: `Database migration strategy ${size}`,
        content: `Postgres migration strategy and rollback plan token_${size}`,
        workspace: "ws-scale",
      });
      seedMemory(handle, rows);

      const started = performance.now();
      const hits = searchLexical(handle, {
        query: `postgres migration token_${size}`,
        workspace: "ws-scale",
        topK: 10,
      });
      const elapsedMs = performance.now() - started;

      assert.equal(hits.some((h) => h.id === `target_${size}`), true);
      assert.equal(elapsedMs < 1500, true, `Expected search under 1500ms for size=${size}, got ${elapsedMs.toFixed(1)}ms`);
    }
  } finally {
    cleanup();
  }
});
