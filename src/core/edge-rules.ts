import type { EdgeRelationType } from "./types.js";

export const SYMMETRIC_EDGE_RELATIONS = new Set<EdgeRelationType>(["related_to"]);

export function isSymmetricEdgeRelation(relationType: EdgeRelationType): boolean {
  return SYMMETRIC_EDGE_RELATIONS.has(relationType);
}

export function buildEdgeEquivalenceKey(
  fromMemoryId: string,
  toMemoryId: string,
  relationType: EdgeRelationType
): string {
  if (!isSymmetricEdgeRelation(relationType)) {
    return `${fromMemoryId}:${toMemoryId}:${relationType}`;
  }

  const ordered = [fromMemoryId, toMemoryId].sort();
  return `${ordered[0]}:${ordered[1]}:${relationType}`;
}
