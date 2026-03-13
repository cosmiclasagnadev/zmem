import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildMemoryRollups, rollupChunkHits, type ChunkCandidateHit } from "../src/search/rollup.js";

type RollupFixture = {
  scenarios: Array<{
    name: string;
    topK: number;
    hits: ChunkCandidateHit[];
    expectedOrder: string[];
    expectedScores: Record<string, number>;
    expectedEvidence: Record<
      string,
      {
        bestHitScore: number;
        multiChunkSupport: number;
        chunkDiversity: number;
        uniqueChunkCount: number;
        uniqueSources: Array<"lex" | "vec" | "hybrid">;
        bestChunkId: string;
      }
    >;
  }>;
};

function round(value: number): number {
  return Number(value.toFixed(6));
}

function loadFixture(): RollupFixture {
  const fixturePath = new URL("./fixtures/search-rollup-v1.json", import.meta.url);
  return JSON.parse(readFileSync(fixturePath, "utf8")) as RollupFixture;
}

test("rollup keeps best chunk snippet while bounded support can lift a memory", () => {
  const results = rollupChunkHits(
    [
      {
        id: "mem_single_0",
        memoryId: "mem_single",
        title: "Single result",
        snippet: "single decisive snippet",
        score: 0.92,
        source: "vec",
        scope: "workspace",
        type: "fact",
        status: "active",
      },
      {
        id: "mem_multi_0",
        memoryId: "mem_multi",
        title: "Cluster result",
        snippet: "moderate snippet one",
        score: 0.73,
        source: "lex",
        scope: "workspace",
        type: "fact",
        status: "active",
      },
      {
        id: "mem_multi_1",
        memoryId: "mem_multi",
        title: "Cluster result",
        snippet: "moderate snippet two",
        score: 0.71,
        source: "vec",
        scope: "workspace",
        type: "fact",
        status: "active",
      },
      {
        id: "mem_multi_2",
        memoryId: "mem_multi",
        title: "Cluster result",
        snippet: "moderate snippet three",
        score: 0.69,
        source: "vec",
        scope: "workspace",
        type: "fact",
        status: "active",
      },
    ],
    10
  );

  assert.deepEqual(results.map((hit) => hit.id), ["mem_multi", "mem_single"]);
  assert.equal(results[0]?.snippet, "moderate snippet one");
  assert.equal(results[1]?.snippet, "single decisive snippet");
});

test("rollup regression fixture stays stable for story 6 ranking", () => {
  const fixture = loadFixture();

  for (const scenario of fixture.scenarios) {
    const rollups = buildMemoryRollups(scenario.hits);
    const results = rollupChunkHits(scenario.hits, scenario.topK);

    assert.deepEqual(
      results.map((hit) => hit.id),
      scenario.expectedOrder,
      `unexpected ranking for ${scenario.name}`
    );

    for (const rollup of rollups) {
      const expectedScore = scenario.expectedScores[rollup.memoryId];
      assert.equal(round(rollup.score), expectedScore, `unexpected score for ${scenario.name}:${rollup.memoryId}`);

      const expectedEvidence = scenario.expectedEvidence[rollup.memoryId];
      assert.ok(expectedEvidence, `missing expected evidence for ${scenario.name}:${rollup.memoryId}`);
      assert.deepEqual(
        {
          bestHitScore: round(rollup.evidence.bestHitScore),
          multiChunkSupport: round(rollup.evidence.multiChunkSupport),
          chunkDiversity: round(rollup.evidence.chunkDiversity),
          uniqueChunkCount: rollup.evidence.uniqueChunkCount,
          uniqueSources: rollup.evidence.uniqueSources,
          bestChunkId: rollup.evidence.bestChunkId,
        },
        expectedEvidence,
        `unexpected evidence for ${scenario.name}:${rollup.memoryId}`
      );
    }
  }
});
