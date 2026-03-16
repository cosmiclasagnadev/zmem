import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadAppConfig } from "../src/config/loadConfig.js";
import { resolveStoragePaths } from "../src/storage/paths.js";
import { openDatabase, closeDatabase, persistMemoryEdge, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { createEmbeddingProvider } from "../src/embed/factory.js";
import type { EmbeddingProvider } from "../src/embed/types.js";
import {
  createCoreContext,
  createSaveEdgeSuggestionProvider,
  save,
  get,
  list,
  listNeighbors,
  recall,
  deleteMemory,
  reindex,
  status,
  type CoreContext,
  type EdgeSuggestionGenerator,
  type EdgeSuggestionProvider,
} from "../src/core/index.js";
import { ingestWorkspace, getIngestStats } from "../src/ingest/index.js";
import { initializeVectorStore, type VectorCollection, type VectorStore } from "../src/vectors/index.js";
import {
  CLI_SEARCH_EXPECTED_GRAPH_TITLE,
  CLI_SEARCH_EXPECTED_QUERY_TITLE,
  CLI_SEARCH_EXPECTED_RECENT_TITLE,
  CLI_SEARCH_GRAPH_QUERY,
  CLI_SEARCH_PRIMARY_QUERY,
  CLI_SEARCH_REGRESSION_WORKSPACE,
  CLI_SEARCH_TYPED_ALLOWED_TYPES,
  CLI_SEARCH_TYPED_DISALLOWED_TITLES,
  cliSearchRegressionEdges,
  cliSearchRegressionMemories,
  type CliRegressionEdgeFixture,
  type CliRegressionMemoryFixture,
} from "../test/fixtures/cli-search-regression.js";
import {
  EVALUATION_REGRESSION_WORKSPACE,
  evaluationRegressionEdges,
  evaluationRegressionMemories,
  evaluationRegressionScenarios,
} from "../test/fixtures/evaluation-regression.js";

const smokeStorageBaseDir = mkdtempSync(join(tmpdir(), "zmem-smoke-storage-"));
process.env.ZMEM_STORAGE_BASE_DIR = smokeStorageBaseDir;
process.env.ZMEM_DB_PATH = join(smokeStorageBaseDir, "smoke-memory.db");
process.env.ZMEM_ZVEC_PATH = join(smokeStorageBaseDir, "smoke-vectors");
process.env.ZMEM_QUERY_EXPANSION_PROVIDER = "deterministic";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectThrows(fn: () => Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    console.log(`[smoke] PASS ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[smoke] FAIL ${name}: ${message}`);
    throw error;
  }
}

function parseCliTitles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\d+\.\s+(.+)$/);
      return match ? [match[1].trim()] : [];
    });
}

function parseCliTypes(output: string): string[] {
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/Type:\s+([a-z]+)/i);
      return match ? [match[1].toLowerCase()] : [];
    });
}

class Harness {
  private readonly config = loadAppConfig("./config.json", { silent: true });
  private readonly collections = new Map<string, VectorCollection>();
  private db: DbHandle | null = null;
  private vectorStore: VectorStore | null = null;
  private embedProvider: EmbeddingProvider | null = null;

  async init(): Promise<void> {
    const storage = resolveStoragePaths(this.config, "smoke-harness");
    mkdirSync(storage.zvecPath, { recursive: true });
    mkdirSync(dirname(storage.dbPath), { recursive: true });

    this.db = openDatabase(storage.dbPath);
    runMigrations(this.db);

    this.vectorStore = await initializeVectorStore({ zvecPath: storage.zvecPath });

    this.embedProvider = createEmbeddingProvider({
      provider: this.config.ai.embedding.provider,
      model: this.config.ai.embedding.model,
      dimensions: this.config.ai.embedding.dimensions,
      batchSize: this.config.ai.embedding.batchSize,
      maxTokens: this.config.ai.embedding.maxTokens,
    });
    await this.embedProvider.initialize();
  }

  context(workspace: string, edgeSuggestionProvider?: EdgeSuggestionProvider): CoreContext {
    assert(this.db, "DB not initialized");
    assert(this.vectorStore, "Vector store not initialized");
    assert(this.embedProvider, "Embedding provider not initialized");

    const collection =
      this.collections.get(workspace) ??
      this.vectorStore.openCollection(workspace) ??
      this.vectorStore.createCollection(workspace, this.config.ai.embedding.dimensions);
    this.collections.set(workspace, collection);

    return createCoreContext({
      db: this.db,
      embedProvider: this.embedProvider,
      vectorCollection: collection,
      workspace,
      config: this.config,
      edgeSuggestionProvider,
    });
  }

  createCollectionRaw(workspace: string): VectorCollection {
    assert(this.vectorStore, "Vector store not initialized");
    return this.vectorStore.createCollection(workspace, this.config.ai.embedding.dimensions);
  }

  closeWorkspaceCollection(workspace: string): void {
    const collection = this.collections.get(workspace);
    if (!collection) {
      return;
    }

    collection.close();
    this.collections.delete(workspace);
  }

  async ingestDocs(workspace: string, workspacePath: string): Promise<void> {
    assert(this.db, "DB not initialized");
    assert(this.embedProvider, "Embedding provider not initialized");
    const collection =
      this.collections.get(workspace) ??
      this.vectorStore?.openCollection(workspace) ??
      this.vectorStore?.createCollection(workspace, this.config.ai.embedding.dimensions);
    assert(collection, "Vector collection not initialized");
    this.collections.set(workspace, collection);

    await ingestWorkspace({
      workspace,
      workspacePath,
      patterns: ["**/*.md"],
      db: this.db,
      vectorStore: collection,
      embedProvider: this.embedProvider,
    });
  }

  resetWorkspace(workspace: string): void {
    assert(this.db, "DB not initialized");

    const openCollection = this.collections.get(workspace);
    const memoryRows = this.db.db
      .prepare(`SELECT id FROM memory_items WHERE workspace = ?`)
      .all(workspace) as Array<{ id: string }>;
    const memoryIds = memoryRows.map((row) => row.id);
    const vectorIds = memoryIds.length === 0
      ? []
      : (this.db.db
          .prepare(`SELECT id FROM content_chunks WHERE memory_id IN (${memoryIds.map(() => "?").join(", ")})`)
          .all(...memoryIds) as Array<{ id: string }>);

    const collection =
      openCollection ??
      this.vectorStore?.openCollection(workspace) ??
      null;

    if (collection) {
      for (const row of vectorIds) {
        collection.delete(row.id);
      }
    }

    openCollection?.close();
    this.collections.delete(workspace);
    if (collection && collection !== openCollection) {
      collection.close();
    }

    this.db.db.prepare(`DELETE FROM memory_items WHERE workspace = ?`).run(workspace);
  }

  seedWorkspaceFixtures(
    workspace: string,
    memories: Array<
      Omit<CliRegressionMemoryFixture, "chunks"> & {
        chunks?: string[];
        status?: "active" | "archived" | "deleted";
        supersedesId?: string | null;
      }
    >,
    edges: CliRegressionEdgeFixture[] = []
  ): void {
    assert(this.db, "DB not initialized");

    const insertMemory = this.db.db.prepare(`
      INSERT INTO memory_items (
        id, type, title, content, summary, source, scope, workspace,
        tags, importance, status, supersedes_id, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = this.db.db.prepare(`
      INSERT INTO content_chunks (id, memory_id, seq, pos, token_count, chunk_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const memory of memories) {
      insertMemory.run(
        memory.id,
        memory.type,
        memory.title,
        memory.content,
        memory.summary ?? "",
        memory.source ?? "fixture",
        memory.scope ?? "workspace",
        workspace,
        JSON.stringify(memory.tags ?? []),
        memory.importance ?? 0.5,
        memory.status ?? "active",
        memory.supersedesId ?? null,
        createHash("sha256").update(memory.content).digest("hex"),
        memory.createdAt,
        memory.updatedAt ?? memory.createdAt
      );

      let position = 0;
      (memory.chunks ?? [memory.content]).forEach((chunk, index) => {
        insertChunk.run(
          `${memory.id}_${index}`,
          memory.id,
          index,
          position,
          chunk.split(/\s+/).length,
          chunk,
          memory.createdAt
        );
        position += chunk.length + 1;
      });
    }

    for (const edge of edges) {
      persistMemoryEdge(this.db, edge);
    }
  }

  getStats(workspace: string): { total: number; active: number; deleted: number; archived: number; chunks: number } {
    assert(this.db, "DB not initialized");
    return getIngestStats(this.db, workspace);
  }

  countCanonicalEdges(args: { fromMemoryId: string; toMemoryId: string; relationType: string }): number {
    assert(this.db, "DB not initialized");
    const row = this.db.db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_edges
      WHERE from_memory_id = ?
        AND to_memory_id = ?
        AND relation_type = ?
    `).get(args.fromMemoryId, args.toMemoryId, args.relationType) as { count: number };

    return row.count;
  }

  get zvecPath(): string {
    return resolveStoragePaths(this.config, "smoke-harness").zvecPath;
  }

  async close(): Promise<void> {
    for (const collection of this.collections.values()) {
      collection.close();
    }
    this.collections.clear();
    this.vectorStore?.close();
    if (this.db) {
      closeDatabase(this.db);
    }
    await this.embedProvider?.dispose();
  }
}

type McpSession = {
  client: Client;
  transport: StdioClientTransport;
  getStderr: () => string;
};

async function startMcpSession(params: {
  workspace: string;
  env?: Record<string, string>;
  configPath?: string;
}): Promise<McpSession> {
  let stderr = "";
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      "dist/index.js",
      "mcp",
      `--workspace=${params.workspace}`,
      ...(params.configPath ? [`--config=${params.configPath}`] : []),
    ],
    cwd: process.cwd(),
    env: {
      ...inheritedEnv,
      ...params.env,
    },
    stderr: "pipe",
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      const str = chunk.toString();
      stderr += str;
      process.stderr.write(`[mcp-child] ${str}`);
    });
  }

  const client = new Client({ name: "zmem-smoke", version: "0.1.0" });
  await client.connect(transport);

  return {
    client,
    transport,
    getStderr: () => stderr,
  };
}

async function closeMcpSession(session: McpSession): Promise<void> {
  await session.client.close();
  await session.transport.close();
}

async function main(): Promise<void> {
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1];
  const runCore = !onlyArg || onlyArg === "core";
  const runMcp = !onlyArg || onlyArg === "mcp";

  const runId = Date.now();
  const workspace = `smoke-core-${runId}`;
  const workspaceB = `smoke-core-b-${runId}`;
  const workspaceEmpty = `smoke-empty-${runId}`;
  const workspaceIngest = `smoke-ingest-${runId}`;
  const workspaceHistory = `smoke-history-${runId}`;
  const mcpWorkspace = `smoke-mcp-${runId}`;
  const cliRegressionWorkspace = CLI_SEARCH_REGRESSION_WORKSPACE;
  const harness = new Harness();
  await harness.init();

  try {
    if (runCore) {
      await runCase("core happy path", async () => {
      const ctx = harness.context(workspace);
      const token = `smokehappy${runId}`;

      const created = await save(ctx, {
        type: "fact",
        title: `Happy path ${token}`,
        content: `This content validates ${token}.`,
        source: "smoke",
        scope: "workspace",
        tags: ["smoke"],
      });

      const fetched = await get(ctx, created.id);
      assert(fetched?.id === created.id, "Expected get() to return saved item");

      const listed = await list(ctx, { limit: 20, offset: 0 });
      assert(listed.items.some((i) => i.id === created.id), "Expected list() to include saved item");

      const hits = await recall(ctx, token, { mode: "hybrid" });
      assert(hits.some((h) => h.id === created.id), "Expected recall() to find saved item");

      const firstDelete = await deleteMemory(ctx, created.id);
      const secondDelete = await deleteMemory(ctx, created.id);
      assert(firstDelete, "Expected first delete to return true");
      assert(!secondDelete, "Expected second delete to return false");
      const hitsAfterDelete = await recall(ctx, token, { mode: "hybrid" });
      assert(!hitsAfterDelete.some((h) => h.id === created.id), "Deleted item should be hidden by recall");
      });

      await runCase("ingest fixture docs and idempotency", async () => {
      const fixturePath = resolve(process.cwd(), "test-docs/search");

      await harness.ingestDocs(workspaceIngest, fixturePath);
      const firstStats = harness.getStats(workspaceIngest);
      assert(firstStats.total > 0, "Fixture ingest should create memory items");
      assert(firstStats.chunks > 0, "Fixture ingest should create chunks");

      await harness.ingestDocs(workspaceIngest, fixturePath);
      const secondStats = harness.getStats(workspaceIngest);
      assert(secondStats.total === firstStats.total, "Re-ingest should not inflate total docs");
      assert(secondStats.chunks === firstStats.chunks, "Re-ingest should not inflate chunk count");
      });

      await runCase("supersede lifecycle", async () => {
      const ctx = harness.context(workspace);
      const key = `smokesupersede${runId}`;
      const oldOnly = `smokeoldonly${runId}`;
      const first = await save(ctx, {
        type: "decision",
        title: `Original ${key}`,
        content: `Original content ${key} ${oldOnly}`,
        source: "smoke",
        scope: "workspace",
        tags: ["supersede"],
      });

      const second = await save(ctx, {
        type: "decision",
        title: `Updated ${key}`,
        content: `Updated content ${key}`,
        source: "smoke",
        scope: "workspace",
        tags: ["supersede"],
        supersedesId: first.id,
      });

      const firstItem = await get(ctx, first.id);
      const secondItem = await get(ctx, second.id);
      assert(firstItem?.status === "archived", "Expected superseded item to be archived");
      assert(secondItem?.status === "active", "Expected new superseding item to be active");

      const hidden = await recall(ctx, key, { includeSuperseded: false });
      assert(!hidden.some((h) => h.id === first.id), "Superseded item should be hidden by default");

      const hiddenOldOnly = await recall(ctx, oldOnly, {
        includeSuperseded: false,
        mode: "lexical",
      });
      assert(
        !hiddenOldOnly.some((h) => h.id === first.id),
        "Archived old-only content should be hidden by default"
      );

      const visible = await recall(ctx, oldOnly, {
        includeSuperseded: true,
        mode: "lexical",
      });
      assert(visible.some((h) => h.id === first.id), "Superseded archived item should be visible when included");

      const current = await recall(ctx, key, { includeSuperseded: true, mode: "hybrid" });
      assert(current.some((h) => h.id === second.id), "Superseding item should remain visible");
      });

      await runCase("workspace isolation", async () => {
      const ctxA = harness.context(workspace);
      const ctxB = harness.context(workspaceB);
      const tokenA = `smokeworkspacea${runId}`;
      const tokenB = `smokeworkspaceb${runId}`;

      const itemA = await save(ctxA, {
        type: "fact",
        title: `Workspace A ${tokenA}`,
        content: tokenA,
        source: "smoke",
        scope: "workspace",
        tags: ["ws-a"],
      });
      const itemB = await save(ctxB, {
        type: "fact",
        title: `Workspace B ${tokenB}`,
        content: tokenB,
        source: "smoke",
        scope: "workspace",
        tags: ["ws-b"],
      });

      const hitsA = await recall(ctxA, tokenA, { mode: "hybrid" });
      assert(hitsA.some((h) => h.id === itemA.id), "Workspace A should find its own item");

      const crossHits = await recall(ctxA, tokenB, { mode: "hybrid" });
      assert(!crossHits.some((h) => h.id === itemB.id), "Workspace A should not see workspace B item");

      const statusA = await status(ctxA);
      const statusB = await status(ctxB);
      assert(statusA.totalItems > 0, "Workspace A should have items");
      assert(statusB.totalItems > 0, "Workspace B should have items");
      });

      await runCase("explicit lexical and vector recall modes", async () => {
      const ctx = harness.context(workspace);
      const lexicalToken = `lexicalkeyword${runId}`;
      const semanticText = `semantic memory retrieval benchmark sentence ${runId}`;

      const lexicalItem = await save(ctx, {
        type: "fact",
        title: `Lexical ${lexicalToken}`,
        content: `This doc includes ${lexicalToken} for lexical assertions`,
        source: "smoke",
        scope: "workspace",
      });

      const semanticItem = await save(ctx, {
        type: "decision",
        title: `Semantic ${runId}`,
        content: semanticText,
        source: "smoke",
        scope: "workspace",
      });

      const lexicalHits = await recall(ctx, lexicalToken, { mode: "lexical" });
      assert(lexicalHits.some((h) => h.id === lexicalItem.id), "Lexical mode should return keyword hit");

      const vectorHits = await recall(ctx, semanticText, { mode: "vector" });
      assert(vectorHits.length > 0, "Vector mode should return at least one hit");
      assert(
        vectorHits.some((h) => h.id === semanticItem.id),
        "Vector mode should include semantically matching item"
      );
      });

      await runCase("recent, important, and typed recall modes", async () => {
      const ctx = harness.context(workspace);
      const token = `modememory${runId}`;
      const olderTitle = `Mode older ${token}`;
      const importantTitle = `Mode important ${token}`;
      const preferenceTitle = `Mode preference ${token}`;

      const olderLexical = await save(ctx, {
        type: "fact",
        title: olderTitle,
        content: `Contains ${token} but should not win recent mode`,
        source: "smoke",
        scope: "workspace",
        importance: 0.35,
      });

      const importantDecision = await save(ctx, {
        type: "decision",
        title: importantTitle,
        content: `Important decision memory ${token}`,
        source: "smoke",
        scope: "workspace",
        importance: 0.94,
      });

      const typedPreference = await save(ctx, {
        type: "preference",
        title: preferenceTitle,
        content: `Workspace preference memory ${token}`,
        source: "smoke",
        scope: "workspace",
        importance: 0.82,
      });

      const recentHits = await recall(ctx, token, { mode: "recent", topK: 3 });
      assert(recentHits[0]?.id === typedPreference.id, "Recent mode should return the newest item first");
      assert(recentHits.some((hit) => hit.id === olderLexical.id), "Recent mode should still include older items by recency");

      const importantHits = await recall(ctx, "", { mode: "important", topK: 3 });
      assert(importantHits[0]?.id === importantDecision.id, "Important mode should prefer high-importance items");

      const typedHits = await recall(ctx, "", {
        mode: "typed",
        types: ["decision", "preference"],
        topK: 3,
      });
      assert(typedHits.every((hit) => hit.type === "decision" || hit.type === "preference"), "Typed mode should filter to requested types");
      assert(!typedHits.some((hit) => hit.id === olderLexical.id), "Typed mode should exclude disallowed types");

      harness.closeWorkspaceCollection(workspace);
      const cliOutput = execFileSync(
        "node",
        ["dist/index.js", "query", "", "--mode=recent", `--workspace=${workspace}`],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      assert(cliOutput.includes(`1. ${preferenceTitle}`), "CLI recent mode should print the newest item first");
      });

      await runCase("CLI search regression fixtures", async () => {
      harness.resetWorkspace(cliRegressionWorkspace);
      harness.seedWorkspaceFixtures(cliRegressionWorkspace, cliSearchRegressionMemories, cliSearchRegressionEdges);

      const ctx = harness.context(cliRegressionWorkspace);
      const reindexResult = await reindex(ctx);
      assert(reindexResult.errors === 0, "CLI regression fixture reindex should succeed");
      assert(reindexResult.processed === cliSearchRegressionMemories.length, "CLI regression fixture should reindex every seeded memory");

      harness.closeWorkspaceCollection(cliRegressionWorkspace);
      const queryOutput = execFileSync(
        "node",
        ["dist/index.js", "query", CLI_SEARCH_PRIMARY_QUERY, `--workspace=${cliRegressionWorkspace}`],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      const queryTitles = parseCliTitles(queryOutput);
      assert(queryTitles[0] === CLI_SEARCH_EXPECTED_QUERY_TITLE, "CLI query fixture should return the expected title first");

      const recentOutput = execFileSync(
        "node",
        ["dist/index.js", "query", "", "--mode=recent", `--workspace=${cliRegressionWorkspace}`],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      const recentTitles = parseCliTitles(recentOutput);
      assert(recentTitles[0] === CLI_SEARCH_EXPECTED_RECENT_TITLE, "CLI recent fixture should return the newest item first");

      const typedOutput = execFileSync(
        "node",
        [
          "dist/index.js",
          "query",
          "",
          "--mode=typed",
          `--types=${CLI_SEARCH_TYPED_ALLOWED_TYPES.join(",")}`,
          `--workspace=${cliRegressionWorkspace}`,
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      const typedTypes = parseCliTypes(typedOutput);
      assert(typedTypes.length > 0, "CLI typed fixture should emit typed results");
      assert(
        typedTypes.every((type) => CLI_SEARCH_TYPED_ALLOWED_TYPES.includes(type as (typeof CLI_SEARCH_TYPED_ALLOWED_TYPES)[number])),
        "CLI typed fixture should only print allowed types"
      );
      for (const disallowedTitle of CLI_SEARCH_TYPED_DISALLOWED_TITLES) {
        assert(!typedOutput.includes(disallowedTitle), `CLI typed fixture should exclude ${disallowedTitle}`);
      }

      const graphOutput = execFileSync(
        "node",
        ["dist/index.js", "query", CLI_SEARCH_GRAPH_QUERY, `--workspace=${cliRegressionWorkspace}`],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      const graphTitles = parseCliTitles(graphOutput);
      assert(graphTitles.includes(CLI_SEARCH_EXPECTED_GRAPH_TITLE), "CLI graph-aware fixture should surface linked context");
      });

      await runCase("default storage stays outside repo", async () => {
        const repoLikeDir = mkdtempSync(join(tmpdir(), "zmem-repo-like-"));
        const docsDir = join(repoLikeDir, "docs");
        const xdgDataHome = mkdtempSync(join(tmpdir(), "zmem-xdg-home-"));
        mkdirSync(docsDir, { recursive: true });
        writeFileSync(
          join(docsDir, "note.md"),
          [
            "---",
            "type: fact",
            "scope: workspace",
            "---",
            "",
            "# Repo-local data should stay out of this folder",
            "",
            "Database migration notes with linked rollback context.",
          ].join("\n")
        );

        const env = {
          ...process.env,
          XDG_DATA_HOME: xdgDataHome,
          ZMD_EMBED_PROVIDER: "mock",
          ZMD_EMBED_DIMENSIONS: "1024",
          ZMEM_DB_PATH: undefined,
          ZMEM_ZVEC_PATH: undefined,
          ZMEM_STORAGE_BASE_DIR: undefined,
        };

        execFileSync(
          "node",
          [join(process.cwd(), "dist/index.js"), "ingest", docsDir, "--workspace=repo-default-check"],
          { cwd: repoLikeDir, encoding: "utf8", env }
        );

        assert(!existsSync(join(repoLikeDir, "data")), "Default CLI storage should not create ./data inside the working repo");

        const expectedDbPath = join(xdgDataHome, "zmem", "workspaces", "repo-default-check", "memory.db");
        const expectedVectorDir = join(xdgDataHome, "zmem", "workspaces", "repo-default-check", "vectors");
        assert(existsSync(expectedDbPath), "Default CLI storage should create the workspace database under XDG data home");
        assert(existsSync(expectedVectorDir), "Default CLI storage should create the workspace vector directory under XDG data home");
      });

      await runCase("config and model CLI helpers", async () => {
        const cliDir = mkdtempSync(join(tmpdir(), "zmem-cli-helpers-"));
        const configPath = join(cliDir, "config.json");
        const rootPath = join(cliDir, "workspace-root");
        mkdirSync(rootPath, { recursive: true });

        const initOutput = execFileSync("node", ["dist/index.js", "init", `--config=${configPath}`, "--workspace=cli-helper", `--root=${rootPath}`, "--yes"], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, ZMEM_QUERY_EXPANSION_PROVIDER: "deterministic" },
        });
        assert(initOutput.includes("Wrote config"), "init should write a config file");
        assert(existsSync(configPath), "init should create the requested config file");

        const doctorOutput = execFileSync("node", ["dist/index.js", "doctor", `--config=${configPath}`, "--workspace=cli-helper"], {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        assert(doctorOutput.includes("Query expansion provider"), "doctor should report query expansion settings");

        const configOutput = execFileSync("node", ["dist/index.js", "config", "show", `--config=${configPath}`, "--workspace=cli-helper"], {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        const parsedConfigOutput = JSON.parse(configOutput) as { workspace?: string; queryExpansionModels?: { primary?: { modelUri?: string } } };
        assert(parsedConfigOutput.workspace === "cli-helper", "config show should echo the selected workspace");
        assert(typeof parsedConfigOutput.queryExpansionModels?.primary?.modelUri === "string", "config show should include resolved query expansion model info");

        const modelsStatusOutput = execFileSync("node", ["dist/index.js", "models", "status", `--config=${configPath}`], {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        assert(modelsStatusOutput.includes("Query expansion primary"), "models status should print the primary query expansion model");

        const modelsPullOutput = execFileSync("node", ["dist/index.js", "models", "pull", `--config=${configPath}`], {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        assert(modelsPullOutput.includes("node-llama-cpp pull"), "models pull should print manual pull instructions");
      });

      await runCase("evaluation regression fixtures", async () => {
      harness.resetWorkspace(EVALUATION_REGRESSION_WORKSPACE);
      harness.seedWorkspaceFixtures(EVALUATION_REGRESSION_WORKSPACE, evaluationRegressionMemories, evaluationRegressionEdges);

      const ctx = harness.context(EVALUATION_REGRESSION_WORKSPACE);
      const reindexResult = await reindex(ctx);
      assert(reindexResult.errors === 0, "Evaluation regression fixture reindex should succeed");
      assert(
        reindexResult.processed === evaluationRegressionMemories.filter((memory) => (memory.status ?? "active") === "active").length,
        "Evaluation regression fixture should reindex every active seeded memory"
      );

      harness.closeWorkspaceCollection(EVALUATION_REGRESSION_WORKSPACE);
      for (const scenario of evaluationRegressionScenarios) {
        if (scenario.smokePath === "cli") {
          const args = [
            "dist/index.js",
            "query",
            scenario.query,
            `--mode=${scenario.mode}`,
            `--workspace=${EVALUATION_REGRESSION_WORKSPACE}`,
          ];
          if (scenario.types && scenario.types.length > 0) {
            args.push(`--types=${scenario.types.join(",")}`);
          }
          const output = execFileSync("node", args, { cwd: process.cwd(), encoding: "utf8" });
          const titles = parseCliTitles(output);
          const expectedTitles = scenario.expectedIds
            .map((id) => evaluationRegressionMemories.find((memory) => memory.id === id)?.title)
            .filter((title): title is string => typeof title === "string");

          assert(
            titles.slice(0, expectedTitles.length).join("\n") === expectedTitles.join("\n"),
            `Evaluation CLI fixture ${scenario.id} should keep the expected ranking`
          );
          for (const excludedId of scenario.excludedIds ?? []) {
            const excludedTitle = evaluationRegressionMemories.find((memory) => memory.id === excludedId)?.title;
            if (excludedTitle) {
              assert(!titles.includes(excludedTitle), `Evaluation CLI fixture ${scenario.id} should exclude ${excludedTitle}`);
            }
          }
          continue;
        }

        const hits = await recall(ctx, scenario.query, {
          mode: scenario.mode,
          topK: scenario.topK,
          includeSuperseded: scenario.includeSuperseded,
          types: scenario.types,
        });
        for (const expectedId of scenario.expectedIds) {
          assert(hits.some((hit) => hit.id === expectedId), `Evaluation core fixture ${scenario.id} should include ${expectedId}`);
        }
        for (const excludedId of scenario.excludedIds ?? []) {
          assert(!hits.some((hit) => hit.id === excludedId), `Evaluation core fixture ${scenario.id} should exclude ${excludedId}`);
        }
      }
      });

      await runCase("chunk-first recall snippet selection", async () => {
      const ctx = harness.context(workspace);
      const anchor = `story5chunkanchor${runId}`;
      const early = "Early section context. ".repeat(260);
      const evidence = (`Matched chunk evidence ${anchor} selects this snippet. `).repeat(40);
      const late = "Late section wrap-up. ".repeat(260);

      const saved = await save(ctx, {
        type: "fact",
        title: `Chunk-first ${runId}`,
        content: `${early}\n\n${evidence}\n\n${late}`,
        source: "smoke",
        scope: "workspace",
        tags: ["chunk-first"],
      });

      const hits = await recall(ctx, anchor, { mode: "lexical", topK: 10 });
      const ownHits = hits.filter((hit) => hit.id === saved.id);
      assert(ownHits.length === 1, "Chunk-first recall should return one memory result per item");
      assert(
        ownHits[0]?.snippet.includes(anchor) && ownHits[0]?.snippet.includes("selects this snippet"),
        "Chunk-first recall should surface evidence from the matched chunk"
      );
      });

      await runCase("reindex behavior", async () => {
      const ctx = harness.context(workspace);
      const ctxEmpty = harness.context(workspaceEmpty);

      const first = await reindex(ctx);
      assert(first.processed > 0, "Reindex should process active items");
      assert(first.errors === 0, "Reindex should not report errors on smoke data");

      const second = await reindex(ctx);
      assert(second.errors === 0, "Second reindex should remain stable");

      const empty = await reindex(ctxEmpty);
      assert(empty.processed === 0, "Empty workspace reindex should process zero items");
      assert(empty.errors === 0, "Empty workspace reindex should have zero errors");
      });

      await runCase("empty corpus recall", async () => {
      const ctxEmpty = harness.context(`smoke-empty-recall-${runId}`);
      const hits = await recall(ctxEmpty, `nothinghere${runId}`, { mode: "hybrid" });
      assert(hits.length === 0, "Empty workspace recall should return no hits");
      const st = await status(ctxEmpty);
      assert(st.totalItems === 0, "Empty workspace should have zero items");
      });

      await runCase("duplicate and long-content saves", async () => {
      const ctx = harness.context(workspace);
      const dupToken = `smokeduplicate${runId}`;
      const payload = {
        type: "fact" as const,
        title: `Duplicate ${dupToken}`,
        content: `Duplicate content ${dupToken}`,
        source: "smoke",
        scope: "workspace" as const,
        tags: ["dup"],
      };

      const one = await save(ctx, payload);
      const two = await save(ctx, payload);
      assert(one.id !== two.id, "Duplicate saves should produce distinct IDs");

      const longToken = `smokelong${runId}`;
      const longContent = `${"Long content block. ".repeat(800)} ${longToken}`;
      const longSaved = await save(ctx, {
        type: "event",
        title: `Long ${longToken}`,
        content: longContent,
        source: "smoke",
        scope: "workspace",
        tags: ["long"],
      });
      const longHits = await recall(ctx, longToken, { mode: "hybrid" });
      assert(longHits.some((h) => h.id === longSaved.id), "Long content should remain recallable");
      });

      await runCase("graph edge persistence", async () => {
      const ctx = harness.context(workspace);
      const token = `smokegraph${runId}`;

      const from = await save(ctx, {
        type: "fact",
        title: `Graph source ${token}`,
        content: `Graph source content ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph"],
      });

      const to = await save(ctx, {
        type: "fact",
        title: `Graph target ${token}`,
        content: `Graph target content ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph"],
      });

      persistMemoryEdge(ctx.db, {
        id: `edge-${token}-1`,
        fromMemoryId: from.id,
        toMemoryId: to.id,
        relationType: "related_to",
        confidence: 0.88,
        origin: "manual",
        status: "accepted",
        justification: "Smoke canonical edge",
        acceptedBy: "user",
      });

      persistMemoryEdge(ctx.db, {
        id: `edge-${token}-2`,
        fromMemoryId: from.id,
        toMemoryId: to.id,
        relationType: "related_to",
        confidence: 0.91,
        origin: "manual",
        status: "accepted",
        justification: "Duplicate smoke canonical edge",
        acceptedBy: "user",
      });

      assert(
        harness.countCanonicalEdges({
          fromMemoryId: from.id,
          toMemoryId: to.id,
          relationType: "related_to",
        }) === 1,
        "Expected exactly one canonical graph edge row"
      );
      });

      await runCase("save with explicit links and neighbor retrieval", async () => {
      const ctx = harness.context(workspace);
      const token = `smokelinksave${runId}`;

      const target = await save(ctx, {
        type: "fact",
        title: `Link target ${token}`,
        content: `Link target content ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph"],
      });

      const linked = await save(ctx, {
        type: "decision",
        title: `Link source ${token}`,
        content: `Link source content ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph"],
        links: [
          {
            toMemoryId: target.id,
            relationType: "supports",
            confidence: 0.93,
            justification: "Smoke explicit link",
          },
        ],
      });

      assert(
        harness.countCanonicalEdges({
          fromMemoryId: linked.id,
          toMemoryId: target.id,
          relationType: "supports",
        }) === 1,
        "Expected explicit link save to persist one canonical edge"
      );

      const neighbors = await listNeighbors(ctx, linked.id, {
        direction: "outbound",
        statuses: ["accepted"],
      });
      assert(neighbors.some((neighbor) => neighbor.memory.id === target.id), "Expected saved explicit link to be retrievable as a neighbor");
      });

      await runCase("save with deterministic suggested edges", async () => {
      const seedCtx = harness.context(workspace);
      const token = `smokesuggest${runId}`;

      await Promise.all(
        Array.from({ length: 4 }, async (_, index) =>
          save(seedCtx, {
            type: "fact",
            title: `Suggestion target ${token} ${index}`,
            content: `Suggestion target content ${token} ${index}`,
            source: "smoke",
            scope: "workspace",
            tags: ["graph", "suggested"],
            suggestEdges: false,
          })
        )
      );

      const generator: EdgeSuggestionGenerator = {
        async suggest({ candidatePool }) {
          return candidatePool.allCandidates.map((candidate, index) => ({
            toMemoryId: candidate.memoryId,
            relationType: "related_to",
            confidence: 0.95 - index * 0.1,
            evidenceScore: 10 - index,
            justification: `Smoke deterministic suggestion ${candidate.memoryId}`,
          }));
        },
      };
      const ctx = harness.context(
        workspace,
        createSaveEdgeSuggestionProvider({
          generator,
          topK: 3,
          recentCandidateLimit: 4,
          semanticCandidateLimit: 4,
        })
      );

      const saved = await save(ctx, {
        type: "decision",
        title: `Suggestion source ${token}`,
        content: `Suggestion source content ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph", "suggested"],
      });

      const neighbors = await listNeighbors(ctx, saved.id, {
        direction: "outbound",
        origins: ["llm"],
        statuses: ["suggested"],
      });
      assert(neighbors.length === 3, "Expected only the top suggested edges to persist");
      assert(
        neighbors.every((neighbor) => neighbor.edge.origin === "llm" && neighbor.edge.status === "suggested"),
        "Expected suggested edges to persist as llm/suggested"
      );
      });

      await runCase("graph-aware relational recall", async () => {
      const ctx = harness.context(workspace);
      const token = `smokegraphintent${runId}`;

      const changedSeed = await save(ctx, {
        type: "event",
        title: `What changed ${token}`,
        content: `What changed after the rollout ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph", "history"],
        suggestEdges: false,
      });
      const changedNeighbor = await save(ctx, {
        type: "fact",
        title: `Previous baseline ${token}`,
        content: `Baseline notes before the rollout ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph", "history"],
        suggestEdges: false,
      });

      const whySeed = await save(ctx, {
        type: "decision",
        title: `Why we chose this ${token}`,
        content: `Why did we choose this architecture ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph", "decision"],
        suggestEdges: false,
      });
      const whyNeighbor = await save(ctx, {
        type: "fact",
        title: `Decision rationale ${token}`,
        content: `Tradeoff analysis and rationale ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph", "decision"],
        suggestEdges: false,
      });

      const relatedSeed = await save(ctx, {
        type: "fact",
        title: `Related context ${token}`,
        content: `Related context for the project ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph", "context"],
        suggestEdges: false,
      });
      const relatedAccepted = await save(ctx, {
        type: "fact",
        title: `Accepted related note ${token}`,
        content: `Accepted linked context ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph", "context"],
        suggestEdges: false,
      });
      const relatedSuggested = await save(ctx, {
        type: "fact",
        title: `Suggested related note ${token}`,
        content: `Suggested linked context ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["graph", "context"],
        suggestEdges: false,
      });

      persistMemoryEdge(ctx.db, {
        id: `edge-${token}-changed`,
        fromMemoryId: changedSeed.id,
        toMemoryId: changedNeighbor.id,
        relationType: "derived_from",
        confidence: 0.94,
        origin: "manual",
        status: "accepted",
        justification: "Smoke history link",
        acceptedBy: "user",
      });
      persistMemoryEdge(ctx.db, {
        id: `edge-${token}-why`,
        fromMemoryId: whySeed.id,
        toMemoryId: whyNeighbor.id,
        relationType: "supports",
        confidence: 0.93,
        origin: "manual",
        status: "accepted",
        justification: "Smoke decision link",
        acceptedBy: "user",
      });
      persistMemoryEdge(ctx.db, {
        id: `edge-${token}-related-accepted`,
        fromMemoryId: relatedSeed.id,
        toMemoryId: relatedAccepted.id,
        relationType: "related_to",
        confidence: 0.92,
        origin: "manual",
        status: "accepted",
        justification: "Smoke accepted related link",
        acceptedBy: "user",
      });
      persistMemoryEdge(ctx.db, {
        id: `edge-${token}-related-suggested`,
        fromMemoryId: relatedSeed.id,
        toMemoryId: relatedSuggested.id,
        relationType: "related_to",
        confidence: 0.98,
        origin: "llm",
        status: "suggested",
        justification: "Smoke suggested related link",
        acceptedBy: null,
      });

      const changedHits = await recall(ctx, "what changed", { mode: "lexical", topK: 5 });
      assert(changedHits.some((hit) => hit.id === changedSeed.id), "Expected what changed seed hit");
      assert(changedHits.some((hit) => hit.id === changedNeighbor.id), "Expected accepted history neighbor injection");
      const changedNeighborHit = changedHits.find((hit) => hit.id === changedNeighbor.id);
      assert(changedNeighborHit?.explanation?.includes("accepted manual link"), "Expected graph-heavy explanation to mention accepted manual link");

      const whyHits = await recall(ctx, "why did we choose this", { mode: "lexical", topK: 5 });
      assert(whyHits.some((hit) => hit.id === whySeed.id), "Expected why seed hit");
      assert(whyHits.some((hit) => hit.id === whyNeighbor.id), "Expected accepted rationale neighbor injection");

      const relatedHits = await recall(ctx, "related context", { mode: "lexical", topK: 5 });
      assert(relatedHits.some((hit) => hit.id === relatedSeed.id), "Expected related seed hit");
      assert(relatedHits.some((hit) => hit.id === relatedAccepted.id), "Expected accepted related neighbor injection");
      assert(
        !relatedHits.some((hit) => hit.id === relatedSuggested.id),
        "Suggested-only related neighbor should not be injected in v1"
      );
      });

      await runCase("history-aware lineage reranking", async () => {
      const ctx = harness.context(workspaceHistory);
      const token = `smokelineage${runId}`;

      const baseline = await save(ctx, {
        type: "event",
        title: `Baseline ${token}`,
        content: `Previous baseline before the rollout ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["history", "lineage"],
        suggestEdges: false,
      });

      await save(ctx, {
        type: "event",
        title: `Current summary ${token}`,
        content: `What changed after the rollout ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["history", "lineage"],
        supersedesId: baseline.id,
        suggestEdges: false,
      });

      await save(ctx, {
        type: "fact",
        title: `Unrelated note ${token}`,
        content: `Another rollout note with mild overlap ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["history"],
        suggestEdges: false,
      });

      const historyHits = await recall(ctx, "what changed before the rollout", {
        mode: "lexical",
        topK: 5,
        includeSuperseded: true,
      });
      const baselineHit = historyHits.find((hit) => hit.id === baseline.id);
      assert(baselineHit, "Expected superseded baseline to surface for history-heavy query");
      assert(baselineHit.explanation?.includes("same history chain"), "Expected history-heavy explanation to mention lineage");
      });

      await runCase("deterministic query expansion remains bounded and traceable", async () => {
      const ctx = harness.context(workspace);
      const token = `smokeexpansion${runId}`;

      const expansionOnly = await save(ctx, {
        type: "fact",
        title: `Decision rationale ${token}`,
        content: `Decision rationale tradeoff analysis why choose selected approach ${token}`,
        source: "smoke",
        scope: "workspace",
        tags: ["expansion"],
        suggestEdges: false,
      });

      const { expandQuery } = await import("../src/search/query-expansion.ts");
      const deterministicPlan = await expandQuery("why did we choose this", "deterministic");
      assert(deterministicPlan.variants.length <= 4, "Deterministic expansion should stay bounded");
      assert(
        deterministicPlan.variants.some((variant) => variant.strategy === "semantic" && variant.label === "semantic:decision-rationale"),
        "Deterministic expansion should expose semantic strategy labels"
      );

      const disabledPlan = await expandQuery("why did we choose this", "off");
      assert(
        disabledPlan.variants.length === 1 && disabledPlan.variants[0]?.label === "original:raw",
        "Disabled expansion should keep only the original variant"
      );

      const disabledHits = await recall(ctx, "decision rationale", {
        mode: "lexical",
        topK: 5,
        expansionMode: "off",
      });
      assert(disabledHits.some((hit) => hit.id === expansionOnly.id), "Disabled expansion should preserve exact-match recall behavior");

      const expandedHits = await recall(ctx, "decision rationale", {
        mode: "hybrid",
        topK: 5,
        expansionMode: "deterministic",
      });
      assert(expandedHits.some((hit) => hit.id === expansionOnly.id), "Deterministic expansion should preserve exact-match retrieval when enabled");
      });

      await runCase("special-char content and concurrent saves", async () => {
      const ctx = harness.context(workspace);
      const punctToken = `oauth2 beta users flow ${runId}`;

      const punct = await save(ctx, {
        type: "preference",
        title: `Punctuation ${runId}`,
        content: `Preference for handling oauth2/token (beta), user's-flow ${runId}`,
        source: "smoke",
        scope: "workspace",
        tags: ["punctuation"],
      });

      const punctHits = await recall(ctx, punctToken, { mode: "hybrid" });
      assert(punctHits.some((h) => h.id === punct.id), "Punctuation-heavy query should work");

      const concurrentTokens = Array.from({ length: 5 }, (_, i) => `smokeconcurrent${runId}${i}`);
      const concurrent = await Promise.all(
        concurrentTokens.map((token) =>
          save(ctx, {
            type: "todo",
            title: `Concurrent ${token}`,
            content: token,
            source: "smoke",
            scope: "workspace",
            tags: ["concurrent"],
          })
        )
      );

      for (const item of concurrent) {
        const fetched = await get(ctx, item.id);
        assert(fetched !== null, `Expected concurrent item ${item.id} to exist`);
      }
      });

      await runCase("config load isolation", async () => {
      const originalModel = process.env.ZMD_EMBED_MODEL;
      const originalProvider = process.env.ZMD_EMBED_PROVIDER;
      try {
        process.env.ZMD_EMBED_MODEL = "hf:custom/model.gguf";
        process.env.ZMD_EMBED_PROVIDER = "ollama";
        const cfg1 = loadAppConfig("./does-not-exist.json", { silent: true });
        assert(cfg1.ai.embedding.model === "hf:custom/model.gguf", "Expected env model override in first load");
        assert(cfg1.ai.embedding.provider === "ollama", "Expected env provider override in first load");

        delete process.env.ZMD_EMBED_MODEL;
        process.env.ZMD_EMBED_PROVIDER = "invalid-provider";
        const cfg2 = loadAppConfig("./does-not-exist.json", { silent: true });
        assert(
          cfg2.ai.embedding.model === "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
          "Second load should not retain previous model mutation"
        );
        assert(
          cfg2.ai.embedding.provider === "llamacpp",
          "Invalid provider override should be ignored"
        );
      } finally {
        if (originalModel === undefined) {
          delete process.env.ZMD_EMBED_MODEL;
        } else {
          process.env.ZMD_EMBED_MODEL = originalModel;
        }
        if (originalProvider === undefined) {
          delete process.env.ZMD_EMBED_PROVIDER;
        } else {
          process.env.ZMD_EMBED_PROVIDER = originalProvider;
        }
      }
      });

      await runCase("invalid config and corrupt DB error paths", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "zmem-smoke-errors-"));
      const invalidJsonPath = join(tempDir, "invalid-config.json");
      const invalidSchemaPath = join(tempDir, "invalid-schema.json");
      const corruptDbPath = join(tempDir, "corrupt.db");

      try {
        writeFileSync(invalidJsonPath, "{\"defaults\": ");
        await expectThrows(
          async () => {
            loadAppConfig(invalidJsonPath, { silent: true });
          },
          "Invalid JSON config should throw"
        );

        writeFileSync(invalidSchemaPath, JSON.stringify({ defaults: { retrievalMode: "invalid-mode" } }));
        await expectThrows(
          async () => {
            loadAppConfig(invalidSchemaPath, { silent: true });
          },
          "Schema-invalid config should throw"
        );

        writeFileSync(corruptDbPath, "not a sqlite database");
        await expectThrows(
          async () => {
            const badDb = openDatabase(corruptDbPath);
            try {
              runMigrations(badDb);
            } finally {
              closeDatabase(badDb);
            }
          },
          "Corrupt database should fail open or migrations"
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
      });

      await runCase("vector stale-path recovery", async () => {
      const staleWorkspace = `smoke-stale-${runId}`;
      mkdirSync(`${harness.zvecPath}/${staleWorkspace}`, { recursive: true });
      const collection = harness.createCollectionRaw(staleWorkspace);
      collection.close();
      });
    }

    if (runMcp) {
      await runCase("mcp contracts and validation", async () => {
      const session = await startMcpSession({
        workspace: mcpWorkspace,
        env: { ZMEM_MCP_VERBOSE: "true" },
      });
      try {
        const tools = await session.client.listTools();
        const names = tools.tools.map((t) => t.name).sort();
        assert(names.includes("memory_query"), "memory_query should be registered");
        assert(names.includes("memory_search"), "memory_search should be registered");
        assert(names.includes("memory_link"), "memory_link should be registered");
        assert(names.includes("memory_neighbors"), "memory_neighbors should be registered");
        assert(names.includes("memory_edge_update"), "memory_edge_update should be registered");
        assert(!names.includes("memory_reindex"), "memory_reindex should be disabled by default");

        const emptyResult = await session.client.callTool({
          name: "memory_query",
          arguments: { query: `emptycorpus${runId}`, mode: "hybrid", limit: 5 },
        });
        assert(!emptyResult.isError, "memory_query on empty corpus should not error");
        const emptyCount = (emptyResult.structuredContent as { count?: number } | undefined)?.count;
        assert(emptyCount === 0, "Empty corpus query should return count=0");

        const secretQuery = `mcpsecretquery${runId}`;
        const saveResult = await session.client.callTool({
          name: "memory_save",
          arguments: {
            type: "fact",
            title: `MCP ${runId}`,
            content: `content ${secretQuery}`,
            source: "smoke",
            scope: "workspace",
            tags: ["mcp"],
          },
        });
        assert(!saveResult.isError, "memory_save should succeed");
        const savedId = (saveResult.structuredContent as { id?: string } | undefined)?.id;
        assert(typeof savedId === "string", "memory_save should return id");

        const getResult = await session.client.callTool({ name: "memory_get", arguments: { id: savedId } });
        assert(!getResult.isError, "memory_get should succeed");

        const linkA = await session.client.callTool({
          name: "memory_save",
          arguments: {
            type: "decision",
            title: `MCP Link A ${runId}`,
            content: `Relational root ${secretQuery}`,
            source: "smoke",
            scope: "workspace",
            tags: ["mcp", "graph"],
          },
        });
        assert(!linkA.isError, "memory_save should create link A");
        const linkAId = (linkA.structuredContent as { id?: string } | undefined)?.id;
        assert(typeof linkAId === "string", "link A should have id");

        const linkB = await session.client.callTool({
          name: "memory_save",
          arguments: {
            type: "fact",
            title: `MCP Link B ${runId}`,
            content: `Neighbor evidence ${secretQuery}`,
            source: "smoke",
            scope: "workspace",
            tags: ["mcp", "graph"],
          },
        });
        assert(!linkB.isError, "memory_save should create link B");
        const linkBId = (linkB.structuredContent as { id?: string } | undefined)?.id;
        assert(typeof linkBId === "string", "link B should have id");

        const linkC = await session.client.callTool({
          name: "memory_save",
          arguments: {
            type: "event",
            title: `MCP Link C ${runId}`,
            content: `Second hop evidence ${secretQuery}`,
            source: "smoke",
            scope: "workspace",
            tags: ["mcp", "graph"],
          },
        });
        assert(!linkC.isError, "memory_save should create link C");
        const linkCId = (linkC.structuredContent as { id?: string } | undefined)?.id;
        assert(typeof linkCId === "string", "link C should have id");

        const listResult = await session.client.callTool({
          name: "memory_list",
          arguments: { limit: 10, offset: 0, status: "active" },
        });
        assert(!listResult.isError, "memory_list should succeed");

        const queryResult = await session.client.callTool({
          name: "memory_query",
          arguments: { query: secretQuery, mode: "hybrid", limit: 5 },
        });
        assert(!queryResult.isError, "memory_query should succeed");

        const searchDefault = await session.client.callTool({
          name: "memory_search",
          arguments: { query: secretQuery, mode: "hybrid", limit: 5 },
        });
        assert(!searchDefault.isError, "memory_search should succeed");
        const searchDefaultPayload = searchDefault.structuredContent as {
          items?: Array<{ id: string; snippet: string; score: number }>;
          count?: number;
        };
        assert(Array.isArray(searchDefaultPayload.items), "memory_search should return items array");
        assert(typeof searchDefaultPayload.count === "number", "memory_search should return count");
        assert(
          Object.keys(searchDefaultPayload).sort().join(",") === "count,items",
          "memory_search should return clean default fields only"
        );
        assert(
          searchDefaultPayload.items?.some((item) => item.id === savedId),
          "memory_search should include saved memory item"
        );
        assert(
          searchDefaultPayload.items?.every((item) => typeof item.snippet === "string" && item.snippet.length > 0 && typeof item.score === "number"),
          "memory_search default items should include score and snippet evidence"
        );

        const searchRich = await session.client.callTool({
          name: "memory_search",
          arguments: {
            query: secretQuery,
            mode: "hybrid",
            limit: 5,
            includes: { matches: true, edges: true, explanations: true, debug: true },
          },
        });
        assert(!searchRich.isError, "memory_search rich output should succeed");
        const searchRichPayload = searchRich.structuredContent as {
          matches?: Array<{ memoryId: string; snippet: string }>;
          edges?: Array<{ memoryId: string; neighbor: { id: string } }>;
          explanations?: Array<{ memoryId: string; text: string }>;
          debug?: { matchCount?: number; resultIds?: string[] };
        };
        assert(Array.isArray(searchRichPayload.matches), "memory_search should expose matches when requested");
        assert(Array.isArray(searchRichPayload.edges), "memory_search should expose edges when requested");
        assert(Array.isArray(searchRichPayload.explanations), "memory_search should expose explanations when requested");
        assert(typeof searchRichPayload.debug === "object", "memory_search should expose debug when requested");
        assert(
          searchRichPayload.matches?.some((match) => match.memoryId === savedId && match.snippet.length > 0),
          "memory_search matches should include snippets"
        );

        const manualLink = await session.client.callTool({
          name: "memory_link",
          arguments: {
            fromMemoryId: linkAId,
            toMemoryId: linkBId,
            relationType: "related_to",
            confidence: 0.91,
            justification: "smoke accepted link",
          },
        });
        assert(!manualLink.isError, "memory_link should succeed");
        const manualLinkPayload = manualLink.structuredContent as {
          edge?: { id: string; status: string; acceptedBy: string | null; fromMemoryId: string; toMemoryId: string };
        };
        assert(manualLinkPayload.edge?.status === "accepted", "memory_link should create accepted edges");
        assert(manualLinkPayload.edge?.acceptedBy === "agent", "memory_link should default acceptedBy=agent");
        assert(
          [manualLinkPayload.edge?.fromMemoryId, manualLinkPayload.edge?.toMemoryId].sort().join(":") === [linkAId, linkBId].sort().join(":"),
          "memory_link should connect the requested pair"
        );

        const suggestedLink = await session.client.callTool({
          name: "memory_link",
          arguments: {
            fromMemoryId: linkBId,
            toMemoryId: linkCId,
            relationType: "supports",
            confidence: 0.62,
            status: "suggested",
            justification: "smoke suggested link",
          },
        });
        assert(!suggestedLink.isError, "memory_link should allow suggested edges");
        const suggestedEdgeId = (suggestedLink.structuredContent as { edge?: { id?: string; status?: string } } | undefined)?.edge?.id;
        const suggestedEdgeStatus = (suggestedLink.structuredContent as { edge?: { status?: string } } | undefined)?.edge?.status;
        assert(typeof suggestedEdgeId === "string", "suggested edge should have id");
        assert(suggestedEdgeStatus === "suggested", "suggested edge should remain suggested initially");

        const promoteLink = await session.client.callTool({
          name: "memory_edge_update",
          arguments: {
            id: suggestedEdgeId,
            status: "accepted",
            acceptedBy: "agent",
            justification: "smoke promotion",
          },
        });
        assert(!promoteLink.isError, "memory_edge_update should succeed");
        const promotePayload = promoteLink.structuredContent as {
          edge?: { status?: string; acceptedBy?: string | null };
        };
        assert(promotePayload.edge?.status === "accepted", "memory_edge_update should promote suggested edges");
        assert(promotePayload.edge?.acceptedBy === "agent", "memory_edge_update should preserve acceptance provenance");

        const defaultNeighbors = await session.client.callTool({
          name: "memory_neighbors",
          arguments: { id: linkAId },
        });
        assert(!defaultNeighbors.isError, "memory_neighbors default query should succeed");
        const defaultNeighborsPayload = defaultNeighbors.structuredContent as {
          depth?: number;
          neighbors?: Array<{ memory: { id: string }; depth: number }>;
        };
        assert(defaultNeighborsPayload.depth === 1, "memory_neighbors should default depth to 1");
        assert(
          defaultNeighborsPayload.neighbors?.some((neighbor) => neighbor.memory.id === linkBId && neighbor.depth === 1),
          "memory_neighbors default depth should include first-hop neighbor"
        );
        assert(
          !defaultNeighborsPayload.neighbors?.some((neighbor) => neighbor.depth > 1),
          "memory_neighbors default depth should exclude deeper-than-first-hop neighbors"
        );

        const deepNeighbors = await session.client.callTool({
          name: "memory_neighbors",
          arguments: { id: linkAId, depth: 2 },
        });
        assert(!deepNeighbors.isError, "memory_neighbors depth=2 query should succeed");
        const deepNeighborsPayload = deepNeighbors.structuredContent as {
          depth?: number;
          neighbors?: Array<{ memory: { id: string }; depth: number }>;
        };
        assert(deepNeighborsPayload.depth === 2, "memory_neighbors should echo explicit depth");
        assert(
          deepNeighborsPayload.neighbors?.some((neighbor) => neighbor.memory.id === linkCId && neighbor.depth === 2),
          "memory_neighbors depth=2 should include second-hop neighbor"
        );

        const badGet = await session.client.callTool({ name: "memory_get", arguments: { id: "" } });
        assert(badGet.isError, "memory_get should reject invalid id");

        const badLimit = await session.client.callTool({
          name: "memory_query",
          arguments: { query: "x", limit: 101 },
        });
        assert(badLimit.isError, "memory_query should reject limit > 100");

        const badSave = await session.client.callTool({
          name: "memory_save",
          arguments: {
            type: "fact",
            content: "missing title",
            source: "smoke",
          },
        });
        assert(badSave.isError, "memory_save should reject missing required fields");

        const del = await session.client.callTool({ name: "memory_delete", arguments: { id: savedId } });
        assert(!del.isError, "memory_delete should succeed");

        const stderr = session.getStderr();
        assert(stderr.includes("queryLen="), "Verbose logs should include queryLen summary");
        assert(!stderr.includes(secretQuery), "Verbose logs should not contain raw query text");
      } finally {
        await closeMcpSession(session);
      }
      });

      await runCase("mcp startup error paths", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "zmem-mcp-config-"));
      const missingConfigPath = join(tempDir, "missing-config.json");
      await expectThrows(
        async () => {
          const session = await startMcpSession({
            workspace: `smoke-mcp-error-${runId}`,
            env: { ZMD_EMBED_PROVIDER: "openai" },
            configPath: missingConfigPath,
          });
          await closeMcpSession(session);
        },
        "Unsupported embedding provider should fail MCP startup"
      );

      const badConfig = join(tempDir, "bad-config.json");
      try {
        writeFileSync(badConfig, "{\"workspaces\":");
        await expectThrows(
          async () => {
            const session = await startMcpSession({
              workspace: `smoke-mcp-badcfg-${runId}`,
              configPath: badConfig,
            });
            await closeMcpSession(session);
          },
          "Invalid MCP config should fail startup"
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
      });

      await runCase("mcp reindex tool flag", async () => {
      const session = await startMcpSession({
        workspace: mcpWorkspace,
        env: { ZMEM_ENABLE_REINDEX_TOOL: "true" },
      });
      try {
        const tools = await session.client.listTools();
        const names = tools.tools.map((t) => t.name);
        assert(names.includes("memory_reindex"), "memory_reindex should be enabled via env flag");
      } finally {
        await closeMcpSession(session);
      }
      });
    }
  } finally {
    await harness.close();
  }

  console.log("[smoke] all smoke scenarios passed");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[smoke] failed:", message);
  process.exit(1);
});
