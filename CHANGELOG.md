# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

## [0.1.1] - 2026-03-16

### Added
- Graph-aware memory relationships with explicit edge persistence, moderation states, lineage-aware recall, and MCP edge-management tools.
- Chunk-first retrieval with memory-item rollup, supporting snippet evidence, graph expansion, heuristic reranking, and new `recent`, `important`, and `typed` search modes.
- Local-first query expansion with deterministic fallback, default Q4 GGUF model configuration, setup/diagnostic CLI flows (`init`, `doctor`, `config show`, `models status`, `models check`, `models pull`), and richer MCP search support.
- Gemini Embedding 2 provider support, expanded regression fixtures, and broader smoke coverage across CLI, MCP, storage, graph, and retrieval behavior.

### Changed
- Default storage now uses XDG-style user-scoped workspace directories instead of repo-local `./data` paths.
- Config loading now honors precedence consistently: environment overrides, then config file values, then derived defaults.
- `memory_search` now returns clean evidence-backed memory results by default, and MCP/CLI query expansion behavior now respects config defaults and disabled-state overrides.
- Save and edge workflows now enforce stronger rollback, provenance, symmetric-edge, and moderation semantics.

### Fixed
- Repo pollution from default storage paths creating `data/` folders inside user workspaces.
- Partial save failure cases that could leave memory rows, chunks, edges, or vectors behind.
- Symmetric edge duplication, false MCP `updated` actions, semantic-score zero handling, and smoke cleanup deleting vectors by the wrong IDs.
- Query-expansion contract drift between config, core recall, MCP tools, and runtime defaults.

### Added
- Open-source readiness updates: MIT license, CI workflow, and repository hygiene improvements.

### Changed
- npm package distribution updated to scoped publishing under `@cosmiclasagnadev/zmem`.

## [0.1.0] - 2026-02-26

### Added
- Local-first hybrid memory MVP using SQLite FTS5/BM25 plus zvec vector retrieval.
- Ingestion pipeline for markdown/text: file discovery, parsing, token-aware chunking, embeddings, and vector upsert.
- Retrieval pipeline with lexical search, vector search, and RRF fusion.
- Core API operations: `save`, `recall`, `get`, `list`, `delete`, `reindex`, and `status`.
- MCP server with tools: `memory_query`, `memory_get`, `memory_list`, `memory_save`, `memory_delete`, `memory_status`.
- Optional MCP admin tool `memory_reindex` behind `ZMEM_ENABLE_REINDEX_TOOL=true`.
- Smoke test coverage and lexical sanitization tests.
- Public README with architecture and Mermaid diagrams for indexing and retrieval.

### Changed
- CLI and MCP server share the same core API service layer for consistent behavior.
