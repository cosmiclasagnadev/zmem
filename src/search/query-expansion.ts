export const QueryExpansionStrategyValues = ["original", "lexical", "semantic", "hyde"] as const;

export type QueryExpansionStrategy = (typeof QueryExpansionStrategyValues)[number];
export type QueryExpansionMode = "off" | "deterministic" | "llm";
export type QueryExpansionTarget = "both" | "lex" | "vec";

export interface QueryExpansionVariant {
  query: string;
  strategy: QueryExpansionStrategy;
  label: string;
  weight: number;
  target: QueryExpansionTarget;
}

export interface QueryExpansionPlan {
  mode: QueryExpansionMode;
  originalQuery: string;
  variants: QueryExpansionVariant[];
}

export interface QueryExpansionRequest {
  query: string;
  mode: QueryExpansionMode;
  maxExpansions: number;
  includeLexical: boolean;
  workspace?: string;
}

export interface QueryExpander {
  expand(request: QueryExpansionRequest): Promise<QueryExpansionPlan>;
}

export interface DeterministicQueryExpanderOptions {
  maxLexicalVariants?: number;
  maxSemanticVariants?: number;
  maxHydeVariants?: number;
  maxTotalVariants?: number;
}

const DEFAULT_MAX_LEXICAL_VARIANTS = 1;
const DEFAULT_MAX_SEMANTIC_VARIANTS = 1;
const DEFAULT_MAX_HYDE_VARIANTS = 1;
const DEFAULT_MAX_TOTAL_VARIANTS = 4;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "did",
  "for",
  "how",
  "is",
  "of",
  "the",
  "this",
  "to",
  "was",
  "what",
  "why",
  "with",
]);

const SEMANTIC_RULES: Array<{ test: RegExp; variants: Array<{ text: string; strategy: QueryExpansionStrategy; label: string; target: QueryExpansionTarget; weight: number }> }> = [
  {
    test: /what changed/,
    variants: [
      { text: "change summary", strategy: "semantic", label: "semantic:change-summary", target: "vec", weight: 0.92 },
      { text: "previous baseline", strategy: "semantic", label: "semantic:previous-baseline", target: "vec", weight: 0.9 },
    ],
  },
  {
    test: /why did we (choose|decide)/,
    variants: [
      { text: "decision rationale", strategy: "semantic", label: "semantic:decision-rationale", target: "vec", weight: 0.92 },
      { text: "tradeoff analysis", strategy: "semantic", label: "semantic:tradeoff-analysis", target: "vec", weight: 0.9 },
    ],
  },
  {
    test: /related context/,
    variants: [
      { text: "connected context", strategy: "semantic", label: "semantic:connected-context", target: "vec", weight: 0.92 },
      { text: "related note", strategy: "semantic", label: "semantic:related-note", target: "vec", weight: 0.9 },
    ],
  },
];

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function tokenizeQuery(query: string): string[] {
  return normalizeWhitespace(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function dedupeVariants(variants: QueryExpansionVariant[], maxTotalVariants: number): QueryExpansionVariant[] {
  const seen = new Set<string>();
  const deduped: QueryExpansionVariant[] = [];

  for (const variant of variants) {
    const normalized = normalizeWhitespace(variant.query).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push({ ...variant, query: normalizeWhitespace(variant.query) });
    if (deduped.length >= maxTotalVariants) {
      break;
    }
  }

  return deduped;
}

function buildOriginalVariant(query: string): QueryExpansionVariant {
  return {
    query,
    strategy: "original",
    label: "original:raw",
    weight: 1,
    target: "both",
  };
}

function buildLexicalVariants(query: string, maxVariants: number): QueryExpansionVariant[] {
  const tokens = tokenizeQuery(query);
  const compact = tokens.filter((token) => !STOP_WORDS.has(token));
  const variants: QueryExpansionVariant[] = [];

  if (compact.length > 0) {
    variants.push({
      query: compact.join(" "),
      strategy: "lexical",
      label: "lexical:compact-keywords",
      weight: 0.96,
      target: "lex",
    });
  }

  return variants.slice(0, maxVariants);
}

function buildSemanticVariants(query: string, maxVariants: number): QueryExpansionVariant[] {
  const normalized = normalizeWhitespace(query).toLowerCase();
  const variants: QueryExpansionVariant[] = [];

  for (const rule of SEMANTIC_RULES) {
    if (!rule.test.test(normalized)) {
      continue;
    }

    for (const variant of rule.variants) {
      variants.push({
        query: variant.text,
        strategy: variant.strategy,
        label: variant.label,
        weight: variant.weight,
        target: variant.target,
      });
      if (variants.length >= maxVariants) {
        return variants;
      }
    }
  }

  return variants;
}

function buildHydeVariants(query: string, maxVariants: number): QueryExpansionVariant[] {
  if (maxVariants <= 0) {
    return [];
  }

  return [{
    query: `information about ${normalizeWhitespace(query)}`,
    strategy: "hyde" as const,
    label: "hyde:information-about-query",
    weight: 0.88,
    target: "vec" as const,
  }].slice(0, maxVariants);
}

export function createOffExpansionPlan(query: string): QueryExpansionPlan {
  const originalQuery = normalizeWhitespace(query);
  return {
    mode: "off",
    originalQuery,
    variants: [buildOriginalVariant(originalQuery)],
  };
}

export function createDeterministicQueryExpander(options: DeterministicQueryExpanderOptions = {}): QueryExpander {
  const maxLexicalVariants = options.maxLexicalVariants ?? DEFAULT_MAX_LEXICAL_VARIANTS;
  const maxSemanticVariants = options.maxSemanticVariants ?? DEFAULT_MAX_SEMANTIC_VARIANTS;
  const maxHydeVariants = options.maxHydeVariants ?? DEFAULT_MAX_HYDE_VARIANTS;
  const defaultMaxTotalVariants = options.maxTotalVariants ?? DEFAULT_MAX_TOTAL_VARIANTS;

  return {
    async expand(request: QueryExpansionRequest): Promise<QueryExpansionPlan> {
      const originalQuery = normalizeWhitespace(request.query);

      if (request.mode === "off") {
        return createOffExpansionPlan(originalQuery);
      }

      const maxTotalVariants = Math.max(1, Math.min(request.maxExpansions + 1, defaultMaxTotalVariants));
      const variants = dedupeVariants(
        [
          buildOriginalVariant(originalQuery),
          ...(request.includeLexical ? buildLexicalVariants(originalQuery, maxLexicalVariants) : []),
          ...buildSemanticVariants(originalQuery, maxSemanticVariants),
          ...buildHydeVariants(originalQuery, maxHydeVariants),
        ],
        maxTotalVariants
      );

      return {
        mode: "deterministic",
        originalQuery,
        variants,
      };
    },
  };
}

export function createCachedQueryExpander(expander: QueryExpander, maxEntries = 128): QueryExpander {
  const cache = new Map<string, QueryExpansionPlan>();

  return {
    async expand(request: QueryExpansionRequest): Promise<QueryExpansionPlan> {
      const key = JSON.stringify({
        query: normalizeWhitespace(request.query).toLowerCase(),
        mode: request.mode,
        maxExpansions: request.maxExpansions,
        includeLexical: request.includeLexical,
        workspace: request.workspace ?? "",
      });

      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }

      const plan = await expander.expand(request);
      cache.set(key, plan);
      if (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest) {
          cache.delete(oldest);
        }
      }
      return plan;
    },
  };
}

export async function expandQuery(
  query: string,
  mode: QueryExpansionMode,
  expander?: QueryExpander,
  options?: DeterministicQueryExpanderOptions & { maxExpansions?: number; includeLexical?: boolean; workspace?: string }
): Promise<QueryExpansionPlan> {
  const originalQuery = normalizeWhitespace(query);
  const deterministicExpander = createDeterministicQueryExpander(options);
  const effectiveExpander = mode === "llm" ? (expander ?? deterministicExpander) : deterministicExpander;
  return effectiveExpander.expand({
    query: originalQuery,
    mode,
    maxExpansions: options?.maxExpansions ?? DEFAULT_MAX_TOTAL_VARIANTS - 1,
    includeLexical: options?.includeLexical ?? true,
    workspace: options?.workspace,
  });
}
