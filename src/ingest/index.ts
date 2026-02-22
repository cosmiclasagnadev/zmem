export interface IngestSummary {
  scannedFiles: number;
  newItems: number;
  updatedItems: number;
  unchangedItems: number;
}

export async function ingestWorkspace(): Promise<IngestSummary> {
  return {
    scannedFiles: 0,
    newItems: 0,
    updatedItems: 0,
    unchangedItems: 0
  };
}
