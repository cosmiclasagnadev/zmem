# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

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
