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
        expansionMode: "llm",
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
    queryExpansion: {
      enabled: true,
      provider: "llamacpp",
      model: "hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_M",
      fallbackModel: "hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_S",
      maxExpansions: 3,
      includeLexical: true,
      timeoutMs: 4000,
      strongSignalBypass: true,
      strongSignalMinScore: 0.72,
      strongSignalMinGap: 0.12,
      contextSize: 2048,
      temperature: 0.4,
      topK: 20,
      topP: 0.8,
      cacheSize: 128,
    },
  },
  workspaces: [],
  storage: {},
  };
}

function applyEnvOverrides(config: AppConfig): AppConfig {
  const next = structuredClone(config);

  if (process.env.ZMD_EMBED_MODEL) {
    next.ai.embedding.model = process.env.ZMD_EMBED_MODEL;
  }
  if (process.env.ZMD_EMBED_DIMENSIONS) {
    const dimensions = Number(process.env.ZMD_EMBED_DIMENSIONS);
    if (Number.isInteger(dimensions) && dimensions > 0) {
      next.ai.embedding.dimensions = dimensions;
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
      next.ai.embedding.provider = provider;
    }
  }
  if (process.env.ZMD_EMBED_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    next.ai.embedding.apiKey =
      process.env.ZMD_EMBED_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  }
  if (process.env.ZMD_EMBED_BASE_URL) {
    next.ai.embedding.baseUrl = process.env.ZMD_EMBED_BASE_URL;
  }
  if (process.env.ZMD_EMBED_TASK_TYPE) {
    next.ai.embedding.taskType = process.env.ZMD_EMBED_TASK_TYPE;
  }
  if (process.env.ZMEM_STORAGE_BASE_DIR) {
    next.storage.baseDir = process.env.ZMEM_STORAGE_BASE_DIR;
  }
  if (process.env.ZMEM_DB_PATH) {
    next.storage.dbPath = process.env.ZMEM_DB_PATH;
  }
  if (process.env.ZMEM_ZVEC_PATH) {
    next.storage.zvecPath = process.env.ZMEM_ZVEC_PATH;
  }
  if (process.env.ZMEM_QUERY_EXPANSION_ENABLED) {
    next.ai.queryExpansion.enabled = process.env.ZMEM_QUERY_EXPANSION_ENABLED === "true";
  }
  if (process.env.ZMEM_QUERY_EXPANSION_PROVIDER) {
    const provider = process.env.ZMEM_QUERY_EXPANSION_PROVIDER;
    if (provider === "deterministic" || provider === "llamacpp") {
      next.ai.queryExpansion.provider = provider;
    }
  }
  if (process.env.ZMEM_QUERY_EXPANSION_MODEL) {
    next.ai.queryExpansion.model = process.env.ZMEM_QUERY_EXPANSION_MODEL;
  }
  if (process.env.ZMEM_QUERY_EXPANSION_FALLBACK_MODEL) {
    next.ai.queryExpansion.fallbackModel = process.env.ZMEM_QUERY_EXPANSION_FALLBACK_MODEL;
  }
  if (process.env.ZMEM_QUERY_EXPANSION_MAX_EXPANSIONS) {
    const value = Number(process.env.ZMEM_QUERY_EXPANSION_MAX_EXPANSIONS);
    if (Number.isInteger(value) && value > 0) {
      next.ai.queryExpansion.maxExpansions = value;
    }
  }
  if (process.env.ZMEM_QUERY_EXPANSION_TIMEOUT_MS) {
    const value = Number(process.env.ZMEM_QUERY_EXPANSION_TIMEOUT_MS);
    if (Number.isInteger(value) && value > 0) {
      next.ai.queryExpansion.timeoutMs = value;
    }
  }

  return next;
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

  const absolute = resolve(configPath);
  if (!existsSync(absolute)) {
    if (!options.silent) {
      console.log(`⚠️  No config file found at ${configPath}, using defaults`);
    }
    return applyEnvOverrides(defaultConfig);
  }

  const raw = readFileSync(absolute, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const merged = appConfigSchema.parse({
    ...defaultConfig,
    ...(parsed as object),
    defaults: {
      ...defaultConfig.defaults,
      ...((parsed as { defaults?: object }).defaults ?? {}),
      retrieval: {
        ...defaultConfig.defaults.retrieval,
        ...((parsed as { defaults?: { retrieval?: object } }).defaults?.retrieval ?? {}),
      },
    },
    ai: {
      ...defaultConfig.ai,
      ...((parsed as { ai?: object }).ai ?? {}),
      embedding: {
        ...defaultConfig.ai.embedding,
        ...((parsed as { ai?: { embedding?: object } }).ai?.embedding ?? {}),
      },
      rerank: {
        ...defaultConfig.ai.rerank,
        ...((parsed as { ai?: { rerank?: object } }).ai?.rerank ?? {}),
      },
      queryExpansion: {
        ...defaultConfig.ai.queryExpansion,
        ...((parsed as { ai?: { queryExpansion?: object } }).ai?.queryExpansion ?? {}),
      },
    },
    storage: {
      ...defaultConfig.storage,
      ...((parsed as { storage?: object }).storage ?? {}),
    },
    workspaces: (parsed as { workspaces?: unknown[] }).workspaces ?? defaultConfig.workspaces,
  });
  return applyEnvOverrides(merged);
}
