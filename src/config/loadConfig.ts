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
      taskType: undefined,
    },
    rerank: {
      enabled: false,
      topK: 20,
    },
  },
  workspaces: [],
  storage: {},
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
  if (process.env.ZMD_EMBED_DIMENSIONS) {
    const dimensions = Number(process.env.ZMD_EMBED_DIMENSIONS);
    if (Number.isInteger(dimensions) && dimensions > 0) {
      defaultConfig.ai.embedding.dimensions = dimensions;
    }
  }
  if (process.env.ZMD_EMBED_PROVIDER) {
    const provider = process.env.ZMD_EMBED_PROVIDER;
    if (
      provider === "llamacpp" ||
      provider === "openai" ||
      provider === "ollama" ||
      provider === "gemini" ||
      provider === "mock"
    ) {
      defaultConfig.ai.embedding.provider = provider;
    }
  }
  if (process.env.ZMD_EMBED_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    defaultConfig.ai.embedding.apiKey =
      process.env.ZMD_EMBED_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  }
  if (process.env.ZMD_EMBED_BASE_URL) {
    defaultConfig.ai.embedding.baseUrl = process.env.ZMD_EMBED_BASE_URL;
  }
  if (process.env.ZMD_EMBED_TASK_TYPE) {
    defaultConfig.ai.embedding.taskType = process.env.ZMD_EMBED_TASK_TYPE;
  }
  if (process.env.ZMEM_STORAGE_BASE_DIR) {
    defaultConfig.storage.baseDir = process.env.ZMEM_STORAGE_BASE_DIR;
  }
  if (process.env.ZMEM_DB_PATH) {
    defaultConfig.storage.dbPath = process.env.ZMEM_DB_PATH;
  }
  if (process.env.ZMEM_ZVEC_PATH) {
    defaultConfig.storage.zvecPath = process.env.ZMEM_ZVEC_PATH;
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
