import { loadAppConfig } from "./config/loadConfig.js";
import { openDatabase, closeDatabase } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createEmbeddingProvider } from "./embed/factory.js";
import { initializeVectorStore } from "./vectors/index.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

async function main(): Promise<void> {
  console.log("🚀 zmem - Phase 1 Initialization\n");

  try {
    // 1. Load configuration
    console.log("📋 Loading configuration...");
    const config = loadAppConfig();
    console.log(`   ✓ Config loaded: ${config.workspaces.length} workspace(s)`);
    console.log(`   ✓ Default embedding: ${config.ai.embedding.model}`);
    console.log(`   ✓ Dimensions: ${config.ai.embedding.dimensions}`);

    // 2. Ensure data directories exist
    console.log("\n📁 Setting up data directories...");
    mkdirSync(dirname(config.storage.dbPath), { recursive: true });
    mkdirSync(config.storage.zvecPath, { recursive: true });
    console.log(`   ✓ Database: ${config.storage.dbPath}`);
    console.log(`   ✓ Vector store: ${config.storage.zvecPath}`);

    // 3. Initialize database and run migrations
    console.log("\n🗄️  Initializing database...");
    const db = openDatabase(config.storage.dbPath);
    runMigrations(db);
    console.log("   ✓ Database migrations complete");

    // 4. Initialize vector store
    console.log("\n📊 Initializing vector store...");
    const vectorStore = await initializeVectorStore({
      zvecPath: config.storage.zvecPath
    });
    console.log("   ✓ Vector store ready");

    // 5. Initialize embedding provider
    console.log("\n🧠 Initializing embedding provider...");
    const embedProvider = createEmbeddingProvider({
      provider: config.ai.embedding.provider,
      model: config.ai.embedding.model,
      dimensions: config.ai.embedding.dimensions,
      batchSize: config.ai.embedding.batchSize,
      maxTokens: config.ai.embedding.maxTokens,
      baseUrl: config.ai.embedding.baseUrl,
      apiKey: config.ai.embedding.apiKey
    });
    
    await embedProvider.initialize();
    console.log("   ✓ Embedding provider ready");

    // 6. Health check - test embedding
    console.log("\n🏥 Running health check...");
    const isHealthy = await embedProvider.healthCheck();
    if (!isHealthy) {
      throw new Error("Embedding provider health check failed");
    }
    console.log("   ✓ Health check passed");

    // 7. Test end-to-end: embed and store
    console.log("\n🧪 Testing end-to-end (embed + store)...");
    
    const testText = "This is a test document about project decisions and architecture.";
    console.log(`   Embedding: "${testText.substring(0, 50)}..."`);
    
    const embedding = await embedProvider.embed(testText);
    console.log(`   ✓ Generated embedding: ${embedding.length} dimensions`);
    
    // Create a test collection and store the vector
    const collection = vectorStore.createCollection("test", config.ai.embedding.dimensions);
    collection.insert("test-1", embedding);
    console.log("   ✓ Stored vector in collection");
    
    // Query it back
    const results = await collection.query(embedding, 5);
    console.log(`   ✓ Query returned ${results.length} result(s)`);
    console.log(`   ✓ Top result score: ${results[0]?.score.toFixed(4) ?? 'N/A'}`);
    
    // Cleanup
    collection.close();

    console.log("\n✅ Phase 1 Complete!");
    console.log("\n📊 System Status:");
    console.log(`   • Database: Connected (${config.storage.dbPath})`);
    console.log(`   • Vector Store: Ready (${config.storage.zvecPath})`);
    console.log(`   • Embedding: ${config.ai.embedding.model}`);
    console.log(`   • Dimensions: ${config.ai.embedding.dimensions}`);
    console.log(`   • Provider: ${config.ai.embedding.provider}`);

    // Cleanup
    await embedProvider.dispose();
    vectorStore.close();
    closeDatabase(db);

    console.log("\n👋 Shutdown complete.");

  } catch (error) {
    console.error("\n❌ Fatal error:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
