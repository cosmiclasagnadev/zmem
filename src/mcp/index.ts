import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z, ZodError } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAppConfig } from "../config/loadConfig.js";
import { closeDatabase, openDatabase, type DbHandle } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { createEmbeddingProvider } from "../embed/factory.js";
import type { EmbeddingProvider } from "../embed/types.js";
import {
  createCoreContext,
  deleteMemory,
  get,
  list,
  recall,
  reindex,
  save,
  status,
  CoreError,
  SaveMemoryInputSchema,
  RecallFiltersSchema,
} from "../core/index.js";
import { initializeVectorStore, type VectorCollection, type VectorStore } from "../vectors/index.js";
import type { AppConfig } from "../config/schema.js";

const MemoryTypeSchema = SaveMemoryInputSchema.shape.type;
const MemoryScopeSchema = z.enum(["workspace", "global", "user"]);
const MemoryStatusSchema = z.enum(["pending", "active", "archived", "deleted"]);
const ToolLimitSchema = z.number().int().positive().max(100);

const MemoryItemSchema = z.object({
  id: z.string(),
  type: MemoryTypeSchema,
  title: z.string(),
  content: z.string(),
  summary: z.string(),
  source: z.string(),
  scope: MemoryScopeSchema,
  tags: z.array(z.string()),
  importance: z.number(),
  status: MemoryStatusSchema,
  supersedesId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RecallHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  score: z.number(),
  source: z.enum(["lex", "vec", "hybrid"]),
  snippet: z.string(),
  scope: MemoryScopeSchema,
  type: MemoryTypeSchema,
});

const MemoryQueryInputSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: ToolLimitSchema.optional(),
  minScore: RecallFiltersSchema.shape.minScore.optional(),
  scopes: RecallFiltersSchema.shape.scopes.optional(),
  types: RecallFiltersSchema.shape.types.optional(),
  includeSuperseded: RecallFiltersSchema.shape.includeSuperseded.optional(),
  mode: RecallFiltersSchema.shape.mode.optional(),
}).strict();

const MemoryQueryOutputSchema = z.object({
  results: z.array(RecallHitSchema),
  count: z.number().int().nonnegative(),
});

const MemoryGetInputSchema = z.object({
  id: z.string().min(1),
}).strict();

const MemoryGetOutputSchema = z.object({
  item: MemoryItemSchema.nullable(),
});

const MemoryListInputSchema = z.object({
  type: MemoryTypeSchema.optional(),
  scope: MemoryScopeSchema.optional(),
  status: MemoryStatusSchema.optional(),
  limit: ToolLimitSchema.optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict();

const MemoryListOutputSchema = z.object({
  items: z.array(MemoryItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

const MemorySaveInputSchema = SaveMemoryInputSchema;

const MemorySaveOutputSchema = z.object({
  id: z.string(),
  isNew: z.boolean(),
  supersededId: z.string().optional(),
});

const MemoryDeleteInputSchema = z.object({
  id: z.string().min(1),
}).strict();

const MemoryDeleteOutputSchema = z.object({
  deleted: z.boolean(),
});

const MemoryStatusOutputSchema = z.object({
  totalItems: z.number().int().nonnegative(),
  totalVectors: z.number().int().nonnegative(),
  pendingEmbeddings: z.number().int().nonnegative(),
  lastIndexedAt: z.string().nullable(),
});

const MemoryReindexOutputSchema = z.object({
  processed: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  duration: z.number().nonnegative(),
});

export interface McpServerHandle {
  close: () => Promise<void>;
}

interface StartMcpServerOptions {
  configPath?: string;
  workspace?: string;
  verbose?: boolean;
}

interface ToolErrorPayload {
  code: string;
  message: string;
}

function formatToolError(error: unknown): ToolErrorPayload {
  if (error instanceof CoreError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof ZodError) {
    return {
      code: "VALIDATION",
      message: error.errors
        .map((e) => `${e.path.join(".") || "input"}: ${e.message}`)
        .join(", "),
    };
  }

  if (error instanceof Error) {
    return { code: "INTERNAL", message: error.message };
  }

  return { code: "INTERNAL", message: String(error) };
}

function createMcpLogger(verbose: boolean) {
  const log = (message: string): void => {
    if (!verbose) {
      return;
    }
    const timestamp = new Date().toISOString();
    process.stderr.write(`[zmem:mcp ${timestamp}] ${message}\n`);
  };

  return {
    info: log,
  };
}

function summarizeForLog(label: string, value: string): string {
  return `${label}Len=${value.length}`;
}

function createToolResult<T>(schema: z.ZodType<T>, payload: T) {
  const parsed = schema.parse(payload);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool output must be an object");
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(parsed) }],
    structuredContent: parsed as Record<string, unknown>,
  };
}

async function executeTool<T>(
  schema: z.ZodType<T>,
  operation: () => Promise<T>
): Promise<
  | {
      content: Array<{ type: "text"; text: string }>;
      structuredContent: Record<string, unknown>;
    }
  | {
      isError: true;
      content: Array<{ type: "text"; text: string }>;
    }
> {
  try {
    const payload = await operation();
    return createToolResult(schema, payload);
  } catch (error) {
    const toolError = formatToolError(error);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(toolError) }],
    };
  }
}

function resolveWorkspace(config: AppConfig, explicitWorkspace?: string): string {
  if (explicitWorkspace) {
    return explicitWorkspace;
  }

  if (process.env.ZMEM_WORKSPACE && process.env.ZMEM_WORKSPACE.trim().length > 0) {
    return process.env.ZMEM_WORKSPACE;
  }

  if (config.workspaces.length === 1) {
    return config.workspaces[0].name;
  }

  return "default";
}

async function safeDispose(resources: {
  server: McpServer | null;
  embedProvider: EmbeddingProvider | null;
  vectorCollection: VectorCollection | null;
  vectorStore: VectorStore | null;
  db: DbHandle | null;
  transport: StdioServerTransport | null;
}): Promise<void> {
  try {
    await resources.server?.close();
  } catch {
    // Best-effort server close.
  }

  try {
    await resources.transport?.close?.();
  } catch {
    // Best-effort transport close.
  }

  try {
    resources.vectorCollection?.close();
  } catch {
    // Best-effort vector collection close.
  }

  try {
    resources.vectorStore?.close();
  } catch {
    // Best-effort vector store close.
  }

  try {
    if (resources.db) {
      closeDatabase(resources.db);
    }
  } catch {
    // Best-effort DB close.
  }

  try {
    await resources.embedProvider?.dispose();
  } catch {
    // Best-effort embed provider disposal.
  }
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<McpServerHandle> {
  const verbose = options.verbose ?? process.env.ZMEM_MCP_VERBOSE === "true";
  const logger = createMcpLogger(verbose);

  const resources: {
    server: McpServer | null;
    embedProvider: EmbeddingProvider | null;
    vectorCollection: VectorCollection | null;
    vectorStore: VectorStore | null;
    db: DbHandle | null;
    transport: StdioServerTransport | null;
  } = {
    server: null,
    embedProvider: null,
    vectorCollection: null,
    vectorStore: null,
    db: null,
    transport: null,
  };

  try {
    logger.info("Loading configuration");
    const config = loadAppConfig(options.configPath, { silent: true });
    const workspace = resolveWorkspace(config, options.workspace);
    logger.info(`Using workspace: ${workspace}`);

    mkdirSync(dirname(config.storage.dbPath), { recursive: true });
    mkdirSync(config.storage.zvecPath, { recursive: true });
    logger.info("Ensured storage directories exist");

    resources.db = openDatabase(config.storage.dbPath);
    runMigrations(resources.db);
    logger.info("Database opened and migrations applied");

    resources.vectorStore = await initializeVectorStore({
      zvecPath: config.storage.zvecPath,
    });
    logger.info("Vector store initialized");

    resources.vectorCollection =
      resources.vectorStore.openCollection(workspace) ??
      resources.vectorStore.createCollection(workspace, config.ai.embedding.dimensions);
    logger.info("Vector collection opened");

    resources.embedProvider = createEmbeddingProvider({
      provider: config.ai.embedding.provider,
      model: config.ai.embedding.model,
      dimensions: config.ai.embedding.dimensions,
      batchSize: config.ai.embedding.batchSize,
      maxTokens: config.ai.embedding.maxTokens,
    });

    try {
      await resources.embedProvider.initialize();
      logger.info("Embedding provider initialized");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Embedding provider failed to initialize: ${message}`);
    }

    const ctx = createCoreContext({
      db: resources.db,
      embedProvider: resources.embedProvider,
      vectorCollection: resources.vectorCollection,
      workspace,
      config,
    });

    resources.server = new McpServer({
      name: "zmem",
      version: "0.1.0",
    });

    resources.server.registerTool(
      "memory_query",
      {
        title: "Memory Query",
        description: "Hybrid memory search (lexical + vector).",
        inputSchema: MemoryQueryInputSchema,
        outputSchema: MemoryQueryOutputSchema,
      },
      async (input) =>
        executeTool(MemoryQueryOutputSchema, async () => {
          logger.info(`memory_query called (${summarizeForLog("query", input.query)})`);
          const results = await recall(ctx, input.query, {
            topK: input.limit,
            minScore: input.minScore,
            scopes: input.scopes,
            types: input.types,
            includeSuperseded: input.includeSuperseded,
            mode: input.mode,
          });

          return {
            results,
            count: results.length,
          };
        })
    );

    resources.server.registerTool(
      "memory_get",
      {
        title: "Memory Get",
        description: "Get a memory item by id.",
        inputSchema: MemoryGetInputSchema,
        outputSchema: MemoryGetOutputSchema,
      },
      async ({ id }) =>
        executeTool(MemoryGetOutputSchema, async () => {
          logger.info(`memory_get called (id=${id})`);
          const item = await get(ctx, id);
          return { item };
        })
    );

    resources.server.registerTool(
      "memory_list",
      {
        title: "Memory List",
        description: "List memory items with pagination and filters.",
        inputSchema: MemoryListInputSchema,
        outputSchema: MemoryListOutputSchema,
      },
      async (input) =>
        executeTool(MemoryListOutputSchema, async () => {
          logger.info("memory_list called");
          return list(ctx, {
            type: input.type,
            scope: input.scope,
            status: input.status,
            limit: input.limit,
            offset: input.offset,
          });
        })
    );

    resources.server.registerTool(
      "memory_save",
      {
        title: "Memory Save",
        description: "Create a new memory item.",
        inputSchema: MemorySaveInputSchema,
        outputSchema: MemorySaveOutputSchema,
      },
      async (input) =>
        executeTool(MemorySaveOutputSchema, async () => {
          logger.info(
            `memory_save called (type=${input.type}, ${summarizeForLog("title", input.title)})`
          );
          return save(ctx, input);
        })
    );

    resources.server.registerTool(
      "memory_delete",
      {
        title: "Memory Delete",
        description: "Soft-delete a memory item by id.",
        inputSchema: MemoryDeleteInputSchema,
        outputSchema: MemoryDeleteOutputSchema,
      },
      async ({ id }) =>
        executeTool(MemoryDeleteOutputSchema, async () => {
          logger.info(`memory_delete called (id=${id})`);
          const deleted = await deleteMemory(ctx, id);
          return { deleted };
        })
    );

    resources.server.registerTool(
      "memory_status",
      {
        title: "Memory Status",
        description: "Return memory system status for the current workspace.",
        inputSchema: z.object({}).strict(),
        outputSchema: MemoryStatusOutputSchema,
      },
      async () =>
        executeTool(MemoryStatusOutputSchema, async () => {
          logger.info("memory_status called");
          return status(ctx);
        })
    );

    const reindexEnabled = process.env.ZMEM_ENABLE_REINDEX_TOOL === "true";
    if (reindexEnabled) {
      resources.server.registerTool(
        "memory_reindex",
        {
          title: "Memory Reindex",
          description: "Reindex all active memory items (admin).",
          inputSchema: z.object({}).strict(),
          outputSchema: MemoryReindexOutputSchema,
        },
        async () =>
          executeTool(MemoryReindexOutputSchema, async () => {
            logger.info("memory_reindex called");
            return reindex(ctx);
          })
      );
      logger.info("Registered optional tool: memory_reindex");
    }

    resources.transport = new StdioServerTransport();
    await resources.server.connect(resources.transport);
    logger.info("MCP server connected over stdio");

    let closed = false;
    return {
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        logger.info("Shutting down MCP server");
        await safeDispose(resources);
      },
    };
  } catch (error) {
    await safeDispose(resources);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start MCP server: ${message}`);
  }
}
