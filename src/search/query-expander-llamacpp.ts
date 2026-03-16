import type { QueryExpansionConfig } from "../config/schema.js";
import { getQueryExpansionModelResolutions } from "../llm/local-models.js";
import { warn } from "../utils/logger.js";
import type { QueryExpander, QueryExpansionPlan, QueryExpansionRequest, QueryExpansionVariant } from "./query-expansion.js";
import { createDeterministicQueryExpander, normalizeWhitespace } from "./query-expansion.js";

type NodeLlamaCppModule = typeof import("node-llama-cpp");

const EXPANSION_JSON_SCHEMA = {
  type: "object",
  properties: {
    queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["lex", "vec", "hyde"] },
          text: { type: "string" },
        },
        required: ["type", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["queries"],
  additionalProperties: false,
} as const;

interface RawExpansionOutput {
  queries: Array<{ type: "lex" | "vec" | "hyde"; text: string }>;
}

export class LlamaCppQueryExpander implements QueryExpander {
  private readonly deterministicFallback: QueryExpander;
  private readonly warnedMessages = new Set<string>();
  private readonly config: QueryExpansionConfig;
  private readonly appConfig: import("../config/schema.js").AppConfig;
  private llamaModulePromise: Promise<NodeLlamaCppModule> | null = null;
  private llamaPromise: Promise<unknown> | null = null;
  private modelPromise: Promise<unknown> | null = null;

  constructor(appConfig: import("../config/schema.js").AppConfig) {
    this.appConfig = appConfig;
    this.config = appConfig.ai.queryExpansion;
    this.deterministicFallback = createDeterministicQueryExpander({
      maxTotalVariants: Math.max(2, this.config.maxExpansions + 1),
    });
  }

  async expand(request: QueryExpansionRequest): Promise<QueryExpansionPlan> {
    if (request.mode === "off") {
      return this.deterministicFallback.expand({ ...request, mode: "off" });
    }

    try {
      const module = await this.getModule();
      const llama = await this.getLlama(module);
      const model = await this.getModel(module, llama);
      const context = await (model as { createContext(args: { contextSize: number }): Promise<{ getSequence(): unknown; dispose(): Promise<void> }> }).createContext({
        contextSize: this.config.contextSize,
      });

      try {
        const session = new (module as NodeLlamaCppModule).LlamaChatSession({
          contextSequence: context.getSequence(),
        } as any);
        const grammar = await (llama as { createGrammarForJsonSchema(schema: object): Promise<unknown> }).createGrammarForJsonSchema(EXPANSION_JSON_SCHEMA);
        const prompt = buildExpansionPrompt(request.query, request.maxExpansions, request.includeLexical);
        const result = await session.prompt(prompt, {
          grammar: grammar as any,
          maxTokens: Math.min(this.config.contextSize, 256),
          temperature: this.config.temperature,
          topK: this.config.topK,
          topP: this.config.topP,
        });
        return mapExpansionResult(result, request);
      } finally {
        await context.dispose();
      }
    } catch (error) {
      this.warnOnce(`query-expansion:${error instanceof Error ? error.message : String(error)}`, () =>
        `Local query expansion unavailable, falling back to deterministic variants: ${error instanceof Error ? error.message : String(error)}`
      );
      return this.deterministicFallback.expand({ ...request, mode: "deterministic" });
    }
  }

  private async getModule(): Promise<NodeLlamaCppModule> {
    if (!this.llamaModulePromise) {
      this.llamaModulePromise = import("node-llama-cpp");
    }
    return this.llamaModulePromise;
  }

  private async getLlama(module: NodeLlamaCppModule): Promise<unknown> {
    if (!this.llamaPromise) {
      this.llamaPromise = module.getLlama();
    }
    return this.llamaPromise;
  }

  private async getModel(module: NodeLlamaCppModule, llama: unknown): Promise<unknown> {
    if (!this.modelPromise) {
      this.modelPromise = this.resolveAndLoadModel(module, llama);
    }
    return this.modelPromise;
  }

  private async resolveAndLoadModel(module: NodeLlamaCppModule, llama: unknown): Promise<unknown> {
    const resolutions = getQueryExpansionModelResolutions(this.appConfig);
    const attempt = async (modelUri: string): Promise<unknown> => {
      const modelPath = await (module.resolveModelFile as any)(modelUri, resolutions.primary.modelsDir, { cli: false });
      return (llama as { loadModel(args: { modelPath: string }): Promise<unknown> }).loadModel({ modelPath });
    };

    try {
      return await attempt(resolutions.primary.modelUri);
    } catch (primaryError) {
      this.warnOnce(`query-expansion-primary:${resolutions.primary.modelUri}`, () =>
        `Failed to load primary query-expansion model (${resolutions.primary.modelUri}), trying fallback model.`
      );
      try {
        return await attempt(resolutions.fallback.modelUri);
      } catch (fallbackError) {
        throw new Error(
          `Primary and fallback query-expansion models failed to load. Primary: ${stringifyError(primaryError)}. Fallback: ${stringifyError(fallbackError)}`
        );
      }
    }
  }

  private warnOnce(key: string, message: () => string): void {
    if (this.warnedMessages.has(key)) {
      return;
    }
    this.warnedMessages.add(key);
    warn(message);
  }
}

function buildExpansionPrompt(query: string, maxExpansions: number, includeLexical: boolean): string {
  const lexicalInstruction = includeLexical
    ? "Include at most one lex query for exact keywords."
    : "Do not include lex queries.";
  return [
    "Return compact search-query expansions as JSON.",
    lexicalInstruction,
    "Always prefer concise retrieval-oriented phrases.",
    "Use vec for semantic rewrites and hyde for hypothetical answer-style retrieval hints.",
    `Return at most ${maxExpansions} expanded queries total and do not repeat the original query verbatim.`,
    `Original query: ${normalizeWhitespace(query)}`,
  ].join("\n");
}

function mapExpansionResult(result: string, request: QueryExpansionRequest): QueryExpansionPlan {
  const parsed = JSON.parse(result) as RawExpansionOutput;
  const normalizedOriginal = normalizeWhitespace(request.query);
  const variants: QueryExpansionVariant[] = [{
    query: normalizedOriginal,
    strategy: "original",
    label: "original:raw",
    weight: 1,
    target: "both",
  }];

  for (const item of parsed.queries ?? []) {
    const text = normalizeWhitespace(item.text);
    if (!text || text.toLowerCase() === normalizedOriginal.toLowerCase()) {
      continue;
    }

    if (item.type === "lex" && !request.includeLexical) {
      continue;
    }

    variants.push({
      query: text,
      strategy: item.type === "lex" ? "lexical" : item.type === "vec" ? "semantic" : "hyde",
      label: `${item.type}:llama`,
      weight: item.type === "lex" ? 0.96 : item.type === "vec" ? 0.92 : 0.88,
      target: item.type === "lex" ? "lex" : "vec",
    });

    if (variants.length >= request.maxExpansions + 1) {
      break;
    }
  }

  const deduped = new Map<string, QueryExpansionVariant>();
  for (const variant of variants) {
    const key = variant.query.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, variant);
    }
  }

  return {
    mode: "llm",
    originalQuery: normalizedOriginal,
    variants: [...deduped.values()].slice(0, request.maxExpansions + 1),
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
