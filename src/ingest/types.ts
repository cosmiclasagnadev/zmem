import type { MemoryType } from "../types/memory.js";

export interface FileDiscoveryOptions {
  workspacePath: string;
  patterns: string[];
  exclude?: string[];
  respectGitignore?: boolean;
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtime: Date;
}

export interface ParsedDocument {
  id: string; // 12-char hex
  title: string;
  content: string;
  contentHash: string;
  frontmatter: {
    title?: string;
    tags?: string[];
    type?: MemoryType;
    date?: string;
    importance?: number;
    [key: string]: unknown;
  };
  source: string; // relative path
  workspace: string;
  wordCount: number;
}

export interface Chunk {
  seq: number;
  pos: number; // character position in original
  tokenCount: number;
  text: string;
}

export interface ChunkingOptions {
  maxTokens: number;
  overlapTokens: number;
  preserveHeadings: boolean;
}

export interface IngestResult {
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  chunksCreated: number;
  errors: Array<{ file: string; error: string }>;
  duration: number;
}

export interface IngestProgress {
  phase: 'scanning' | 'parsing' | 'chunking' | 'embedding' | 'storing' | 'cleanup';
  current: number;
  total: number;
  currentFile?: string;
  description?: string;
}

export type ProgressCallback = (progress: IngestProgress) => void;
