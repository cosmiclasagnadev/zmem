import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, closeDatabase, persistMemoryEdge, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  createHeuristicMemoryItemReranker,
  type MemoryRollup,
  type QueryHit,
} from "../src/search/index.js";

const WORKSPACE = "ws-search-rerank-test";

type SeedMemory = {
  id: string;
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  importance?: number;
  type?: "fact" | "decision" | "preference" | "event" | "goal" | "todo";
  status?: "active" | "archived";
  supersedesId?: string | null;
};

function createTestHandle(): { handle: DbHandle; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zmem-search-rerank-test-"));
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

function seedMemories(handle: DbHandle, memories: SeedMemory[]): void {
  const now = new Date().toISOString();
  const insertMemory = handle.db.prepare(`
    INSERT INTO memory_items (
      id, type, title, content, summary, source, scope, workspace,
      tags, importance, status, supersedes_id, content_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'test', 'workspace', ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const memory of memories) {
    insertMemory.run(
      memory.id,
      memory.type ?? "fact",
      memory.title,
      memory.content,
      memory.summary ?? "",
      WORKSPACE,
      JSON.stringify(memory.tags ?? []),
      memory.importance ?? 0.5,
      memory.status ?? "active",
      memory.supersedesId ?? null,
      createHash("sha256").update(memory.content).digest("hex"),
      now,
      now
    );
  }
}

function seedEdge(handle: DbHandle, input: {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType?: "related_to" | "supports" | "contradicts" | "caused_by" | "derived_from" | "preferred_with";
  status: "suggested" | "accepted" | "rejected";
  origin: "manual" | "llm";
  confidence?: number;
}): void {
  persistMemoryEdge(handle, {
    id: input.id,
    fromMemoryId: input.fromMemoryId,
    toMemoryId: input.toMemoryId,
    relationType: input.relationType ?? "related_to",
    confidence: input.confidence ?? 0.92,
    origin: input.origin,
    status: input.status,
    justification: `test edge ${input.id}`,
    acceptedBy: input.status === "accepted" ? "user" : null,
  });
}

function makeCandidate(id: string, title: string, score: number, type: QueryHit["type"] = "fact"): QueryHit {
  return {
    id,
    title,
    score,
    source: "lex",
    snippet: `${title} snippet`,
    scope: "workspace",
    type,
  };
}

function makeRollup(id: string, title: string, score: number, type: QueryHit["type"] = "fact"): MemoryRollup {
  return {
    memoryId: id,
    title,
    score,
    source: "lex",
    snippet: `${title} snippet`,
    scope: "workspace",
    type,
    evidence: {
      bestHitScore: score,
      multiChunkSupport: 0,
      chunkDiversity: 0,
      totalChunkHits: 1,
      supportingChunkCount: 0,
      uniqueChunkCount: 1,
      uniqueSources: ["lex"],
      bestChunkId: `${id}_0`,
      bestSnippet: `${title} snippet`,
      supportingScoreSum: 0,
      averageSupportingScore: 0,
    },
    debug: {
      hits: [
        {
          chunkId: `${id}_0`,
          score,
          source: "lex",
          snippet: `${title} snippet`,
        },
      ],
    },
  };
}

test("reranking changes order in a controlled metadata-heavy scenario", () => {
  const { handle, cleanup } = createTestHandle();

  try {
    seedMemories(handle, [
      {
        id: "mem_base",
        title: "General migration notes",
        content: "General notes about the rollout.",
        importance: 0.35,
        tags: ["ops"],
      },
      {
        id: "mem_promoted",
        title: "Architecture decision rollout",
        content: "Decision rationale for the rollout architecture.",
        summary: "Architecture decision rationale and rollout plan.",
        importance: 0.94,
        type: "decision",
        tags: ["architecture", "decision"],
      },
    ]);

    const reranker = createHeuristicMemoryItemReranker();
    const results = reranker.rerank({
      db: handle,
      workspace: WORKSPACE,
      query: "architecture decision rollout",
      topK: 5,
      candidates: [
        makeCandidate("mem_base", "General migration notes", 0.76),
        makeCandidate("mem_promoted", "Architecture decision rollout", 0.69, "decision"),
      ],
      rollupsById: new Map([
        ["mem_base", makeRollup("mem_base", "General migration notes", 0.76)],
        ["mem_promoted", makeRollup("mem_promoted", "Architecture decision rollout", 0.69, "decision")],
      ]),
    });

    assert.deepEqual(results.map((result) => result.id), ["mem_promoted", "mem_base"]);
    assert.match(results[0]?.explanation ?? "", /metadata match/i);
    assert.match(results[0]?.explanation ?? "", /high-importance item/i);
  } finally {
    cleanup();
  }
});

test("suggested edges have lower rerank impact than accepted manual edges", () => {
  const { handle, cleanup } = createTestHandle();

  try {
    seedMemories(handle, [
      {
        id: "mem_seed",
        title: "Related context seed",
        content: "Seed context for the project.",
      },
      {
        id: "mem_manual",
        title: "Accepted supporting note",
        content: "Accepted supporting note for the project.",
      },
      {
        id: "mem_suggested",
        title: "Suggested supporting note",
        content: "Suggested supporting note for the project.",
      },
    ]);

    seedEdge(handle, {
      id: "edge-accepted-manual",
      fromMemoryId: "mem_seed",
      toMemoryId: "mem_manual",
      status: "accepted",
      origin: "manual",
    });
    seedEdge(handle, {
      id: "edge-suggested-llm",
      fromMemoryId: "mem_seed",
      toMemoryId: "mem_suggested",
      status: "suggested",
      origin: "llm",
    });

    const reranker = createHeuristicMemoryItemReranker();
    const results = reranker.rerank({
      db: handle,
      workspace: WORKSPACE,
      query: "related context",
      topK: 5,
      candidates: [
        makeCandidate("mem_seed", "Related context seed", 0.84),
        makeCandidate("mem_manual", "Accepted supporting note", 0.52),
        makeCandidate("mem_suggested", "Suggested supporting note", 0.52),
      ],
      rollupsById: new Map([
        ["mem_seed", makeRollup("mem_seed", "Related context seed", 0.84)],
        ["mem_manual", makeRollup("mem_manual", "Accepted supporting note", 0.52)],
        ["mem_suggested", makeRollup("mem_suggested", "Suggested supporting note", 0.52)],
      ]),
    });

    assert.deepEqual(results.map((result) => result.id), ["mem_seed", "mem_manual", "mem_suggested"]);
    assert.match(results[1]?.explanation ?? "", /accepted manual link/i);
    assert.match(results[2]?.explanation ?? "", /suggested link/i);
    assert(results[1]!.signals.graph > results[2]!.signals.graph, "accepted manual edge should outscore suggested edge");
  } finally {
    cleanup();
  }
});

test("lineage signals can surface useful history-aware results", () => {
  const { handle, cleanup } = createTestHandle();

  try {
    seedMemories(handle, [
      {
        id: "mem_old",
        title: "Old rollout baseline",
        content: "Previous rollout baseline before the migration.",
        status: "archived",
      },
      {
        id: "mem_current",
        title: "Current rollout summary",
        content: "Current rollout summary after the migration.",
        supersedesId: "mem_old",
        type: "event",
      },
      {
        id: "mem_unrelated",
        title: "Unrelated rollout note",
        content: "Another note with mild lexical overlap.",
      },
    ]);

    const reranker = createHeuristicMemoryItemReranker();
    const results = reranker.rerank({
      db: handle,
      workspace: WORKSPACE,
      query: "what changed before the rollout",
      topK: 5,
      candidates: [
        makeCandidate("mem_current", "Current rollout summary", 0.79, "event"),
        makeCandidate("mem_unrelated", "Unrelated rollout note", 0.58),
        makeCandidate("mem_old", "Old rollout baseline", 0.54),
      ],
      rollupsById: new Map([
        ["mem_current", makeRollup("mem_current", "Current rollout summary", 0.79, "event")],
        ["mem_unrelated", makeRollup("mem_unrelated", "Unrelated rollout note", 0.58)],
        ["mem_old", makeRollup("mem_old", "Old rollout baseline", 0.54)],
      ]),
    });

    assert.deepEqual(results.map((result) => result.id), ["mem_current", "mem_old", "mem_unrelated"]);
    assert.match(results[1]?.explanation ?? "", /same history chain/i);
    assert(results[1]!.signals.lineage > 0, "expected archived predecessor to receive lineage boost");
  } finally {
    cleanup();
  }
});

test("explanations reflect the actual applied rerank signals", () => {
  const { handle, cleanup } = createTestHandle();

  try {
    seedMemories(handle, [
      {
        id: "mem_explain_seed",
        title: "Decision seed",
        content: "Seed decision context.",
        type: "decision",
      },
      {
        id: "mem_explain_candidate",
        title: "Architecture decision rationale",
        content: "Detailed rationale for the architecture decision.",
        summary: "Architecture decision rationale.",
        type: "decision",
        importance: 0.9,
        tags: ["architecture", "decision"],
      },
    ]);

    seedEdge(handle, {
      id: "edge-explain",
      fromMemoryId: "mem_explain_seed",
      toMemoryId: "mem_explain_candidate",
      relationType: "supports",
      status: "accepted",
      origin: "manual",
      confidence: 0.97,
    });

    const reranker = createHeuristicMemoryItemReranker();
    const results = reranker.rerank({
      db: handle,
      workspace: WORKSPACE,
      query: "why did we choose this architecture decision",
      topK: 5,
      candidates: [
        makeCandidate("mem_explain_seed", "Decision seed", 0.82, "decision"),
        makeCandidate("mem_explain_candidate", "Architecture decision rationale", 0.67, "decision"),
      ],
      rollupsById: new Map([
        ["mem_explain_seed", makeRollup("mem_explain_seed", "Decision seed", 0.82, "decision")],
        ["mem_explain_candidate", makeRollup("mem_explain_candidate", "Architecture decision rationale", 0.67, "decision")],
      ]),
    });

    const explained = results.find((result) => result.id === "mem_explain_candidate");
    assert.ok(explained, "expected explanation candidate to remain in results");
    assert.match(explained.explanation ?? "", /metadata match/i);
    assert.match(explained.explanation ?? "", /accepted manual link/i);
    assert.match(explained.explanation ?? "", /high-importance item/i);
  } finally {
    cleanup();
  }
});
