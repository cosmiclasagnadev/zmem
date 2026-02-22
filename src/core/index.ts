export interface MemoryStatus {
  totalItems: number;
  totalVectors: number;
  pendingEmbeddings: number;
}

export function getMemoryStatus(): MemoryStatus {
  return {
    totalItems: 0,
    totalVectors: 0,
    pendingEmbeddings: 0
  };
}
