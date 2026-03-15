# zmem

Local-first hybrid memory for engineering workflows.

`zmem` is a small POC/experiment inspired by QMD-style document search, built to explore whether we can get strong practical recall by combining:

- dense retrieval via `@zvec/zvec`
- lexical retrieval via SQLite FTS5/BM25
- a simple fusion pipeline (RRF)
- a local MCP server for coding-agent integration
- graph data for relationships between memories (wip)

overall it is a local-first, agent-oriented memory substrate for engineering decisions and evolving project context

## Quickstart

Get `zmem` running locally in a few minutes.

### 1. Install

```bash
npm install -g @cosmiclasagnadev/zmem
zmem help
```

Or from this repo:

```bash
npm install
npm run build
npm install -g .
```

### 2. Initialize a workspace

Create or update a starter config for the workspace you want to index:

```bash
zmem init --workspace=default --root=/absolute/path/to/your/project --yes
```

This creates a config and sets up zmem to use user-scoped storage by default.

### 3. Check setup

Validate config, storage, and local model settings:

```bash
zmem doctor --workspace=default
zmem models status
```

### 4. Prepare local query-expansion models

zmem uses local-first query expansion by default.

See the exact model pull commands:

```bash
zmem models pull
```

This will print commands for the default local models:

- primary: `hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_M`
- fallback: `hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_S`

Run the printed `node-llama-cpp pull` commands, or let zmem download on first query.

### 5. Ingest your docs

```bash
zmem ingest /absolute/path/to/your/project --workspace=default
```

### 6. Query your memory

```bash
zmem query "database migration" --workspace=default
zmem query "" --mode=recent --workspace=default
zmem query "" --mode=typed --types=decision,preference --workspace=default
```

### 7. Use with MCP / OpenCode

Start the MCP server:

```bash
zmem mcp --workspace=default
```

Then point your MCP client, such as OpenCode, at the `zmem` command.

### First-run notes

- Default storage is outside your repo:
  - macOS/Linux: `~/.local/share/zmem/workspaces/<workspace-slug>/`
  - Windows: `%APPDATA%/zmem/workspaces/<workspace-slug>/`
- Query expansion is enabled by default for hybrid retrieval.
- If the local query-expansion model is unavailable, zmem warns once and falls back to deterministic expansion.
- You can inspect the fully resolved config with:

```bash
zmem config show --workspace=default
```

References:
- [QMD](https://github.com/tobi/qmd)
- [ZVec](https://github.com/alibaba/zvec)

## What this does differently
- explicit memory types and lifecycle (pending, active, archived, deleted) plus supersedes_id
  - if no explicit type is defined, it defaults to 'fact'
  - if no explicit tags are defined, it defaults to '[]' 
- bounded query expansion is available through deterministic variants today, with room for LLM-backed expansion later
- uses `@zvec/zvec` for dense retrieval when doing vector search

## Architecture (high level)

- **Language/runtime:** TypeScript + Node.js
- **Vectors:** `@zvec/zvec`
- **Lexical:** `better-sqlite3` + FTS5/BM25
- **Embeddings:** `node-llama-cpp` by default, with explicit provider hooks for Gemini and offline mock testing
- **Validation:** `zod`
- **Agent integration:** `@modelcontextprotocol/sdk`

Hybrid retrieval flow (follows qmd's style closely):

1. lexical search (FTS/BM25)
2. vector search (zvec)
3. reciprocal rank fusion (RRF)
4. bounded query expansion
5. heuristic memory-item reranking

### Indexing pipeline

```mermaid
flowchart LR
    A[Markdown/Text Sources] --> B[Ingestion Pipeline]
    B --> C[Parse + Chunk]
    C --> D[(SQLite + FTS5)]
    C --> E[Generate Embeddings]
    E --> F[(zvec Vector Index)]
```

### Retrieval pipeline

```mermaid
flowchart LR
    Q[User Query] --> M{Mode}

    M -->|lexical| L[FTS/BM25 Search]
    M -->|vector| V[Embedding + zvec Search]
    M -->|hybrid| H[FTS + Vector in parallel]

    L --> O[Top Results]
    V --> O
    H --> R[RRF Fusion]
    R --> O

    O --> C1[CLI Output]
    O --> C2[MCP Tools]
```

At runtime, the same core API powers both CLI commands and MCP tools, so behavior stays consistent across direct terminal use and agent workflows.

## Project layout

- `src/ingest/` - discovery, parsing, chunking, orchestration
- `src/search/` - lexical/vector retrieval + fusion
- `src/core/` - shared API (`save`, `recall`, `get`, `list`, `delete`, `reindex`, `status`)
- `src/mcp/` - MCP server + tool registration
- `src/db/` - SQLite handling + migrations
- `config.example.json` - sample configuration

## Getting started

### 1) Install

```bash
npm install
```

### 2) Configure

Create your local config file:

```bash
cp config.example.json config.json
```

Then update:

- `workspaces[].root` to a real absolute path
- any desired `patterns` for ingestion
- storage paths (`storage.dbPath`, `storage.zvecPath`) if needed
- `ai.embedding.provider` if you want to switch from local `llamacpp` to `gemini`
- `ai.embedding.apiKey` / `ZMD_EMBED_API_KEY` when using `gemini`
- `storage.baseDir` only if you want to override the default XDG-style storage root
- `ai.queryExpansion.*` if you want to tune or disable default local-first query expansion

If `config.json` is missing, `zmem` falls back to defaults.

Default storage is outside your repo:

- macOS/Linux: `~/.local/share/zmem/workspaces/<workspace-slug>/`
- Windows: `%APPDATA%/zmem/workspaces/<workspace-slug>/`

Within each workspace directory, zmem stores:

- `memory.db`
- `vectors/`

Advanced overrides still work through `storage.baseDir`, `storage.dbPath`, `storage.zvecPath`, `ZMEM_STORAGE_BASE_DIR`, `ZMEM_DB_PATH`, and `ZMEM_ZVEC_PATH`.

Query expansion can also be tuned with env vars such as:

- `ZMEM_QUERY_EXPANSION_ENABLED`
- `ZMEM_QUERY_EXPANSION_PROVIDER`
- `ZMEM_QUERY_EXPANSION_MODEL`
- `ZMEM_QUERY_EXPANSION_FALLBACK_MODEL`
- `ZMEM_QUERY_EXPANSION_MAX_EXPANSIONS`

### 3) Ingest documents

```bash
npm run dev -- ingest ./docs --workspace=default
```

### 4) Query memory

```bash
npm run dev -- query "database decisions" --mode=hybrid --workspace=default
```

### 5) Check status

```bash
npm run dev -- status --workspace=default
```

## CLI usage

Run help:

```bash
npm run dev -- help
```

Primary commands:

- `ingest <path> [--workspace=<name>] [--logs=true|false]`
- `query <query> [--workspace=<name>] [--mode=hybrid|lexical|vector|recent|important|typed] [--scopes=a,b] [--types=a,b] [--expansion-mode=off|deterministic|llm] [--logs=true|false]`
- `status [--workspace=<name>] [--logs=true|false]`
- `init [--config=./config.json] [--workspace=<name>] [--root=<path>] [--storage-base-dir=<path>] [--enable-query-expansion=true|false] [--yes]`
- `doctor [--config=./config.json] [--workspace=<name>]`
- `config show [--config=./config.json] [--workspace=<name>]`
- `models <status|check|pull> [--config=./config.json]`
- `mcp [--config=./config.json] [--workspace=<name>] [--verbose=true|false]`

Examples:

```bash
npm run dev -- ingest ./test-docs/search --workspace=default
npm run dev -- query "sqlite" --mode=lexical --workspace=default
npm run dev -- query "vector embeddings" --mode=vector --workspace=default
npm run dev -- init --workspace=default --root=/absolute/path/to/repo --yes
npm run dev -- doctor --workspace=default
npm run dev -- models pull
```

## Local query expansion

zmem now defaults to local-first query expansion for hybrid retrieval.

- primary model: `hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_M`
- fallback model: `hf:mradermacher/qmd-query-expansion-qwen3.5-2B-GGUF:Q4_K_S`
- expansion is skipped when lexical exact-match signal is already strong
- if the local model is unavailable, zmem warns once and falls back to deterministic expansion

To inspect or prepare local models:

```bash
npm run dev -- models status
npm run dev -- models pull
```

## MCP usage

Start the MCP stdio server:

```bash
npm run dev -- mcp --workspace=default
```

Implemented tools:

- `memory_query`
- `memory_search`
- `memory_get`
- `memory_list`
- `memory_save`
- `memory_delete`
- `memory_status`
- `memory_link`
- `memory_neighbors`
- `memory_edge_update`

Optional admin tool:

- `memory_reindex` (enabled with `ZMEM_ENABLE_REINDEX_TOOL=true`)

Verbose MCP logs:

```bash
ZMEM_MCP_VERBOSE=true npm run dev -- mcp --workspace=default
```

## Local development

Useful scripts:

- `npm run dev` - run CLI via `tsx`
- `npm run build` - build TypeScript to `dist/`
- `npm start` - run built CLI
- `npm run typecheck` - type-check without emitting
- `npm test` - run tests
- `npm run smoke` - build + smoke script

Typical dev loop:

```bash
npm run typecheck
npm test
npm run smoke
```

## Environment variables

- `ZMD_EMBED_MODEL` - override embedding model
- `ZMD_EMBED_DIMENSIONS` - override embedding dimensions
- `ZMD_EMBED_PROVIDER` - override embedding provider (`llamacpp`, `openai`, `ollama`, `gemini`, `mock`)
- `ZMD_EMBED_API_KEY` - embedding API key override for remote providers such as Gemini
- `ZMD_EMBED_BASE_URL` - optional embedding API base URL override
- `ZMD_EMBED_TASK_TYPE` - optional Gemini task type override such as `RETRIEVAL_DOCUMENT`
- `ZMEM_STORAGE_BASE_DIR` - override the XDG-style storage root
- `ZMEM_DB_PATH` - override the resolved database path directly
- `ZMEM_ZVEC_PATH` - override the resolved vector storage path directly
- `ZMEM_WORKSPACE` - default workspace for MCP resolution
- `ZMEM_MCP_VERBOSE=true` - verbose MCP logs to stderr
- `ZMEM_ENABLE_REINDEX_TOOL=true` - expose `memory_reindex` MCP tool

## Roadmap
- [ ] graph traversal poc 
- [ ] Rust implementation and comparison with metrics
- [ ] policy/compliance/audit/retention layer
- [ ] added unit tests for error paths 
- [ ] improve batching controls and recall latency metrics
- [ ] more integration ergonomics and ideas
- [ ] reranking improvements (position-aware blend)
- [ ] query expansion strategies
- [ ] deeper retrieval tuning and eval harnesses
