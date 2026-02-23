import pMap from "p-map";
import type { DbHandle } from "../db/index.js";
import type { EmbeddingProvider } from "../embed/types.js";
import type { VectorCollection } from "../vectors/index.js";
import { discoverFiles } from "./discovery.js";
import { parseMarkdown } from "./parser.js";
import { chunkDocument } from "./chunker.js";
import { ProgressReporter } from "./progress.js";
import {
  findExistingDocument,
  insertMemoryItem,
  updateMemoryItem,
  insertChunks,
  markChunksEmbedded,
  getActiveDocumentSources,
  softDeleteMissingDocuments,
} from "./repository.js";
import type {
  ParsedDocument,
  IngestResult,
} from "./types.js";

const CONCURRENCY = {
  parsing: 10, // Parallel file reads
  embedding: 8, // Batch size for embeddings
};

export interface IngestOptions {
  workspace: string;
  workspacePath: string;
  patterns: string[];
  db: DbHandle;
  vectorStore: VectorCollection;
  embedProvider: EmbeddingProvider;
  reporter?: ProgressReporter;
}

/**
 * Main ingestion orchestrator
 */
export async function ingestWorkspace(
  options: IngestOptions
): Promise<IngestResult> {
  const {
    workspace,
    workspacePath,
    patterns,
    db,
    vectorStore,
    embedProvider,
    reporter,
  } = options;

  const startTime = Date.now();
  const result: IngestResult = {
    scanned: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    chunksCreated: 0,
    errors: [],
    duration: 0,
  };

  try {
    // Phase 1: Discovery
    reporter?.update({
      phase: "scanning",
      current: 0,
      total: 0,
      description: "Scanning for files...",
    });

    const discoveredFiles = await discoverFiles({
      workspacePath,
      patterns,
    });

    result.scanned = discoveredFiles.length;
    const seenSources = new Set<string>();

    reporter?.update({
      phase: "scanning",
      current: discoveredFiles.length,
      total: discoveredFiles.length,
      description: `Found ${discoveredFiles.length} files`,
    });

    // Phase 2: Parse all files in parallel
    reporter?.update({
      phase: "parsing",
      current: 0,
      total: discoveredFiles.length,
      description: "Parsing markdown files...",
    });

    const parsedDocs: ParsedDocument[] = [];
    let parsedCount = 0;

    await pMap(
      discoveredFiles,
      async (file) => {
        try {
          const doc = parseMarkdown(
            file.absolutePath,
            file.relativePath,
            workspace
          );
          parsedDocs.push(doc);
          seenSources.add(file.relativePath);

          parsedCount++;
          reporter?.update({
            phase: "parsing",
            current: parsedCount,
            total: discoveredFiles.length,
            currentFile: file.relativePath,
          });
        } catch (error) {
          result.errors.push({
            file: file.relativePath,
            error: error instanceof Error ? error.message : String(error),
          });

          parsedCount++;
          reporter?.update({
            phase: "parsing",
            current: parsedCount,
            total: discoveredFiles.length,
            currentFile: file.relativePath,
          });
        }
      },
      { concurrency: CONCURRENCY.parsing }
    );

    // Phase 3: Process each document (check existing, chunk, embed, store)
    reporter?.update({
      phase: "chunking",
      current: 0,
      total: parsedDocs.length,
      description: "Processing documents...",
    });

    let processedCount = 0;
    const docsToProcess: Array<{
      doc: ParsedDocument;
      existing: ReturnType<typeof findExistingDocument>;
    }> = [];

    // Check which documents need processing
    for (const doc of parsedDocs) {
      const existing = findExistingDocument(db, doc.source, workspace);

      if (existing && existing.contentHash === doc.contentHash) {
        // Unchanged
        result.unchanged++;
      } else {
        docsToProcess.push({ doc, existing });
      }

      processedCount++;
      reporter?.update({
        phase: "chunking",
        current: processedCount,
        total: parsedDocs.length,
        currentFile: doc.source,
      });
    }

    // Phase 4: Chunk and embed in batches
    if (docsToProcess.length > 0) {
      reporter?.update({
        phase: "embedding",
        current: 0,
        total: docsToProcess.length,
        description: `Embedding ${docsToProcess.length} documents...`,
      });

      // Process in batches
      const batchSize = CONCURRENCY.embedding;
      for (let i = 0; i < docsToProcess.length; i += batchSize) {
        const batch = docsToProcess.slice(i, i + batchSize);

        // Chunk all documents in batch
        const chunkedDocs = batch.map(({ doc, existing }) => {
          const { chunks } = chunkDocument(doc.content);
          return { doc, existing, chunks };
        });

        // Collect all chunks for batch embedding
        const allChunks = chunkedDocs.flatMap(({ doc, chunks }) =>
          chunks.map((chunk) => ({
            id: `${doc.contentHash}_${chunk.seq}`,
            text: chunk.text,
            doc,
            chunk,
          }))
        );

        // Generate embeddings in parallel
        const embeddings = await embedProvider.embedBatch(
          allChunks.map((c) => ({ id: c.id, text: c.text }))
        );

        // Store documents, chunks, and vectors
        reporter?.update({
          phase: "storing",
          current: i,
          total: docsToProcess.length,
          description: "Storing vectors...",
        });

        for (const { doc, existing, chunks } of chunkedDocs) {
          try {
            // Insert or update memory item
            let memoryId: string;
            if (existing) {
              memoryId = updateMemoryItem(db, existing.id, doc);
              result.updated++;
            } else {
              memoryId = insertMemoryItem(db, doc);
              result.inserted++;
            }

            // Insert chunks to database
            insertChunks(db, memoryId, chunks);

            // Store vectors in zvec
            for (const chunk of chunks) {
              const chunkId = `${memoryId}_${chunk.seq}`;
              const embedding = embeddings.find((e) => e.id === chunkId);
              if (embedding) {
                vectorStore.insert(chunkId, embedding.embedding);
              }
            }

            // Mark chunks as embedded
            const chunkIds = chunks.map((c) => `${memoryId}_${c.seq}`);
            markChunksEmbedded(db, chunkIds, embedProvider.model);

            result.chunksCreated += chunks.length;
          } catch (error) {
            result.errors.push({
              file: doc.source,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        reporter?.update({
          phase: "embedding",
          current: Math.min(i + batchSize, docsToProcess.length),
          total: docsToProcess.length,
        });
      }
    }

    // Phase 5: Cleanup deleted files
    reporter?.update({
      phase: "cleanup",
      current: 0,
      total: 0,
      description: "Checking for deleted files...",
    });

    const sourcesToKeep = Array.from(seenSources);
    const removedCount = softDeleteMissingDocuments(
      db,
      workspace,
      sourcesToKeep
    );
    result.removed = removedCount;

    reporter?.update({
      phase: "cleanup",
      current: removedCount,
      total: removedCount,
      description: `Removed ${removedCount} missing files`,
    });

    result.duration = Date.now() - startTime;
    return result;
  } catch (error) {
    result.duration = Date.now() - startTime;
    throw error;
  }
}
