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
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  try {
    switch (command) {
      case "ingest":
        await handleIngest(args.slice(1));
        break;
      case "status":
        await handleStatus(args.slice(1));
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

  // Load configuration
  const config = loadAppConfig();
  const workspaceName = workspaceArg || "default";

  // Setup directories
  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  mkdirSync(config.storage.zvecPath, { recursive: true });

  // Initialize database
  const db = openDatabase(config.storage.dbPath);
  runMigrations(db);

  // Initialize vector store
  const vectorStore = await initializeVectorStore({
    zvecPath: config.storage.zvecPath,
  });

  // Initialize embedding provider
  const embedProvider = createEmbeddingProvider({
    provider: config.ai.embedding.provider,
    model: config.ai.embedding.model,
    dimensions: config.ai.embedding.dimensions,
    batchSize: config.ai.embedding.batchSize,
    maxTokens: config.ai.embedding.maxTokens,
  });
  await embedProvider.initialize();

  // Create progress reporter
  const reporter = new ProgressReporter();
  reporter.start();

  // Create vector collection for this workspace
  const collection = vectorStore.createCollection(
    workspaceName,
    config.ai.embedding.dimensions
  );

  // Run ingestion
  const result = await ingestWorkspace({
    workspace: workspaceName,
    workspacePath: targetPath,
    patterns: ["**/*.md"],
    db,
    vectorStore: collection,
    embedProvider,
    reporter,
  });

  // Show results
  reporter.finish(result);

  // Cleanup
  await embedProvider.dispose();
  collection.close();
  vectorStore.close();
  closeDatabase(db);
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

function showHelp(): void {
  console.log(`
zmem - Local-first hybrid memory system

Usage:
  zmem <command> [options]

Commands:
  ingest <path> [--workspace=<name>]   Ingest markdown files from path
  status [--workspace=<name>]          Show ingestion status
  help                                 Show this help message

Examples:
  zmem ingest ./docs
  zmem ingest ./my-notes --workspace=personal
  zmem status --workspace=default
`);
}

main();
