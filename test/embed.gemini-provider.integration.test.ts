import assert from "node:assert/strict";
import test from "node:test";
import { GeminiEmbeddingProvider } from "../src/embed/gemini-provider.js";

const integrationApiKey =
  process.env.ZMD_EMBED_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

test("GeminiEmbeddingProvider integration embeds against the live API when credentials are available", async (t) => {
  if (!integrationApiKey) {
    t.skip("Set ZMD_EMBED_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY to run this integration test");
    return;
  }

  const provider = new GeminiEmbeddingProvider({
    provider: "gemini",
    model: process.env.ZMD_EMBED_MODEL || "gemini-embedding-001",
    dimensions: Number(process.env.ZMD_EMBED_DIMENSIONS || 768),
    batchSize: 2,
    maxTokens: 2048,
    apiKey: integrationApiKey,
    baseUrl: process.env.ZMD_EMBED_BASE_URL,
    taskType: process.env.ZMD_EMBED_TASK_TYPE,
  });

  await provider.initialize();

  try {
    const embedding = await provider.embed("zmem gemini provider integration test");
    assert.equal(embedding.length, provider.dimensions);
    assert.ok(embedding.every((value) => Number.isFinite(value)));
  } finally {
    await provider.dispose();
  }
});
