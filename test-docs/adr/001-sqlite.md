---
title: "ADR-001: Use SQLite for Local Storage"
type: decision
tags: [database, storage, architecture]
date: 2024-01-15
importance: 0.8
---

# ADR-001: Use SQLite for Local Storage

## Context

We need a local database solution for the memory system that is:
- Zero-configuration
- Fast for read-heavy workloads
- Portable across platforms
- Small footprint

## Decision

We will use SQLite for local storage because it meets all our requirements:

1. **Zero-config**: No server setup required
2. **Fast**: Excellent read performance for our use case
3. **Portable**: Single file database
4. **Small**: Minimal resource usage

## Consequences

### Positive
- Simple deployment
- Easy backups (just copy the file)
- Well-tested and reliable

### Negative
- Limited concurrent write performance
- Not suitable for distributed systems

## Related Decisions

- See ADR-002 for vector storage choice
New content added for testing
New content added for testing FTS
Test update for FTS sync
Test content for FTS
