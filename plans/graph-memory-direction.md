# zmem Graph Memory Direction

## Goals

- Keep zmem fast to iterate on by staying with the current storage stack for now.
- Build a graph-aware memory system now instead of deferring graph work.
- Optimize for chunk-first retrieval while keeping memory items as the only primary result type.
- Improve agent usability through a richer MCP interface with clean default responses.
- Support general-purpose workflows, not just software or product teams.
- Move Gemini Embedding 2 support to the end of the implementation sequence.

## Current Non-Goals

- No Stoolap migration for now.
- No Rust rewrite for now.
- No heavy multi-hop graph traversal in v1.
- No debug-heavy MCP responses by default.
- No automatic promotion of LLM-suggested edges to accepted in v1.

## System Direction

### Storage

- Keep `SQLite` for metadata, memory items, chunks, and graph edges.
- Keep `zvec` for vector storage and vector search until the rest of the retrieval pipeline is stable.
- Use XDG-style default storage outside repos.
- Resolve storage per workspace by default under a user-scoped base directory.
- Default derived paths should be:
  - macOS/Linux: `~/.local/share/zmem/workspaces/<workspace-slug>/memory.db`
  - macOS/Linux: `~/.local/share/zmem/workspaces/<workspace-slug>/vectors/`
  - Windows: `%APPDATA%/zmem/workspaces/<workspace-slug>/memory.db`
  - Windows: `%APPDATA%/zmem/workspaces/<workspace-slug>/vectors/`
- Resolution order should be:
  1. explicit env override
  2. explicit config override
  3. XDG-style workspace-derived default

### Graph Model

- Preserve `supersedes_id` as the version-lineage mechanism.
- Add an explicit edge table for general memory relationships.
- Use a cross-domain edge set in v1:
  - `related_to`
  - `supports`
  - `contradicts`
  - `caused_by`
  - `derived_from`
  - `preferred_with`
- Treat lineage and graph edges as separate concepts.
- Store one canonical edge per `(from_memory_id, to_memory_id, relation_type)`.
- Store one direction only and derive inverse reasoning in code.

### Edge Shape

- Edge records should carry:
  - `id`
  - `fromMemoryId`
  - `toMemoryId`
  - `relationType`
  - `confidence` in `0..1`
  - `origin` (`manual | llm`)
  - `status` (`suggested | accepted | rejected`)
  - `justification` as short free text
  - `acceptedBy` (`user | agent | system | null`)
  - `createdAt`
  - `updatedAt`

### Edge Creation and Moderation

- Support manual edge creation.
- Support LLM-suggested edge creation from day 1.
- Manual edges default to `accepted`, but can optionally be created as `suggested`.
- LLM-suggested edges always start as `suggested`.
- Rejected edges remain stored as `rejected`.
- Previously rejected edges should be suppressed unless materially stronger evidence appears.
- Persist only the top few LLM-suggested edges per save.
- Suggested edges can lightly influence retrieval and ranking above threshold.
- Accepted/manual edges receive stronger graph weight.
- Promotion from `suggested` to `accepted` must happen through an explicit tool call.
- Both users and agents may promote suggested edges.
- Record acceptance provenance via `acceptedBy`.
- When appending to the knowledge base, bias toward preserving links to relevant prior memories.

## Retrieval Direction

### Core Retrieval Model

- Use chunk-first retrieval internally.
- Return memory items only in final results.
- Always attach supporting snippet evidence to final results.
- Return one supporting snippet by default.

### Retrieval Modes

- `hybrid`
- `recent`
- `important`
- `typed`

Mode notes:

- `recent` is pure recency with optional filters and does not require a query.
- `important` supports both queryless and query-constrained usage.
- `typed` supports multiple types from day 1 and may also take a query.
- `typed` defaults to important-style ordering when no query is present.

### Retrieval Pipeline

1. Query expansion
   - Use an LLM-based expander from day 1.
   - Generate a small, bounded set of lexical and semantic variants.
2. Chunk retrieval
   - Retrieve lexical chunk candidates.
   - Retrieve vector chunk candidates.
3. Fusion
   - Fuse chunk candidates with RRF or an equivalent strategy.
4. Memory rollup
   - Group chunk hits by `memory_id`.
   - Compute item-level evidence from best chunk and multi-chunk support.
5. Graph expansion
   - Default behavior: graph boosts seed memories found by chunk retrieval.
   - Flexible behavior: graph may inject a small number of new candidates when query intent is relational or history-oriented.
   - In v1, graph-introduced candidates must come from accepted/manual edges only.
   - Keep expansion shallow in v1, ideally 1 hop.
6. Memory reranking
   - Rerank memory items rather than chunks.
   - Blend chunk evidence, metadata, lineage, and graph signals.
   - Optimize for the best contextual memory set, not just the narrowest exact match.
7. Result shaping
   - Return memory items only.
   - Include strongest supporting snippet evidence.

### Ranking Features

- Best chunk relevance
- Multi-chunk support
- Title, summary, and tag match
- Type and scope fit
- Recency
- Importance
- Lineage signals
- Graph proximity and edge-type boosts

Ranking notes:

- `important` mode should blend importance with light graph centrality and light recency.
- Suggested edges get lower graph weight than accepted/manual edges.
- Lineage should always influence ranking and history-aware retrieval.

## Save-Time Edge Suggestion

- Run save-time LLM edge suggestion on every save by default.
- Allow advanced callers to opt out.
- Candidate pool should include both:
  - semantically similar memories
  - recent active memories
- Persist only the top few suggestions.

## MCP and Agent Interface Direction

### Principles

- Keep the current MCP transport and server structure.
- Avoid a full MCP rewrite.
- Expose a richer retrieval contract for agents.
- Keep responses clean by default and make evidence/debug fields optional.

### Compatibility Strategy

- Keep existing tools for compatibility:
  - `memory_get`
  - `memory_list`
  - `memory_save`
  - `memory_delete`
  - `memory_status`
  - existing `memory_query`
- Add richer successor tools instead of breaking `memory_query` immediately.

### Recommended MCP Surface

- `memory_search`
  - new primary agent-facing retrieval tool
  - returns memory items only
  - includes snippet evidence
  - can optionally include matches, edges, explanations, and debug details
- `memory_get`
  - later support optional inclusion of chunks and edges
- `memory_link`
  - create or update explicit graph edges
- `memory_neighbors`
  - inspect graph neighborhood around memory items
  - support `depth` with default `1`
- `memory_edge_update`
  - promote or reject edges explicitly
  - used for `suggested -> accepted` transitions

### Default MCP Behavior

- Clean memory-item results by default
- Optional evidence/debug fields only when requested
- Heuristic explanations from scores/signals in v1
- TODO: optionally support LLM-generated explanations later

## Implementation Order

1. Graph schema
2. Save/update flow with lineage and edge support
3. LLM-suggested edge creation in save and ingest paths
4. Chunk-first retrieval internals
5. Memory rollup
6. Graph expansion
7. Query expansion
8. Memory-item reranking
9. MCP/API upgrade (`memory_search`, `memory_link`, `memory_neighbors`, `memory_edge_update`)
10. Gemini Embedding 2 provider support and reindex

## Gemini Embedding 2

- Implement Gemini support last.
- Add it as a real embedding provider through the existing provider abstraction.
- Reindex vectors only after the graph-aware retrieval pipeline and MCP contract are stable.

## Immediate Planning Themes

- Edge schema and write semantics
- `memory_search` request/response shape
- Query-expansion and reranker interfaces
- Retrieval observability and evaluation criteria
- Migration path from `memory_query` to `memory_search`
- Regression runs with verifiable CLI and test outputs

## Explicit TODOs

- TODO: later allow configurable top-N snippets in search results.
- TODO: later consider allowing high-confidence suggested edges to inject graph candidates.
- TODO: later consider LLM-generated result explanations.
