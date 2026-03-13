import assert from "node:assert/strict";
import test from "node:test";
import { appConfigSchema } from "../src/config/schema.js";
import { createEmbeddingProvider } from "../src/embed/factory.js";
import { GeminiEmbeddingProvider } from "../src/embed/gemini-provider.js";
import { MockEmbeddingProvider } from "../src/embed/mock-provider.js";

test("embedding config schema accepts gemini and mock providers", () => {
  const geminiConfig = appConfigSchema.parse({
    defaults: {
      retrieval: {},
    },
    ai: {
      embedding: {
        provider: "gemini",
        model: "gemini-embedding-001",
        dimensions: 768,
        batchSize: 4,
        maxTokens: 2048,
        taskType: "RETRIEVAL_DOCUMENT",
      },
      rerank: {},
    },
  });

  assert.equal(geminiConfig.ai.embedding.provider, "gemini");
  assert.equal(geminiConfig.ai.embedding.taskType, "RETRIEVAL_DOCUMENT");

  const mockConfig = appConfigSchema.parse({
    defaults: {
      retrieval: {},
    },
    ai: {
      embedding: {
        provider: "mock",
        model: "test-embed",
        dimensions: 3,
        batchSize: 8,
        maxTokens: 1024,
      },
      rerank: {},
    },
  });

  assert.equal(mockConfig.ai.embedding.provider, "mock");
});

test("createEmbeddingProvider validates gemini api keys", () => {
  assert.throws(
    () =>
      createEmbeddingProvider({
        provider: "gemini",
        model: "gemini-embedding-001",
        dimensions: 768,
        batchSize: 4,
        maxTokens: 2048,
      }),
    /requires apiKey/
  );
});

test("createEmbeddingProvider validates shared numeric config", () => {
  assert.throws(
    () =>
      createEmbeddingProvider({
        provider: "mock",
        model: "test-embed",
        dimensions: 0,
        batchSize: 8,
        maxTokens: 1024,
      }),
    /dimensions/
  );
});

test("createEmbeddingProvider returns concrete gemini and mock providers", async () => {
  const gemini = createEmbeddingProvider({
    provider: "gemini",
    model: "gemini-embedding-001",
    dimensions: 3,
    batchSize: 2,
    maxTokens: 1024,
    apiKey: "test-key",
  });
  const mock = createEmbeddingProvider({
    provider: "mock",
    model: "test-embed",
    dimensions: 3,
    batchSize: 2,
    maxTokens: 1024,
  });

  assert.ok(gemini instanceof GeminiEmbeddingProvider);
  assert.ok(mock instanceof MockEmbeddingProvider);

  const first = await mock.embed("alpha");
  const second = await mock.embed("alpha");
  const third = await mock.embed("beta");

  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.notDeepEqual(first, third);
});
