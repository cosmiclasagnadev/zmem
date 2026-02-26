import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadAppConfig } from "../src/config/loadConfig.js";
import { openDatabase, closeDatabase, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { createEmbeddingProvider } from "../src/embed/factory.js";
import type { EmbeddingProvider } from "../src/embed/types.js";
import {
  createCoreContext,
  save,
  get,
  list,
  recall,
  deleteMemory,
  reindex,
  status,
  type CoreContext,
} from "../src/core/index.js";
import { ingestWorkspace, getIngestStats } from "../src/ingest/index.js";
import { initializeVectorStore, type VectorCollection, type VectorStore } from "../src/vectors/index.js";

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

class Harness {
  private readonly config = loadAppConfig("./config.json", { silent: true });
  private readonly collections = new Map<string, VectorCollection>();
  private db: DbHandle | null = null;
  private vectorStore: VectorStore | null = null;
  private embedProvider: EmbeddingProvider | null = null;

  async init(): Promise<void> {
    mkdirSync(this.config.storage.zvecPath, { recursive: true });
    mkdirSync(dirname(this.config.storage.dbPath), { recursive: true });

    this.db = openDatabase(this.config.storage.dbPath);
    runMigrations(this.db);

    this.vectorStore = await initializeVectorStore({ zvecPath: this.config.storage.zvecPath });

    this.embedProvider = createEmbeddingProvider({
      provider: this.config.ai.embedding.provider,
      model: this.config.ai.embedding.model,
      dimensions: this.config.ai.embedding.dimensions,
      batchSize: this.config.ai.embedding.batchSize,
      maxTokens: this.config.ai.embedding.maxTokens,
    });
    await this.embedProvider.initialize();
  }

  context(workspace: string): CoreContext {
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
    });
  }

  createCollectionRaw(workspace: string): VectorCollection {
    assert(this.vectorStore, "Vector store not initialized");
    return this.vectorStore.createCollection(workspace, this.config.ai.embedding.dimensions);
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

  getStats(workspace: string): { total: number; active: number; deleted: number; archived: number; chunks: number } {
    assert(this.db, "DB not initialized");
    return getIngestStats(this.db, workspace);
  }

  get zvecPath(): string {
    return this.config.storage.zvecPath;
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
  const mcpWorkspace = `smoke-mcp-${runId}`;
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
