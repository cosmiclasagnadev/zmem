import type { IngestProgress, IngestResult } from "./types.js";

const PHASE_ICONS: Record<IngestProgress["phase"], string> = {
  scanning: "🔍",
  parsing: "📄",
  chunking: "✂️",
  embedding: "🧠",
  storing: "💾",
  cleanup: "🧹",
};

const PHASE_NAMES: Record<IngestProgress["phase"], string> = {
  scanning: "Scanning",
  parsing: "Parsing",
  chunking: "Chunking",
  embedding: "Embedding",
  storing: "Storing",
  cleanup: "Cleaning up",
};

export class ProgressReporter {
  private startTime: number = 0;
  private lastUpdate: number = 0;
  private minUpdateInterval = 100; // ms

  start(): void {
    this.startTime = Date.now();
    this.lastUpdate = 0;
  }

  update(progress: IngestProgress): void {
    const now = Date.now();

    // Throttle updates
    if (now - this.lastUpdate < this.minUpdateInterval) {
      return;
    }
    this.lastUpdate = now;

    const { phase, current, total, currentFile, description } = progress;
    const icon = PHASE_ICONS[phase];
    const phaseName = PHASE_NAMES[phase];

    // Calculate progress percentage
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

    // Format the status line
    let status = `${icon} ${phaseName}: [${current}/${total}] ${percentage}%`;

    if (currentFile) {
      const truncated =
        currentFile.length > 40
          ? "..." + currentFile.slice(-37)
          : currentFile;
      status += ` ${truncated}`;
    }

    if (description) {
      status += ` (${description})`;
    }

    // Clear line and write status
    process.stderr.write(`\r${status.padEnd(80)}`);
  }

  finish(result: IngestResult): void {
    // Clear the progress line
    process.stderr.write("\r" + " ".repeat(80) + "\r");

    const duration = (result.duration / 1000).toFixed(1);
    const rate =
      result.duration > 0
        ? (result.scanned / (result.duration / 1000)).toFixed(1)
        : "0";

    console.log(`\n✓ Ingested ${result.scanned} files`);
    console.log(`  • Inserted: ${result.inserted}`);
    console.log(`  • Updated: ${result.updated}`);
    console.log(`  • Unchanged: ${result.unchanged}`);
    if (result.removed > 0) {
      console.log(`  • Removed: ${result.removed}`);
    }
    console.log(`  • Chunks created: ${result.chunksCreated}`);
    console.log(`  • Time: ${duration}s (${rate} files/s)`);

    if (result.errors.length > 0) {
      console.log(`\n⚠️  ${result.errors.length} error(s):`);
      for (const error of result.errors.slice(0, 5)) {
        console.log(`  • ${error.file}: ${error.error}`);
      }
      if (result.errors.length > 5) {
        console.log(`  ... and ${result.errors.length - 5} more`);
      }
    }
  }

  error(message: string): void {
    // Clear the progress line
    process.stderr.write("\r" + " ".repeat(80) + "\r");
    console.error(`\n❌ ${message}`);
  }
}
