export interface QueryInput {
  query: string;
  workspace?: string;
  scopes?: Array<"workspace" | "global" | "user">;
  includeSuperseded?: boolean;
}

export interface QueryHit {
  id: string;
  title: string;
  score: number;
  source: "lex" | "vec" | "hybrid";
  snippet: string;
}

export async function queryMemories(_input: QueryInput): Promise<QueryHit[]> {
  return [];
}
