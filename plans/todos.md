# zmem Implementation Stories and Verification

This file is the execution-oriented follow-up to `plans/graph-memory-direction.md`.

Goals for this checklist:

- Break work into implementation stories.
- Define concrete verification methods for every story.
- Prefer verifiable checks through automated tests and CLI/MCP smoke flows.
- Keep enough flexibility to refactor the current test suite and smoke harness as the architecture evolves.

## Existing Verification Assets

- Unit/integration tests currently run via `npm test` using `tsx --test test/**/*.test.ts`.
- There is already a focused lexical regression suite in `test/lexical.sanitization.test.ts`.
- There is already a CLI/MCP smoke harness in `scripts/smoke.ts` with entry points:
  - `npm run smoke`
  - `npm run smoke:core`
  - `npm run smoke:mcp`

## Story 1: Add Graph Edge Schema and Persistence

### Scope

- Add edge tables and indexes in SQLite.
- Add canonical uniqueness rules for `(from_memory_id, to_memory_id, relation_type)`.
- Add support fields for confidence, origin, status, justification, and acceptance provenance.
- Keep lineage separate through `supersedes_id`.

### Verification

- Add DB-level tests that verify:
  - inserting an edge succeeds
  - inserting the same canonical edge twice does not create duplicates
  - rejected edges remain queryable in admin/debug paths
  - different relation types between the same two memories can coexist
- Add smoke coverage that seeds two memories and asserts the graph table contains exactly one canonical edge row.
- Verify with CLI/test output by running:

```bash
npm test
npm run smoke:core
```

- Expected evidence:
  - test output includes passing graph schema tests
  - smoke output includes a passing graph persistence case

## Story 2: Add Core Edge Repository and Domain Types

### Scope

- Add TypeScript types/enums for edge relations, origin, status, and acceptance provenance.
- Add repository functions for create, update, list neighbors, and moderate edge state.
- Make `memory_neighbors`-style queries possible at the core layer before MCP wiring.

### Verification

- Add core tests that verify:
  - `createEdge()` stores expected values
  - `updateEdgeStatus()` changes status and provenance correctly
  - `listNeighbors()` honors direction, filters, and default depth of `1`
- Include explicit tests for `accepted`, `suggested`, and `rejected` edge states.
- Verify with:

```bash
npm test
```

- Expected evidence:
  - passing edge repository tests with stable fixtures and deterministic assertions

## Story 3: Extend Save Flow for Explicit Links and Suggestion Policy

### Scope

- Extend `memory_save`/core save input to accept optional explicit links.
- Support per-save opt-out for LLM edge suggestion.
- Preserve current supersede behavior while adding graph write semantics.
- Keep manual edges defaulting to `accepted`.

### Verification

- Add tests that verify:
  - saving with explicit links creates accepted edges
  - saving with `suggestEdges: false` does not create suggestions
  - saving with `supersedesId` still archives the prior memory correctly
  - saving duplicate canonical links updates or reuses the canonical edge rather than duplicating it
- Add smoke coverage that saves a memory with explicit links and verifies retrieval of neighbors.
- Verify with:

```bash
npm test
npm run smoke:core
```

- Expected evidence:
  - supersede smoke case still passes
  - new save-with-links smoke case passes

## Story 4: Add LLM-Suggested Edge Creation Pipeline

### Scope

- Add an edge suggestion interface that can use semantically similar memories plus recent memories.
- Persist only the top few suggestions.
- Default all LLM-generated edges to `suggested`.
- Suppress previously rejected edges unless materially stronger evidence is available.

### Verification

- Keep the provider mockable/deterministic in tests.
- Add tests that verify:
  - candidate pool includes both recent and semantic candidates
  - only top few suggestions are persisted
  - suggested edges are stored with `origin=llm` and `status=suggested`
  - previously rejected edges are not re-suggested under unchanged evidence
- Add smoke coverage using a fake suggestion provider or deterministic test mode.
- Verify with:

```bash
npm test
npm run smoke:core
```

- Expected evidence:
  - tests clearly assert exact suggested edge ids/statuses
  - smoke logs show the story passing without relying on nondeterministic model output

## Story 5: Refactor Retrieval to Chunk-First Candidate Generation

### Scope

- Move retrieval internals so chunk hits become the first-class candidate unit.
- Preserve final output as memory items only.
- Make supporting snippet selection come from the matched chunks rather than generic memory content slicing.

### Verification

- Add retrieval tests that verify:
  - multiple chunk hits for the same memory roll up to one final memory result
  - final output includes one default supporting snippet from the best chunk
  - queries do not return raw chunk objects in the public response contract
- Add smoke coverage with seeded multi-chunk documents.
- Verify with:

```bash
npm test
npm run smoke:core
node dist/index.js query "<fixture query>" --workspace=<fixture workspace>
```

- Expected evidence:
  - one result per memory item
  - snippet text matches the most relevant chunk rather than arbitrary content prefix

## Story 6: Add Memory Rollup and Item-Level Evidence Scoring

### Scope

- Group chunk hits by `memory_id`.
- Compute item-level evidence using best-hit score, multi-chunk support, and chunk diversity.
- Keep rollup internals inspectable for future debugging.

### Verification

- Add deterministic tests where:
  - one memory has one great chunk
  - another memory has several moderate chunks
  - ranking behaves according to the chosen v1 rollup policy
- Add regression fixtures that ensure rollup remains stable during refactors.
- Verify with:

```bash
npm test
```

- Expected evidence:
  - exact ranking order is asserted in tests for controlled fixtures

## Story 7: Add Graph Expansion and Neighbor Injection Rules

### Scope

- Add graph boosting for seed memories.
- Add controlled graph candidate injection from accepted/manual edges only.
- Restrict default graph traversal to depth `1`.
- Keep suggested-edge injection as a later TODO.

### Verification

- Add tests that verify:
  - accepted/manual neighbors can be introduced for relational/history-oriented retrieval flows
  - suggested-only neighbors do not get injected in v1
  - rejected neighbors never get injected
  - graph expansion depth defaults to `1`
- Add CLI or smoke fixtures for queries like:
  - "what changed"
  - "why did we choose this"
  - "related context"
- Verify with:

```bash
npm test
npm run smoke:core
```

- Expected evidence:
  - relational smoke queries surface accepted linked memories
  - suggested-only links do not dominate results

## Story 8: Add Query Expansion Interface and Deterministic Test Mode

### Scope

- Add a query-expander interface for bounded lexical and semantic variants.
- Keep the expansion count small and testable.
- Make test mode deterministic so regressions can be validated offline.

### Verification

- Add tests that verify:
  - expansion outputs remain bounded
  - expansions are labeled or traceable by strategy
  - disabling expansion returns the original behavior
- Add smoke coverage with debug flags or internal assertions in a deterministic mode.
- Verify with:

```bash
npm test
npm run smoke:core
```

- Expected evidence:
  - fixed expansion outputs for known fixtures in tests

## Story 9: Add Memory-Item Reranking

### Scope

- Add a reranker interface that operates on memory-item candidates after rollup.
- Blend chunk evidence, metadata, recency, importance, lineage, and graph signals.
- Produce heuristic explanation strings from scores/signals in v1.
- TODO later: optional LLM-generated explanations.

### Verification

- Add tests that verify:
  - reranking changes order in expected controlled scenarios
  - suggested edges have lower impact than accepted/manual edges
  - lineage signals can surface useful history-aware results
  - explanation text reflects actual applied signals
- Add smoke coverage for graph-heavy and history-heavy fixtures.
- Verify with:

```bash
npm test
npm run smoke:core
```

- Expected evidence:
  - tests assert both result ordering and explanation substrings

## Story 10: Add New Search Modes

### Scope

- Add or refactor support for:
  - `recent`
  - `important`
  - `typed`
- `recent` should be pure recency.
- `important` should support queryless and query-constrained use.
- `typed` should support multiple types and optional query.

### Verification

- Add tests that verify:
  - `recent` ignores lexical/vector behavior and sorts by recency
  - `important` ranks by importance with light centrality/recency support
  - `typed` supports multiple types and proper default sorting
- Extend CLI smoke coverage with explicit mode checks.
- Verify with:

```bash
npm test
npm run smoke:core
node dist/index.js query "" --mode=recent --workspace=<fixture workspace>
```

- Expected evidence:
  - controlled fixture order matches the mode semantics

## Story 11: Add MCP Graph and Rich Search Surface

### Scope

- Keep existing MCP tools stable.
- Add:
  - `memory_search`
  - `memory_link`
  - `memory_neighbors`
  - `memory_edge_update`
- Keep `memory_search` clean by default.
- Support optional includes for matches, edges, explanations, and debug data.

### Verification

- Extend `scripts/smoke.ts` MCP coverage to verify:
  - tools are registered
  - `memory_search` returns memory items only by default
  - optional include flags expose extra evidence fields
  - `memory_link` creates accepted edges
  - `memory_edge_update` can promote suggested edges
  - `memory_neighbors` honors default depth and explicit depth
- Verify with:

```bash
npm run smoke:mcp
```

- Expected evidence:
  - smoke output contains passing MCP graph/search scenarios
  - structured MCP outputs match expected fields exactly

## Story 12: Add CLI Regression Scenarios for Search Behavior

### Scope

- Expand smoke and/or CLI fixtures so the built CLI can be exercised with known workspaces and known outputs.
- Prefer deterministic inputs stored in fixture docs or test DB setup helpers.

### Verification

- Add fixture-driven CLI checks for:
  - query returns expected memory title
  - recent mode returns expected newest item first
  - typed mode only returns allowed types
  - graph-aware query surfaces linked context
- Verify with:

```bash
npm run build
node dist/index.js query "database migration" --workspace=<fixture workspace>
node dist/index.js query "" --mode=recent --workspace=<fixture workspace>
```

- Expected evidence:
  - CLI stdout contains exact expected titles/order for fixture workspaces

## Story 13: Add Evaluation Fixtures and Regression Benchmarks

### Scope

- Create a stable set of fixture memories covering:
  - document-heavy queries
  - memory-heavy queries
  - relational/history queries
  - supersession/history cases
  - preference/context cases
- Add reusable helpers so tests can be refactored without losing coverage.

### Verification

- Add benchmark-style assertions where appropriate, but prefer deterministic correctness over brittle timing.
- Keep a small number of latency smoke guards where they already exist.
- Verify with:

```bash
npm test
npm run smoke
```

- Expected evidence:
  - all fixtures are exercised by at least one unit/integration test and one smoke path where appropriate

## Story 14: Add Gemini Embedding 2 Provider Last

### Scope

- Add Gemini as a real embedding provider behind the provider abstraction.
- Keep provider selection/config explicit.
- Reindex only after the graph-aware retrieval stack is stable.

### Verification

- Add provider unit tests for config validation and shape handling.
- Add a deterministic mock provider path so core search tests do not depend on live APIs.
- Add opt-in integration tests only if credentials are available.
- Verify with:

```bash
npm test
npm run smoke:core
```

- Expected evidence:
  - provider tests pass offline
  - reindex still passes after provider switch in controlled environments

## Regression Strategy

- Continue using `npm test` for deterministic regression checks.
- Continue using `npm run smoke:core` and `npm run smoke:mcp` for end-to-end behavior checks.
- It is acceptable to refactor the current test layout so long as:
  - lexical regressions remain covered
  - smoke cases remain runnable from package scripts
  - fixture-based expected outputs remain easy to inspect and update deliberately

## Recommended Test Refactors

- Split current tests into clearer suites such as:
  - `test/db/*.test.ts`
  - `test/core/*.test.ts`
  - `test/search/*.test.ts`
  - `test/mcp/*.test.ts`
- Extract reusable fixture builders for memories, chunks, and edges.
- Add deterministic fake providers for:
  - embedding
  - query expansion
  - edge suggestion
  - reranking
- Keep `scripts/smoke.ts` as the end-to-end harness, but break its scenarios into reusable helpers if it grows further.

## Minimum Regression Command Set

These are the commands we should be able to run repeatedly during implementation:

```bash
npm test
npm run smoke:core
npm run smoke:mcp
npm run build
```

Optional full pass:

```bash
npm run smoke
```

## Definition of Done for Major Refactors

A refactor is not complete unless:

- all relevant unit/integration tests pass
- smoke core passes
- smoke MCP passes for touched MCP behavior
- CLI behavior remains verifiable with fixture-backed commands
- new graph/search behavior is covered by at least one deterministic test and one higher-level smoke or CLI scenario
