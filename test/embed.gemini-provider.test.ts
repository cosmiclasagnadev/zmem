import assert from "node:assert/strict";
import test from "node:test";
import { GeminiEmbeddingProvider } from "../src/embed/gemini-provider.js";

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("GeminiEmbeddingProvider handles single and batch response shapes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (url.includes(":embedContent")) {
      return createJsonResponse({
        embedding: {
          values: [0.1, 0.2, 0.3],
        },
      });
    }

    return createJsonResponse({
      embeddings: [
        { values: [0.4, 0.5, 0.6] },
        { embedding: { values: [0.7, 0.8, 0.9] } },
      ],
    });
  };

  try {
    const provider = new GeminiEmbeddingProvider({
      provider: "gemini",
      model: "gemini-embedding-001",
      dimensions: 3,
      batchSize: 2,
      maxTokens: 1024,
      apiKey: "test-key",
      taskType: "RETRIEVAL_QUERY",
    });
    await provider.initialize();

    const single = await provider.embed("hello world");
    const batch = await provider.embedBatch([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
    ]);

    assert.deepEqual(single, [0.1, 0.2, 0.3]);
    assert.deepEqual(batch, [
      { id: "a", embedding: [0.4, 0.5, 0.6], dimensions: 3 },
      { id: "b", embedding: [0.7, 0.8, 0.9], dimensions: 3 },
    ]);
    assert.equal(requests.length, 2);
    assert.match(requests[0]?.url ?? "", /embedContent\?key=test-key/);
    assert.match(requests[1]?.url ?? "", /batchEmbedContents\?key=test-key/);
    assert.equal((requests[0]?.body as { taskType?: string }).taskType, "RETRIEVAL_QUERY");
    assert.equal(
      ((requests[1]?.body as { requests?: Array<{ outputDimensionality?: number }> }).requests ?? [])[0]?.outputDimensionality,
      3
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GeminiEmbeddingProvider rejects invalid response shapes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => createJsonResponse({ embeddings: [{ values: [0.1, "bad", 0.3] }] });

  try {
    const provider = new GeminiEmbeddingProvider({
      provider: "gemini",
      model: "gemini-embedding-001",
      dimensions: 3,
      batchSize: 2,
      maxTokens: 1024,
      apiKey: "test-key",
    });
    await provider.initialize();

    await assert.rejects(
      () => provider.embedBatch([{ id: "a", text: "alpha" }]),
      /non-numeric embedding value/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GeminiEmbeddingProvider rejects dimension mismatches", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => createJsonResponse({ embedding: { values: [0.1, 0.2] } });

  try {
    const provider = new GeminiEmbeddingProvider({
      provider: "gemini",
      model: "gemini-embedding-001",
      dimensions: 3,
      batchSize: 2,
      maxTokens: 1024,
      apiKey: "test-key",
    });
    await provider.initialize();

    await assert.rejects(() => provider.embed("hello"), /dimension mismatch/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
