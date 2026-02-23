---
type: fact
scope: global
tags: [vector, embeddings, ai, machine-learning]
importance: 0.85
---

# Vector embeddings enable semantic similarity search

Vector embeddings are numerical representations of text that capture semantic meaning. They transform words, sentences, or documents into dense vectors in a high-dimensional space where similar items are close together.

## How embeddings work

- Text is converted to numbers using a transformer model
- Similar concepts end up near each other in vector space
- Distance between vectors indicates semantic similarity
- Common models: BERT, SBERT, OpenAI embeddings, Qwen embeddings

## Use cases

- Semantic search beyond keyword matching
- Recommendation systems
- Clustering similar documents
- Anomaly detection
- RAG (Retrieval Augmented Generation)

## Storage and retrieval

Vector databases like zvec use specialized indexes (HNSW, IVF) to enable fast nearest-neighbor search across millions of vectors.
