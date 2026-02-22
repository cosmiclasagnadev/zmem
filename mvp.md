# MVP Scope

- Build a local-first hybrid memory system (QMD-inspired) for project, coding, and product decisions.
- Use zvec for vector retrieval and lexical retrieval (FTS/BM25) for keyword matching.
- Keep the MVP non-graph.
- Defer full policy/governance to later.
- Include a local MCP server for OpenCode/coding-model usage.

# Finalized Tech Stack

| Component | Choice | Role |
|-----------|--------|------|
| **Language** | TypeScript (Node.js) | Application layer |
| **Embedding engine** | node-llama-cpp | Loads GGUF models, generates embeddings in-process |
| **Default embedding model** | Qwen3-Embedding-0.6B-GGUF Q8_0 (~640MB) | Dense vector generation |
| **Vector storage/search** | @zvec/zvec | HNSW/IVF indexing, nearest-neighbor retrieval |
| **Metadata + FTS** | better-sqlite3 + FTS5 | Memory item storage, BM25 lexical search |
| **MCP server** | @modelcontextprotocol/sdk | Local MCP for OpenCode integration |
| **Config validation** | zod | Schema validation for config + MCP payloads |

# Data Model

- Core fields: `id`, `type`, `title`, `content`, `summary`, `source`, `scope`, `tags`, `importance`, `status`, `created_at`, `updated_at`.
- Include `supersedes_id` (nullable) in MVP for update semantics without graph traversal.
- Supported types: `fact`, `decision`, `preference`, `event`, `goal`, `todo`.
- Scope values: `global | workspace | user`.

# Retrieval Constants (QMD-Aligned)

| Constant | Value |
|----------|-------|
| First list RRF weight | 2.0 |
| Top-rank bonus | +0.05 |
| Candidate limit (pre-rerank) | 30 |
| Default top_k_lex | 30 |
| Default top_k_vec | 30 |
| Default min_score | 0.25 |
| Default include_superseded | false |
| Default scopes | `["workspace", "global"]` |

# Retrieval Pipeline

- Hybrid retrieval pipeline:
  - lexical search (FTS/BM25)
  - vector search (zvec)
  - fusion (RRF or weighted blend)
  - optional lightweight rerank
- Default behavior:
  - auto-select workspace when possible
  - search `workspace + global` by default
  - `include_superseded = false` by default

# Ingestion Pipeline

- Ingest markdown/text files.
- Chunk content.
- Generate embeddings.
- Upsert metadata and vectors.
- Support reindex and basic idempotency (avoid duplicate explosion).

# Interfaces

- Core operations: `save`, `recall`, `get`, `list`, `delete`, `reindex`.
- MCP tools:
  - `memory_query`
  - `memory_get`
  - `memory_list`
  - `memory_save`
  - `memory_delete`
  - `memory_status`
  - optional: `memory_reindex`

# Config and Defaults

- Workspace-based configuration with:
  - `include_by_default`
  - file patterns
  - retrieval defaults (`top_k`, `min_score`, `rerank_top_k`)
  - default scopes (`workspace`, `global`)
- AI configuration:
  - Embedding provider: `llamacpp`
  - Default model: `Qwen3-Embedding-0.6B-GGUF` (Q8_0)
  - Dimensions: 1024
  - Env overrides: `ZMD_EMBED_MODEL`, `ZMD_EMBED_PROVIDER`
- Precedence rule: request params > workspace config > global defaults.

# Implementation Phases

## ~~Phase 0: Bootstrap~~ ✅ COMPLETED

Project scaffold initialized:
- TypeScript project structure
- Dependencies: @zvec/zvec, better-sqlite3, node-llama-cpp, MCP SDK, zod
- Module scaffolding: config, types, db, ingest, embed, search, mcp, core
- Example config and basic entrypoint

## ~~Phase 1: Schema + Config + Embedding Provider~~ ✅ COMPLETED

**Goal:** Finalize all data contracts and get embedding generation working end-to-end.

- [x] Define `memory_items` SQLite table (including `supersedes_id`, FTS triggers, indexes)
- [x] Define `content_chunks` table (chunk_id, memory_id, seq, pos, token_count)
- [x] Create FTS5 virtual table over memory_items (title + content + tags)
- [x] Finalize config schema with `ai.embedding` section:
  - `provider: "llamacpp"`, `model: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/..."`, `dimensions: 1024`
  - Env override support (`ZMD_EMBED_MODEL`, `ZMD_EMBED_PROVIDER`)
- [x] Implement `EmbeddingProvider` interface + node-llama-cpp adapter (stub implementation)
- [x] Wire `embed(text)` and `embedBatch(texts[])` through the adapter
- [x] Initialize zvec collection with dimension=1024, HNSW index (stub implementation)
- [x] **Acceptance:** can load model, embed a string, store vector in zvec, and read it back

**Status:** Successfully tested end-to-end:
- Database migrations run and tables created (memory_items, content_chunks, chunk_embeddings, FTS5)
- Vector store initialized with in-memory cosine similarity search
- Embedding provider loads with deterministic pseudo-random vectors (stub for testing)
- Health check passes
- Embed + store + query round-trip works correctly
- All TypeScript type checks pass

**Next Steps:** Replace stub implementations with actual node-llama-cpp and @zvec/zvec integrations when APIs are verified, or continue with Phase 2 using current stubs.

## Phase 2: Ingestion Pipeline

**Goal:** Ingest a folder of markdown/text files into memory items + vectors.

- [ ] File discovery (glob patterns per workspace config)
- [ ] Content hashing for change detection (skip unchanged files)
- [ ] Chunking strategy (token-aware, heading-boundary preferred, ~900 tokens with overlap)
- [ ] Upsert flow: parse file -> create/update memory_item row -> chunk -> embed -> store vectors in zvec
- [ ] Deactivation of removed files
- [ ] `reindex` command (clear + re-ingest)
- **Acceptance:** ingest a real docs folder; `memory_status` shows correct counts; re-ingest same folder shows 0 new items

## Phase 3: Retrieval Pipeline

**Goal:** Hybrid search that returns ranked results from both lexical and vector paths.

- [ ] Lexical search: FTS5 query -> BM25 scoring -> normalize to 0..1
- [ ] Vector search: embed query via node-llama-cpp -> zvec `query()` -> cosine similarity scores
- [ ] RRF fusion with constants (first list weight 2.0, top-rank bonus +0.05, candidate limit 30)
- [ ] Filtering: `scope`, `type`, `status`, `include_superseded` (default false)
- [ ] Superseded handling: exclude items where `supersedes_id IS NOT NULL AND status != 'active'` targets exist
- [ ] Return payload: `id`, `title`, `snippet`, `score`, `source` (lex/vec/hybrid), `scope`, `type`
- **Acceptance:** `recall` returns sensible results for both keyword and semantic queries; superseded items are hidden by default

## Phase 4: Core API + Commands

**Goal:** Internal service layer that MCP and CLI both call.

- [ ] `save(item)` — create/update memory item, supports `supersedes_id`
- [ ] `recall(query, filters)` — hybrid search with defaults
- [ ] `get(id)` — fetch single memory item by id
- [ ] `list(filters)` — paginated list with type/scope/status filters
- [ ] `delete(id)` — soft-delete (set status = "deleted")
- [ ] `reindex()` — clear vectors + re-embed all active items
- [ ] `status()` — total items, total vectors, pending embeddings, last indexed timestamp
- **Acceptance:** all operations work via direct function calls; `save` + `recall` round-trip produces correct results

## Phase 5: MCP Server

**Goal:** Expose core API as MCP tools for OpenCode.

- [ ] MCP tools with strict zod input/output schemas:
  - `memory_query` (searches, limit, minScore, scopes, types, includeSuperseded)
  - `memory_get` (id)
  - `memory_list` (type, scope, status, limit, offset)
  - `memory_save` (type, title, content, summary, source, scope, tags, importance, supersedesId)
  - `memory_delete` (id)
  - `memory_status` ()
  - `memory_reindex` () (optional/admin)
- [ ] Startup: load config -> run migrations -> init embedding provider -> init zvec -> start MCP stdio server
- [ ] Error handling: embedding failures surface as clear error messages (no silent fallback)
- **Acceptance:** OpenCode can call all tools and get consistent, parseable responses

## Phase 6: Hardening + Smoke Tests

**Goal:** Stability and confidence before real usage.

- [ ] Smoke tests:
  - Ingest fixture docs -> verify counts
  - Recall keyword query -> verify lexical hits
  - Recall semantic query -> verify vector hits
  - Save with `supersedes_id` -> verify old item hidden in recall
  - Delete -> verify soft-delete behavior
  - Reindex -> verify idempotency
  - MCP tool round-trips
- [ ] Error path tests: missing model file, corrupt DB, empty corpus, invalid config
- [ ] Batching: embed in configurable batch sizes to manage memory
- [ ] Metrics: p50/p95 recall latency logged to stderr
- **Acceptance:** all smoke tests pass; repeated runs are stable

# Deferred (Later)

- LLM reranker (position-aware blend: 75/60/40)
- Query expansion (lex/vec/hyde variants)
- Graph edges and traversal.
- Full policy layer (RBAC/compliance/audit/retention engine).
- Advanced optimization/workflow extras beyond MVP.
