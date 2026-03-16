export type CliRegressionMemoryFixture = {
  id: string;
  type: "fact" | "decision" | "preference" | "event" | "goal" | "todo";
  title: string;
  content: string;
  chunks: string[];
  createdAt: string;
  updatedAt?: string;
  importance?: number;
  summary?: string;
  source?: string;
  scope?: "workspace" | "global" | "user";
  tags?: string[];
};

export type CliRegressionEdgeFixture = {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationType: "related_to" | "supports" | "contradicts" | "caused_by" | "derived_from" | "preferred_with";
  confidence: number;
  origin: "manual" | "llm";
  status: "suggested" | "accepted" | "rejected";
  justification: string;
  acceptedBy: "user" | "agent" | "system" | null;
};

export const CLI_SEARCH_REGRESSION_WORKSPACE = "smoke-cli-search-regression";
export const CLI_SEARCH_PRIMARY_QUERY = "database migration";
export const CLI_SEARCH_GRAPH_QUERY = "related context for database migration";
export const CLI_SEARCH_EXPECTED_QUERY_TITLE = "Database Migration Runbook";
export const CLI_SEARCH_EXPECTED_RECENT_TITLE = "CLI Output Formatting Preference";
export const CLI_SEARCH_EXPECTED_GRAPH_TITLE = "Rollback Rehearsal Context";
export const CLI_SEARCH_TYPED_ALLOWED_TYPES = ["decision", "preference"] as const;
export const CLI_SEARCH_TYPED_DISALLOWED_TITLES = [
  "Legacy Migration Audit",
  "Release Timeline Note",
  "Rollback Rehearsal Context",
] as const;

export const cliSearchRegressionMemories: CliRegressionMemoryFixture[] = [
  {
    id: "cli_fact_legacy_audit",
    type: "fact",
    title: "Legacy Migration Audit",
    content: "Legacy database audit notes for an earlier migration rehearsal.",
    chunks: ["legacy database audit notes for an earlier migration rehearsal"],
    createdAt: "2026-03-12T00:00:01.000Z",
    importance: 0.31,
    tags: ["migration", "legacy"],
  },
  {
    id: "cli_decision_runbook",
    type: "decision",
    title: "Database Migration Runbook",
    content: "Database migration runbook for the cutover window with rollback checkpoints and owner handoffs.",
    chunks: ["database migration runbook cutover plan rollback checkpoints owner handoffs"],
    createdAt: "2026-03-12T00:00:02.000Z",
    importance: 0.96,
    tags: ["migration", "runbook"],
  },
  {
    id: "cli_fact_rollback_context",
    type: "fact",
    title: "Rollback Rehearsal Context",
    content: "Rollback rehearsal notes for the migration window, including linked context for dependencies and verification.",
    chunks: ["rollback rehearsal linked context for migration dependencies and verification"],
    createdAt: "2026-03-12T00:00:03.000Z",
    importance: 0.62,
    tags: ["migration", "rollback"],
  },
  {
    id: "cli_event_release_timeline",
    type: "event",
    title: "Release Timeline Note",
    content: "Release timeline note for launch sequencing and comms.",
    chunks: ["release timeline note for launch sequencing and communications"],
    createdAt: "2026-03-12T00:00:04.000Z",
    importance: 0.44,
    tags: ["release"],
  },
  {
    id: "cli_preference_output",
    type: "preference",
    title: "CLI Output Formatting Preference",
    content: "Prefer numbered CLI search results with the newest item surfaced first in recent mode.",
    chunks: ["prefer numbered cli search results newest item surfaced first in recent mode"],
    createdAt: "2026-03-12T00:00:05.000Z",
    importance: 0.83,
    tags: ["cli", "output"],
  },
];

export const cliSearchRegressionEdges: CliRegressionEdgeFixture[] = [
  {
    id: "cli_edge_runbook_related_context",
    fromMemoryId: "cli_decision_runbook",
    toMemoryId: "cli_fact_rollback_context",
    relationType: "related_to",
    confidence: 0.97,
    origin: "manual",
    status: "accepted",
    justification: "Rollback rehearsal context should travel with the migration runbook.",
    acceptedBy: "user",
  },
];
