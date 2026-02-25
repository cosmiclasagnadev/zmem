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
import { createCoreContext, recall } from "./core/index.js";
import type { MemoryType } from "./types/memory.js";
import { initLogger } from "./utils/logger.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  mkdirSync(config.storage.zvecPath, { recursive: true });

  const db = openDatabase(config.storage.dbPath);
  runMigrations(db);

  const vectorStore = await initializeVectorStore({
    zvecPath: config.storage.zvecPath,
  });

  const embedProvider = createEmbeddingProvider({
    provider: config.ai.embedding.provider,
    model: config.ai.embedding.model,
    dimensions: config.ai.embedding.dimensions,
    batchSize: config.ai.embedding.batchSize,
    maxTokens: config.ai.embedding.maxTokens,
  });
  await embedProvider.initialize();

  const reporter = new ProgressReporter();
  reporter.start();

  const collection = vectorStore.createCollection(
    workspaceName,
    config.ai.embedding.dimensions
  );

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

  if (!existsSync(config.storage.dbPath)) {
    console.log("No database found. Run 'zmem ingest <path>' first.");
    return;
  }

  const db = openDatabase(config.storage.dbPath);

  try {
    const stats = getIngestStats(db, workspaceName);

    console.log(`Workspace: ${workspaceName}`);
    console.log(`Database: ${config.storage.dbPath}`);
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

  if (!queryArg) {
    console.error("Usage: zmem query <query> [--workspace=<name>] [--mode=hybrid|lexical|vector] [--scopes=scope1,scope2] [--types=type1,type2]");
    process.exit(1);
  }

  const validModes = ["hybrid", "lexical", "vector"] as const;
  if (rawMode && !validModes.includes(rawMode as typeof validModes[number])) {
    console.error(`Invalid mode: "${rawMode}". Must be one of: ${validModes.join(", ")}`);
    process.exit(1);
  }
  const modeArg = rawMode as "hybrid" | "lexical" | "vector" | undefined;

  console.log("🔍 zmem - Query\n");

  const config = loadAppConfig();
  const workspaceName = workspaceArg || "default";

  if (!existsSync(config.storage.dbPath)) {
    console.log("No database found. Run 'zmem ingest <path>' first.");
    return;
  }

  const db = openDatabase(config.storage.dbPath);
  const vectorStore = await initializeVectorStore({
    zvecPath: config.storage.zvecPath,
  });

  const embedProvider = createEmbeddingProvider({
    provider: config.ai.embedding.provider,
    model: config.ai.embedding.model,
    dimensions: config.ai.embedding.dimensions,
    batchSize: config.ai.embedding.batchSize,
    maxTokens: config.ai.embedding.maxTokens,
  });

  let collection: import("./vectors/index.js").VectorCollection | null = null;

  try {
    await embedProvider.initialize();

    collection = vectorStore.createCollection(
      workspaceName,
      config.ai.embedding.dimensions
    );

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
    });
    
    const results = await recall(ctx, queryArg, {
      scopes,
      types,
      mode: modeArg || "hybrid",
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

function showHelp(): void {
  console.log(`
zmem - Local-first hybrid memory system

Usage:
  zmem <command> [options]

Commands:
  ingest <path> [--workspace=<name>] [--logs=true|false]   Ingest markdown files from path
  status [--workspace=<name>] [--logs=true|false]         Show ingestion status
  query <query> [--workspace=<name>] [--mode=hybrid|lexical|vector] [--logs=true|false]
                                       Search memories
  help                                 Show this help message

Examples:
  zmem ingest ./docs
  zmem ingest ./my-notes --workspace=personal
  zmem status --workspace=default
  zmem query "sqlite database"
  zmem query "database decisions" --mode=hybrid
  zmem query "dark mode" --types=preference
  zmem query "sqlite" --logs=true
`);
}

main();
