import { z } from "zod";

const retrievalDefaultsSchema = z.object({
  topKLex: z.number().int().positive().default(30),
  topKVec: z.number().int().positive().default(30),
  rerankTopK: z.number().int().positive().default(20),
  minScore: z.number().min(0).max(1).default(0.25),
  includeSuperseded: z.boolean().default(false)
});

const workspaceSchema = z.object({
  name: z.string().min(1),
  root: z.string().min(1),
  includeByDefault: z.boolean().default(true),
  patterns: z.array(z.string()).min(1),
  context: z.string().optional()
});

const embeddingConfigSchema = z.object({
  provider: z.enum(["llamacpp", "openai", "ollama"]).default("llamacpp"),
  model: z.string().default("hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"),
  dimensions: z.number().int().positive().default(1024),
  quantization: z.enum(["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "F16"]).default("Q8_0"),
  batchSize: z.number().int().positive().default(8),
  maxTokens: z.number().int().positive().default(8192),
  baseUrl: z.string().optional(), // For ollama/openai providers
  apiKey: z.string().optional() // For openai provider
});

const rerankConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["llamacpp", "openai", "ollama"]).optional(),
  model: z.string().optional(),
  topK: z.number().int().positive().default(20)
});

export const appConfigSchema = z.object({
  defaults: z.object({
    retrievalMode: z.enum(["hybrid", "lexical", "vector"]).default("hybrid"),
    scopesDefault: z.array(z.enum(["workspace", "global", "user"])).default(["workspace", "global"]),
    retrieval: retrievalDefaultsSchema
  }),
  ai: z.object({
    embedding: embeddingConfigSchema,
    rerank: rerankConfigSchema
  }).default({
    embedding: {},
    rerank: {}
  }),
  workspaces: z.array(workspaceSchema).default([]),
  storage: z.object({
    dbPath: z.string().default("./data/memory.db"),
    zvecPath: z.string().default("./data/vectors")
  }).default({})
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
export type RerankConfig = z.infer<typeof rerankConfigSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
