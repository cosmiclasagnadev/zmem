export const QueryExpansionStrategyValues = ["original", "lexical", "semantic"] as const;

export type QueryExpansionStrategy = (typeof QueryExpansionStrategyValues)[number];

export type QueryExpansionMode = "off" | "deterministic";

export interface QueryExpansionVariant {
  query: string;
  strategy: QueryExpansionStrategy;
  label: string;
  weight: number;
}

export interface QueryExpansionPlan {
  mode: QueryExpansionMode;
  originalQuery: string;
  variants: QueryExpansionVariant[];
}

export interface QueryExpander {
  expand(query: string): Promise<QueryExpansionPlan>;
}

export interface DeterministicQueryExpanderOptions {
  maxLexicalVariants?: number;
  maxSemanticVariants?: number;
  maxTotalVariants?: number;
}

const DEFAULT_MAX_LEXICAL_VARIANTS = 1;
const DEFAULT_MAX_SEMANTIC_VARIANTS = 2;
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

const SEMANTIC_RULES: Array<{ test: RegExp; variants: string[] }> = [
  {
    test: /what changed/,
    variants: ["change summary", "previous baseline"],
  },
  {
    test: /why did we (choose|decide)/,
    variants: ["decision rationale", "tradeoff analysis"],
  },
  {
    test: /related context/,
    variants: ["connected context", "related note"],
  },
];

function normalizeWhitespace(value: string): string {
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
        query: variant,
        strategy: "semantic",
        label: `semantic:${variant.replace(/\s+/g, "-")}`,
        weight: 0.92,
      });
      if (variants.length >= maxVariants) {
        return variants;
      }
    }
  }

  return variants;
}

export function createDeterministicQueryExpander(options: DeterministicQueryExpanderOptions = {}): QueryExpander {
  const maxLexicalVariants = options.maxLexicalVariants ?? DEFAULT_MAX_LEXICAL_VARIANTS;
  const maxSemanticVariants = options.maxSemanticVariants ?? DEFAULT_MAX_SEMANTIC_VARIANTS;
  const maxTotalVariants = options.maxTotalVariants ?? DEFAULT_MAX_TOTAL_VARIANTS;

  return {
    async expand(query: string): Promise<QueryExpansionPlan> {
      const originalQuery = normalizeWhitespace(query);
      const variants = dedupeVariants(
        [
          {
            query: originalQuery,
            strategy: "original",
            label: "original:raw",
            weight: 1,
          },
          ...buildLexicalVariants(originalQuery, maxLexicalVariants),
          ...buildSemanticVariants(originalQuery, maxSemanticVariants),
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

export async function expandQuery(
  query: string,
  mode: QueryExpansionMode = "off",
  options?: DeterministicQueryExpanderOptions
): Promise<QueryExpansionPlan> {
  const originalQuery = normalizeWhitespace(query);
  if (mode === "off") {
    return {
      mode,
      originalQuery,
      variants: [
        {
          query: originalQuery,
          strategy: "original",
          label: "original:raw",
          weight: 1,
        },
      ],
    };
  }

  return createDeterministicQueryExpander(options).expand(originalQuery);
}
