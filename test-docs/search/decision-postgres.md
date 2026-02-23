---
type: decision
scope: workspace
tags: [database, postgres, backend, storage]
importance: 1.0
---

# Use PostgreSQL for production databases

After evaluating multiple database options including MySQL, MongoDB, and SQLite, we have decided to use PostgreSQL as our primary relational database for production workloads.

## Rationale

- Strong ACID compliance guarantees data integrity
- Excellent JSON support for semi-structured data
- Rich ecosystem of extensions (PostGIS, pgvector, etc.)
- Superior query optimizer and performance
- Active community and enterprise support

## Action items

- Set up PostgreSQL cluster in staging environment
- Migrate existing SQLite data to PostgreSQL
- Update documentation with connection strings
