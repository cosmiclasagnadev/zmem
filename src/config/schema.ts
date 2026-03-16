import { z } from "zod";

const retrievalDefaultsSchema = z.object({
  topKLex: z.number().int().positive().default(30),
  topKVec: z.number().int().positive().default(30),
  rerankTopK: z.number().int().positive().default(20),
  minScore: z.number().min(0).max(1).default(0.25),
  includeSuperseded: z.boolean().default(false),
  expansionMode: z.enum(["off", "deterministic", "llm"]).default("llm")
});

const workspaceSchema = z.object({
  name: z.string().min(1),
  root: z.string().min(1),
  includeByDefault: z.boolean().default(true),
  patterns: z.array(z.string()).min(1),
  context: z.string().optional()
});

const embeddingConfigSchema = z.object({
  provider: z.enum(["llamacpp", "openai", "ollama", "gemini", "mock"]).default("llamacpp"),
  model: z.string().default("hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"),
  dimensions: z.number().int().positive().default(1024),
  quantization: z.enum(["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "F16"]).default("Q8_0"),
  batchSize: z.number().int().positive().default(8),
  maxTokens: z.number().int().positive().default(8192),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  taskType: z.string().optional()
});

const rerankConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["llamacpp", "openai", "ollama"]).optional(),
  model: z.string().optional(),
  topK: z.number().int().positive().default(20)
});

const queryExpansionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["deterministic", "llamacpp"]).default("llamacpp"),
  model: z.string().default("hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_M"),
  fallbackModel: z.string().default("hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_S"),
  maxExpansions: z.number().int().positive().max(8).default(3),
  includeLexical: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(4000),
  strongSignalBypass: z.boolean().default(true),
  strongSignalMinScore: z.number().min(0).max(1).default(0.72),
  strongSignalMinGap: z.number().min(0).max(1).default(0.12),
  contextSize: z.number().int().positive().default(2048),
  temperature: z.number().min(0).max(2).default(0.4),
  topK: z.number().int().positive().default(20),
  topP: z.number().min(0).max(1).default(0.8),
  cacheSize: z.number().int().positive().default(128),
}).default({});

export const appConfigSchema = z.object({
  defaults: z.object({
    retrievalMode: z.enum(["hybrid", "lexical", "vector"]).default("hybrid"),
    scopesDefault: z.array(z.enum(["workspace", "global", "user"])).default(["workspace", "global"]),
    retrieval: retrievalDefaultsSchema
  }),
  ai: z.object({
    embedding: embeddingConfigSchema,
    rerank: rerankConfigSchema,
    queryExpansion: queryExpansionConfigSchema,
  }).default({
    embedding: {},
    rerank: {},
    queryExpansion: {},
  }),
  workspaces: z.array(workspaceSchema).default([]),
  storage: z.object({
    baseDir: z.string().optional(),
    dbPath: z.string().optional(),
    zvecPath: z.string().optional()
  }).default({})
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
export type RerankConfig = z.infer<typeof rerankConfigSchema>;
export type QueryExpansionConfig = z.infer<typeof queryExpansionConfigSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
