import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { appConfigSchema, type AppConfig } from "./schema.js";

function createDefaultConfig(): AppConfig {
  return {
  defaults: {
    retrievalMode: "hybrid",
    scopesDefault: ["workspace", "global"],
    retrieval: {
      topKLex: 30,
      topKVec: 30,
      rerankTopK: 20,
      minScore: 0.25,
      includeSuperseded: false,
    },
  },
  ai: {
    embedding: {
      provider: "llamacpp",
      model: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      dimensions: 1024,
      quantization: "Q8_0",
      batchSize: 8,
      maxTokens: 8192,
    },
    rerank: {
      enabled: false,
      topK: 20,
    },
  },
  workspaces: [],
  storage: {
    dbPath: "./data/memory.db",
    zvecPath: "./data/vectors",
  },
  };
}

interface LoadConfigOptions {
  silent?: boolean;
}

export function loadAppConfig(
  configPath: string = "./config.json",
  options: LoadConfigOptions = {}
): AppConfig {
  loadDotenv();

  const defaultConfig = createDefaultConfig();

  // Allow env override for model
  if (process.env.ZMD_EMBED_MODEL) {
    defaultConfig.ai.embedding.model = process.env.ZMD_EMBED_MODEL;
  }
  if (process.env.ZMD_EMBED_PROVIDER) {
    const provider = process.env.ZMD_EMBED_PROVIDER;
    if (provider === "llamacpp" || provider === "openai" || provider === "ollama") {
      defaultConfig.ai.embedding.provider = provider;
    }
  }

  const absolute = resolve(configPath);
  if (!existsSync(absolute)) {
    if (!options.silent) {
      console.log(`⚠️  No config file found at ${configPath}, using defaults`);
    }
    return defaultConfig;
  }

  const raw = readFileSync(absolute, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return appConfigSchema.parse(parsed);
}
