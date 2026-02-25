export type MemoryType =
  | "fact"
  | "decision"
  | "preference"
  | "event"
  | "goal"
  | "todo";

export type MemoryScope = "global" | "workspace" | "user";

export interface MemoryItem {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  summary: string;
  source: string;
  scope: MemoryScope;
  tags: string[];
  importance: number;
  status: "pending" | "active" | "archived" | "deleted";
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}
