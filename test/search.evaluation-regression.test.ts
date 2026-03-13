import assert from "node:assert/strict";
import test from "node:test";
import { recall } from "../src/core/index.js";
import {
  EVALUATION_REGRESSION_WORKSPACE,
  evaluationRegressionEdges,
  evaluationRegressionMemories,
  evaluationRegressionScenarios,
} from "./fixtures/evaluation-regression.js";
import { assertTopIds, createFixtureTestCoreContext, seedFixtureWorkspace } from "./helpers/fixture-harness.js";

test("story 13 evaluation fixtures stay stable across regression scenarios", async () => {
  const { ctx, handle, cleanup } = createFixtureTestCoreContext({
    workspace: EVALUATION_REGRESSION_WORKSPACE,
    throwOnEmbed: true,
    throwOnVectorQuery: true,
  });

  try {
    seedFixtureWorkspace(handle, EVALUATION_REGRESSION_WORKSPACE, evaluationRegressionMemories, evaluationRegressionEdges);

    const exercisedIds = new Set<string>();

    for (const scenario of evaluationRegressionScenarios) {
      const results = await recall(ctx, scenario.query, {
        mode: scenario.mode,
        topK: scenario.topK,
        includeSuperseded: scenario.includeSuperseded,
        types: scenario.types,
      });

      assertTopIds(results, scenario.expectedIds, `unexpected order for ${scenario.id}`);
      assert(results.length <= scenario.topK, `scenario ${scenario.id} should respect topK=${scenario.topK}`);

      for (const expectedId of scenario.expectedIds) {
        exercisedIds.add(expectedId);
      }

      for (const excludedId of scenario.excludedIds ?? []) {
        assert(!results.some((result) => result.id === excludedId), `scenario ${scenario.id} should exclude ${excludedId}`);
        exercisedIds.add(excludedId);
      }

      for (const [memoryId, snippetText] of Object.entries(scenario.snippetIncludes ?? {})) {
        const match = results.find((result) => result.id === memoryId);
        assert(match, `scenario ${scenario.id} should return ${memoryId}`);
        const normalizedSnippet = (match.snippet ?? "").replace(/<\/?mark>/g, "");
        assert.match(
          normalizedSnippet,
          new RegExp(snippetText, "i"),
          `scenario ${scenario.id} should preserve snippet evidence for ${memoryId}`
        );
      }
    }

    assert.deepEqual(
      [...exercisedIds].sort(),
      evaluationRegressionMemories.map((memory) => memory.id).sort(),
      "every evaluation fixture memory should be exercised by at least one regression scenario"
    );
  } finally {
    cleanup();
  }
});
