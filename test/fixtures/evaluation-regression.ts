import type { MemoryType } from "../../src/types/memory.js";
import type { FixtureEdge, FixtureMemory } from "../helpers/fixture-harness.js";

export type EvaluationScenario = {
  id: string;
  category: "document-heavy" | "memory-heavy" | "relational-history" | "supersession-history" | "preference-context";
  query: string;
  mode: "hybrid" | "lexical" | "vector" | "recent" | "important" | "typed";
  topK: number;
  includeSuperseded?: boolean;
  types?: MemoryType[];
  smokePath: "cli" | "core";
  expectedIds: string[];
  excludedIds?: string[];
  snippetIncludes?: Record<string, string>;
};

export const EVALUATION_REGRESSION_WORKSPACE = "story13-eval-regression";

export const evaluationRegressionMemories: FixtureMemory[] = [
  {
    id: "eval_doc_runbook",
    type: "decision",
    title: "Architecture Migration Runbook",
    content:
      "A long-form migration runbook with an appendix, rollback notes, and the decisive checkpoint ledger for story13docanchor.",
    chunks: [
      "Introduction and preparation notes for the architecture migration runbook.",
      "story13docanchor story13docanchor decisive rollback checkpoint ledger with owner handoffs and verification evidence.",
      "Closing checklist and appendix summary for the migration runbook.",
    ],
    createdAt: "2026-03-12T00:00:01.000Z",
    importance: 0.91,
    tags: ["migration", "runbook"],
  },
  {
    id: "eval_doc_appendix",
    type: "fact",
    title: "Migration Appendix Reference",
    content: "Appendix reference with secondary evidence for story13docanchor.",
    chunks: ["story13docanchor appendix reference with slower secondary evidence and glossary terms."],
    createdAt: "2026-03-12T00:00:02.000Z",
    importance: 0.42,
    tags: ["migration", "appendix"],
  },
  {
    id: "eval_rel_change_seed",
    type: "fact",
    title: "Release Change Summary",
    content: "Summary of what changed after the rollout with the main anchor memory.",
    chunks: ["story13relanchor what changed after rollout and why the new release differs from baseline."],
    createdAt: "2026-03-12T00:00:03.000Z",
    importance: 0.78,
    tags: ["release", "history"],
  },
  {
    id: "eval_rel_baseline",
    type: "event",
    title: "Baseline Before Release",
    content: "Baseline behavior before the rollout for comparison.",
    chunks: ["comparison baseline before rollout with prior behavior and regression checks."],
    createdAt: "2026-03-12T00:00:04.000Z",
    importance: 0.59,
    tags: ["release", "baseline"],
  },
  {
    id: "eval_history_old",
    type: "decision",
    title: "Deploy Policy v1",
    content: "story13supersessionanchor old deploy policy that required a manual freeze window.",
    chunks: ["story13supersessionanchor old deploy policy manual freeze window and handoff notes."],
    createdAt: "2026-03-12T00:00:05.000Z",
    importance: 0.67,
    status: "archived",
    tags: ["deploy", "history"],
  },
  {
    id: "eval_history_new",
    type: "decision",
    title: "Deploy Policy v2",
    content: "story13supersessionanchor current deploy policy with staged verification instead of the old freeze window.",
    chunks: ["story13supersessionanchor current deploy policy staged verification and automated checks."],
    createdAt: "2026-03-12T00:00:06.000Z",
    importance: 0.88,
    supersedesId: "eval_history_old",
    tags: ["deploy", "history"],
  },
  {
    id: "eval_memory_todo",
    type: "todo",
    title: "CLI Result Cleanup Todo",
    content: "Follow up on CLI result formatting cleanup.",
    chunks: ["follow up on cli result formatting cleanup task"],
    createdAt: "2026-03-12T00:00:07.000Z",
    importance: 0.31,
    tags: ["cli", "todo"],
  },
  {
    id: "eval_memory_event",
    type: "event",
    title: "CLI Review Sync",
    content: "Review sync for recent CLI result changes.",
    chunks: ["recent cli review sync for output changes"],
    createdAt: "2026-03-12T00:00:08.000Z",
    importance: 0.37,
    tags: ["cli", "review"],
  },
  {
    id: "eval_memory_decision",
    type: "decision",
    title: "CLI Result Ordering Decision",
    content: "Decision to keep numbered ordering for CLI result lists.",
    chunks: ["decision keep numbered ordering for cli result lists"],
    createdAt: "2026-03-12T00:00:09.000Z",
    importance: 0.73,
    tags: ["cli", "decision"],
  },
  {
    id: "eval_memory_preference",
    type: "preference",
    title: "CLI Output Preference",
    content: "Prefer numbered CLI output with a one-line summary and evidence note for each item.",
    chunks: ["cli output preference prefer numbered results with one line summary and evidence note"],
    createdAt: "2026-03-12T00:00:10.000Z",
    importance: 0.86,
    tags: ["cli", "preference"],
  },
  {
    id: "eval_pref_context",
    type: "fact",
    title: "CLI Rendering Context",
    content: "Renderer template for numbered result blocks and summary lines.",
    chunks: ["renderer template for numbered result blocks summary lines and evidence sections"],
    createdAt: "2026-03-12T00:00:11.000Z",
    importance: 0.48,
    tags: ["cli", "context"],
  },
];

export const evaluationRegressionEdges: FixtureEdge[] = [
  {
    id: "eval_edge_rel_baseline",
    fromMemoryId: "eval_rel_change_seed",
    toMemoryId: "eval_rel_baseline",
    relationType: "related_to",
    confidence: 0.96,
    origin: "manual",
    status: "accepted",
    justification: "Baseline context should accompany change-history queries.",
    acceptedBy: "user",
  },
  {
    id: "eval_edge_preference_context",
    fromMemoryId: "eval_memory_preference",
    toMemoryId: "eval_pref_context",
    relationType: "preferred_with",
    confidence: 0.94,
    origin: "manual",
    status: "accepted",
    justification: "Output preferences should surface alongside rendering context.",
    acceptedBy: "user",
  },
];

export const evaluationRegressionScenarios: EvaluationScenario[] = [
  {
    id: "document-heavy-runbook",
    category: "document-heavy",
    query: "story13docanchor rollback checkpoint ledger",
    mode: "lexical",
    topK: 3,
    smokePath: "cli",
    expectedIds: ["eval_doc_runbook"],
    snippetIncludes: {
      eval_doc_runbook: "rollback checkpoint ledger",
    },
  },
  {
    id: "document-heavy-appendix",
    category: "document-heavy",
    query: "story13docanchor appendix reference",
    mode: "lexical",
    topK: 3,
    smokePath: "cli",
    expectedIds: ["eval_doc_appendix"],
  },
  {
    id: "memory-heavy-recent",
    category: "memory-heavy",
    query: "",
    mode: "recent",
    topK: 5,
    smokePath: "cli",
    expectedIds: [
      "eval_pref_context",
      "eval_memory_preference",
      "eval_memory_decision",
      "eval_memory_event",
      "eval_memory_todo",
    ],
  },
  {
    id: "relational-history-graph",
    category: "relational-history",
    query: "story13relanchor what changed",
    mode: "lexical",
    topK: 3,
    smokePath: "core",
    expectedIds: ["eval_rel_baseline", "eval_rel_change_seed"],
    snippetIncludes: {
      eval_rel_baseline: "Baseline behavior before the rollout",
    },
  },
  {
    id: "supersession-default-active-only",
    category: "supersession-history",
    query: "story13supersessionanchor",
    mode: "lexical",
    topK: 3,
    smokePath: "cli",
    expectedIds: ["eval_history_new"],
    excludedIds: ["eval_history_old"],
  },
  {
    id: "supersession-include-history",
    category: "supersession-history",
    query: "story13supersessionanchor",
    mode: "lexical",
    topK: 3,
    includeSuperseded: true,
    smokePath: "core",
    expectedIds: ["eval_history_new", "eval_history_old"],
  },
  {
    id: "preference-context-link",
    category: "preference-context",
    query: "related context for cli output preference",
    mode: "lexical",
    topK: 3,
    smokePath: "core",
    expectedIds: ["eval_memory_preference", "eval_pref_context"],
    snippetIncludes: {
      eval_memory_preference: "numbered results",
    },
  },
];
