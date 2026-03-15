#!/usr/bin/env node

import { loadAppConfig } from "./config/loadConfig.js";
import { openDatabase, closeDatabase } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createEmbeddingProvider } from "./embed/factory.js";
import { initializeVectorStore } from "./vectors/index.js";
import {
  ingestWorkspace,
  ProgressReporter,
  getIngestStats,
} from "./ingest/index.js";
import { createCoreContext, createHeuristicEdgeSuggestionGenerator, createSaveEdgeSuggestionProvider, recall } from "./core/index.js";
import { startMcpServer } from "./mcp/index.js";
import { resolveStoragePaths } from "./storage/paths.js";
import type { MemoryType } from "./types/memory.js";
import { initLogger } from "./utils/logger.js";
import { createQueryExpander } from "./search/query-expander-factory.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { buildManualPullCommand, describeModelLocality, getQueryExpansionModelResolutions } from "./llm/local-models.js";

function parseLogsFlag(args: string[]): boolean | undefined {
  const flag = args.find((a) => a.startsWith("--logs="));
  if (!flag) return undefined;
  return flag.split("=")[1] === "true";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  const logsFlag = parseLogsFlag(args);
  if (logsFlag !== undefined) {
    initLogger({ verbose: logsFlag });
  } else {
    initLogger();
  }

  try {
    switch (command) {
      case "ingest":
        await handleIngest(args.slice(1));
        break;
      case "status":
        await handleStatus(args.slice(1));
        break;
      case "query":
        await handleQuery(args.slice(1));
        break;
      case "mcp":
        await handleMcp(args.slice(1));
        break;
      case "init":
        await handleInit(args.slice(1));
        break;
      case "doctor":
        await handleDoctor(args.slice(1));
        break;
      case "config":
        await handleConfig(args.slice(1));
        break;
      case "models":
        await handleModels(args.slice(1));
        break;
      case "help":
      default:
        showHelp();
        break;
    }
  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function handleIngest(args: string[]): Promise<void> {
  const pathArg = args[0];
  const workspaceArg = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];

  if (!pathArg) {
    console.error("Usage: zmem ingest <path> [--workspace=<name>]");
    process.exit(1);
  }

  const targetPath = resolve(pathArg);
  if (!existsSync(targetPath)) {
    console.error(`Error: Path does not exist: ${targetPath}`);
    process.exit(1);
  }

  console.log("🚀 zmem - Ingesting documents\n");

  const config = loadAppConfig();
  const workspaceName = workspaceArg || "default";
  const storage = resolveStoragePaths(config, workspaceName);

  mkdirSync(dirname(storage.dbPath), { recursive: true });
  mkdirSync(storage.zvecPath, { recursive: true });

  const db = openDatabase(storage.dbPath);
  runMigrations(db);

  const vectorStore = await initializeVectorStore({
    zvecPath: storage.zvecPath,
  });

  const embedProvider = createEmbeddingProvider({
    provider: config.ai.embedding.provider,
    model: config.ai.embedding.model,
    dimensions: config.ai.embedding.dimensions,
    batchSize: config.ai.embedding.batchSize,
    maxTokens: config.ai.embedding.maxTokens,
    baseUrl: config.ai.embedding.baseUrl,
    apiKey: config.ai.embedding.apiKey,
    taskType: config.ai.embedding.taskType,
  });
  await embedProvider.initialize();

  const reporter = new ProgressReporter();
  reporter.start();

  const collection =
    vectorStore.openCollection(workspaceName) ??
    vectorStore.createCollection(workspaceName, config.ai.embedding.dimensions);

  try {
    const result = await ingestWorkspace({
      workspace: workspaceName,
      workspacePath: targetPath,
      patterns: ["**/*.md"],
      db,
      vectorStore: collection,
      embedProvider,
      reporter,
    });

    reporter.finish(result);
  } finally {
    await embedProvider.dispose();
    collection.close();
    vectorStore.close();
    closeDatabase(db);
  }
}

async function handleStatus(args: string[]): Promise<void> {
  const workspaceArg = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const workspaceName = workspaceArg || "default";

  console.log("📊 zmem - Status\n");

  const config = loadAppConfig();
  const storage = resolveStoragePaths(config, workspaceName);
  const models = getQueryExpansionModelResolutions(config);

  if (!existsSync(storage.dbPath)) {
    console.log("No database found. Run 'zmem ingest <path>' first.");
    return;
  }

  const db = openDatabase(storage.dbPath);

  try {
    const stats = getIngestStats(db, workspaceName);

    console.log(`Workspace: ${workspaceName}`);
    console.log(`Database: ${storage.dbPath}`);
    console.log(`Vectors: ${storage.zvecPath}`);
    console.log(`Query expansion: ${config.ai.queryExpansion.enabled ? config.defaults.retrieval.expansionMode : "off"}`);
    console.log(`Expansion model: ${models.primary.modelUri}`);
    console.log(`Expansion fallback: ${models.fallback.modelUri}`);
    console.log("");
    console.log(`Total documents: ${stats.total}`);
    console.log(`  Active: ${stats.active}`);
    console.log(`  Deleted: ${stats.deleted}`);
    console.log(`  Archived: ${stats.archived}`);
    console.log(`Chunks: ${stats.chunks}`);
  } finally {
    closeDatabase(db);
  }
}

async function handleQuery(args: string[]): Promise<void> {
  const queryArg = args[0];
  const workspaceArg = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const rawMode = args.find((a) => a.startsWith("--mode="))?.split("=")[1];
  const scopesArg = args.find((a) => a.startsWith("--scopes="))?.split("=")[1];
  const typesArg = args.find((a) => a.startsWith("--types="))?.split("=")[1];
  const rawExpansionMode = args.find((a) => a.startsWith("--expansion-mode="))?.split("=")[1];

  if (queryArg === undefined) {
    console.error("Usage: zmem query <query> [--workspace=<name>] [--mode=hybrid|lexical|vector|recent|important|typed] [--scopes=scope1,scope2] [--types=type1,type2] [--expansion-mode=off|deterministic|llm]");
    process.exit(1);
  }

  const validModes = ["hybrid", "lexical", "vector", "recent", "important", "typed"] as const;
  if (rawMode && !validModes.includes(rawMode as typeof validModes[number])) {
    console.error(`Invalid mode: "${rawMode}". Must be one of: ${validModes.join(", ")}`);
    process.exit(1);
  }
  const modeArg = rawMode as typeof validModes[number] | undefined;
  const validExpansionModes = ["off", "deterministic", "llm"] as const;
  if (rawExpansionMode && !validExpansionModes.includes(rawExpansionMode as typeof validExpansionModes[number])) {
    console.error(`Invalid expansion mode: "${rawExpansionMode}". Must be one of: ${validExpansionModes.join(", ")}`);
    process.exit(1);
  }
  const expansionModeArg = rawExpansionMode as typeof validExpansionModes[number] | undefined;

  console.log("🔍 zmem - Query\n");

  const config = loadAppConfig();
  const workspaceName = workspaceArg || "default";
  const storage = resolveStoragePaths(config, workspaceName);

  if (!existsSync(storage.dbPath)) {
    console.log("No database found. Run 'zmem ingest <path>' first.");
    return;
  }

  const db = openDatabase(storage.dbPath);
  const vectorStore = await initializeVectorStore({
    zvecPath: storage.zvecPath,
  });

  const embedProvider = createEmbeddingProvider({
    provider: config.ai.embedding.provider,
    model: config.ai.embedding.model,
    dimensions: config.ai.embedding.dimensions,
    batchSize: config.ai.embedding.batchSize,
    maxTokens: config.ai.embedding.maxTokens,
    baseUrl: config.ai.embedding.baseUrl,
    apiKey: config.ai.embedding.apiKey,
    taskType: config.ai.embedding.taskType,
  });

  let collection: import("./vectors/index.js").VectorCollection | null = null;
  const edgeSuggestionProvider = createSaveEdgeSuggestionProvider({
    generator: createHeuristicEdgeSuggestionGenerator(),
  });
  const queryExpander = createQueryExpander(config);

  try {
    await embedProvider.initialize();

    collection =
      vectorStore.openCollection(workspaceName) ??
      vectorStore.createCollection(workspaceName, config.ai.embedding.dimensions);

    const validScopes = ["workspace", "global", "user"] as const;
    const scopes = scopesArg
      ? scopesArg.split(",").filter((s): s is typeof validScopes[number] =>
          validScopes.includes(s as typeof validScopes[number])
        )
      : undefined;

    const validTypes: MemoryType[] = ["fact", "decision", "preference", "event", "goal", "todo"];
    const types = typesArg
      ? typesArg.split(",").filter((t): t is MemoryType =>
          validTypes.includes(t as MemoryType)
        )
      : undefined;

    // Use core API for search
    const ctx = createCoreContext({
      db,
      embedProvider,
      vectorCollection: collection,
      workspace: workspaceName,
      config,
      edgeSuggestionProvider,
      queryExpander,
    });
    
    const results = await recall(ctx, queryArg, {
      scopes,
      types,
      mode: modeArg || "hybrid",
      expansionMode: expansionModeArg,
    });

    if (results.length === 0) {
      console.log("No results found.\n");
    } else {
      console.log(`Found ${results.length} result(s):\n`);
      results.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`);
        console.log(`   Score: ${r.score.toFixed(3)} | Source: ${r.source} | Type: ${r.type} | Scope: ${r.scope}`);
        console.log(`   ${r.snippet.slice(0, 100)}${r.snippet.length > 100 ? "..." : ""}`);
        console.log("");
      });
    }
  } finally {
    collection?.close();
    vectorStore.close();
    closeDatabase(db);
    await embedProvider.dispose();
  }
}

async function handleMcp(args: string[]): Promise<void> {
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
  const workspace = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const verboseFlag = args.find((a) => a.startsWith("--verbose="))?.split("=")[1];
  const verbose = verboseFlag ? verboseFlag === "true" : undefined;

  initLogger({ verbose: false, quiet: true });

  const handle = await startMcpServer({
    configPath,
    workspace,
    verbose,
  });

  await new Promise<void>((resolve) => {
    let shuttingDown = false;

    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      await handle.close();
      resolve();
    };

    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
    process.stdin.once("end", () => {
      void shutdown();
    });
    process.stdin.once("close", () => {
      void shutdown();
    });
  });
}

async function handleInit(args: string[]): Promise<void> {
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1] ?? "./config.json";
  const workspaceNameArg = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const workspaceRootArg = args.find((a) => a.startsWith("--root="))?.split("=")[1];
  const storageBaseDirArg = args.find((a) => a.startsWith("--storage-base-dir="))?.split("=")[1];
  const enableQueryExpansionArg = args.find((a) => a.startsWith("--enable-query-expansion="))?.split("=")[1];
  const yes = args.includes("--yes");

  const existingConfig = loadOrCreateConfigObject(configPath);
  let workspaceName = workspaceNameArg ?? "default";
  let workspaceRoot = workspaceRootArg ?? process.cwd();
  let storageBaseDir = storageBaseDirArg ?? existingConfig.storage?.baseDir;
  let enableQueryExpansion = enableQueryExpansionArg ? enableQueryExpansionArg === "true" : (existingConfig.ai?.queryExpansion?.enabled ?? true);

  if (!yes) {
    const rl = createInterface({ input, output });
    try {
      workspaceName = (await rl.question(`Workspace name [${workspaceName}]: `)).trim() || workspaceName;
      workspaceRoot = resolve((await rl.question(`Workspace root [${workspaceRoot}]: `)).trim() || workspaceRoot);
      storageBaseDir = (await rl.question(`Storage base dir [${storageBaseDir ?? "XDG default"}]: `)).trim() || storageBaseDir;
      const expansionAnswer = (await rl.question(`Enable local query expansion [${enableQueryExpansion ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
      if (expansionAnswer === "y" || expansionAnswer === "yes") {
        enableQueryExpansion = true;
      } else if (expansionAnswer === "n" || expansionAnswer === "no") {
        enableQueryExpansion = false;
      }
    } finally {
      rl.close();
    }
  }

  const workspaceEntry = {
    name: workspaceName,
    root: workspaceRoot,
    includeByDefault: true,
    patterns: ["**/*.md"],
    context: existingConfig.workspaces?.find((workspace: Record<string, any>) => workspace.name === workspaceName)?.context,
  };

  const nextConfig = {
    ...existingConfig,
    defaults: {
      ...existingConfig.defaults,
      retrievalMode: existingConfig.defaults?.retrievalMode ?? "hybrid",
      scopesDefault: existingConfig.defaults?.scopesDefault ?? ["workspace", "global"],
      retrieval: {
        ...(existingConfig.defaults?.retrieval ?? {}),
        expansionMode: enableQueryExpansion ? "llm" : "off",
      },
    },
    ai: {
      ...existingConfig.ai,
      embedding: {
        ...(existingConfig.ai?.embedding ?? {}),
      },
      rerank: {
        ...(existingConfig.ai?.rerank ?? {}),
      },
      queryExpansion: {
        ...(existingConfig.ai?.queryExpansion ?? {}),
        enabled: enableQueryExpansion,
      },
    },
    storage: {
      ...(existingConfig.storage ?? {}),
      ...(storageBaseDir ? { baseDir: storageBaseDir } : {}),
    },
    workspaces: upsertWorkspace(existingConfig.workspaces ?? [], workspaceEntry),
  };

  writeFileSync(resolve(configPath), `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  console.log(`Wrote config to ${resolve(configPath)}`);
  console.log(`Workspace '${workspaceName}' configured.`);
  console.log(`Local query expansion: ${enableQueryExpansion ? "enabled" : "disabled"}`);
}

async function handleDoctor(args: string[]): Promise<void> {
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1] ?? "./config.json";
  const workspaceName = args.find((a) => a.startsWith("--workspace="))?.split("=")[1] ?? "default";
  const config = loadAppConfig(configPath);
  const storage = resolveStoragePaths(config, workspaceName);
  const modelInfo = getQueryExpansionModelResolutions(config);
  const primaryLocality = describeModelLocality(modelInfo.primary.modelUri, modelInfo.primary.modelsDir);
  const fallbackLocality = describeModelLocality(modelInfo.fallback.modelUri, modelInfo.fallback.modelsDir);

  console.log("zmem doctor\n");
  console.log(`Config: ${resolve(configPath)}`);
  console.log(`Workspace: ${workspaceName}`);
  console.log(`Database path: ${storage.dbPath}`);
  console.log(`Vector path: ${storage.zvecPath}`);
  console.log(`Storage root exists: ${existsSync(dirname(storage.dbPath)) ? "yes" : "no"}`);
  console.log(`Query expansion enabled: ${config.ai.queryExpansion.enabled ? "yes" : "no"}`);
  console.log(`Query expansion provider: ${config.ai.queryExpansion.provider}`);
  console.log(`Query expansion model: ${modelInfo.primary.modelUri}`);
  console.log(`Query expansion fallback: ${modelInfo.fallback.modelUri}`);
  console.log(`Primary model locality: ${primaryLocality.kind === "remote_hf" ? `remote HF URI -> ${primaryLocality.displayPath}` : primaryLocality.displayPath}`);
  console.log(`Fallback model locality: ${fallbackLocality.kind === "remote_hf" ? `remote HF URI -> ${fallbackLocality.displayPath}` : fallbackLocality.displayPath}`);
  if (config.ai.queryExpansion.provider === "llamacpp") {
    console.log("Query expansion readiness: run 'zmem models check' or 'zmem models pull' for local model setup guidance.");
  }
}

async function handleConfig(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "show";
  if (subcommand !== "show") {
    throw new Error(`Unknown config subcommand: ${subcommand}`);
  }

  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1] ?? "./config.json";
  const workspaceName = args.find((a) => a.startsWith("--workspace="))?.split("=")[1] ?? "default";
  const config = loadAppConfig(configPath);
  const storage = resolveStoragePaths(config, workspaceName);
  const models = getQueryExpansionModelResolutions(config);

  console.log(JSON.stringify({
    configPath: resolve(configPath),
    workspace: workspaceName,
    storage,
    config,
    queryExpansionModels: models,
  }, null, 2));
}

async function handleModels(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "status";
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1] ?? "./config.json";
  const config = loadAppConfig(configPath);
  const { primary, fallback } = getQueryExpansionModelResolutions(config);
  const storage = resolveStoragePaths(config, "default");

  if (subcommand === "status" || subcommand === "check") {
    const primaryLocality = describeModelLocality(primary.modelUri, primary.modelsDir);
    const fallbackLocality = describeModelLocality(fallback.modelUri, fallback.modelsDir);
    console.log(`Model directory: ${getQueryExpansionModelResolutions(config).primary.modelsDir}`);
    console.log(`Embedding model: ${config.ai.embedding.model}`);
    console.log(`Query expansion primary: ${primary.modelUri}`);
    console.log(`Query expansion fallback: ${fallback.modelUri}`);
    console.log(`Primary locality: ${primaryLocality.kind === "remote_hf" ? `remote HF URI -> ${primaryLocality.displayPath}` : primaryLocality.displayPath}`);
    console.log(`Fallback locality: ${fallbackLocality.kind === "remote_hf" ? `remote HF URI -> ${fallbackLocality.displayPath}` : fallbackLocality.displayPath}`);
    console.log(`Storage base: ${storage.baseDir}`);
    console.log("For Hugging Face URIs, models may download on first use unless you pull them manually.");
    return;
  }

  if (subcommand === "pull") {
    console.log("Run these commands to download local query-expansion models into zmem's model directory:\n");
    console.log(buildManualPullCommand(primary.modelUri, primary.modelsDir));
    console.log(buildManualPullCommand(fallback.modelUri, fallback.modelsDir));
    return;
  }

  throw new Error(`Unknown models subcommand: ${subcommand}`);
}

function loadOrCreateConfigObject(configPath: string): Record<string, any> {
  const absolute = resolve(configPath);
  if (!existsSync(absolute)) {
    return {
      defaults: {
        retrievalMode: "hybrid",
        scopesDefault: ["workspace", "global"],
        retrieval: {},
      },
      ai: {
        embedding: {},
        rerank: {},
        queryExpansion: {},
      },
      workspaces: [],
      storage: {},
    };
  }

  return JSON.parse(readFileSync(absolute, "utf8")) as Record<string, any>;
}

function upsertWorkspace(workspaces: Array<Record<string, any>>, entry: Record<string, any>): Array<Record<string, any>> {
  const filtered = workspaces.filter((workspace: Record<string, any>) => workspace.name !== entry.name);
  return [...filtered, entry];
}

function showHelp(): void {
  console.log(`
zmem - Local-first hybrid memory system

Usage:
  zmem <command> [options]

Commands:
  ingest <path> [--workspace=<name>] [--logs=true|false]   Ingest markdown files from path
  status [--workspace=<name>] [--logs=true|false]         Show ingestion status
  query <query> [--workspace=<name>] [--mode=hybrid|lexical|vector|recent|important|typed] [--expansion-mode=off|deterministic|llm] [--logs=true|false]
                                       Search memories
  init [--config=./config.json] [--workspace=<name>] [--root=<path>] [--storage-base-dir=<path>] [--enable-query-expansion=true|false] [--yes]
                                       Create or update a starter config
  doctor [--config=./config.json] [--workspace=<name>]
                                       Validate config, storage, and model setup
  config show [--config=./config.json] [--workspace=<name>]
                                       Print resolved config and storage paths
  models <status|check|pull> [--config=./config.json]
                                       Inspect or prepare local model setup
  mcp [--config=./config.json] [--workspace=<name>] [--verbose=true|false]
                                       Start MCP stdio server
  help                                 Show this help message

Examples:
  zmem ingest ./docs
  zmem ingest ./my-notes --workspace=personal
  zmem status --workspace=default
  zmem query "sqlite database"
  zmem query "database decisions" --mode=hybrid
  zmem query "" --mode=recent --workspace=default
  zmem query "dark mode" --types=preference
  zmem query "sqlite" --logs=true
  zmem init --workspace=default --root=/absolute/path --yes
  zmem doctor --workspace=default
  zmem config show --workspace=default
  zmem models pull
  zmem mcp --workspace=default
  zmem mcp --workspace=default --verbose=true
`);
}

main();
