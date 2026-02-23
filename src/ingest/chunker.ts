import { encode } from "gpt-tokenizer";
import type { Chunk, ChunkingOptions } from "./types.js";

// Default chunking constants (based on QMD)
export const DEFAULT_CHUNK_SIZE_TOKENS = 900;
export const DEFAULT_OVERLAP_TOKENS = Math.floor(DEFAULT_CHUNK_SIZE_TOKENS * 0.15); // 135 tokens

// Break point patterns with priority scores (higher = better break point)
const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/\n#{1}(?!#)/g, 100, "h1"], // H1 headings (highest priority)
  [/\n#{2}(?!#)/g, 90, "h2"], // H2 headings
  [/\n#{3}(?!#)/g, 80, "h3"], // H3 headings
  [/\n```/g, 80, "codeblock"], // Code block boundaries
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60, "hr"], // Horizontal rules
  [/\n\n+/g, 20, "blank"], // Paragraph breaks
  [/\n[-*]\s/g, 5, "list"], // List items
  [/\n\d+\.\s/g, 5, "numlist"], // Numbered lists
  [/\n/g, 1, "newline"], // Any newline (lowest)
];

interface ChunkingResult {
  chunks: Chunk[];
  totalTokens: number;
}

/**
 * Chunk document using token-based sizing with smart boundaries
 */
export function chunkDocument(
  content: string,
  options: Partial<ChunkingOptions> = {}
): ChunkingResult {
  const opts: ChunkingOptions = {
    maxTokens: DEFAULT_CHUNK_SIZE_TOKENS,
    overlapTokens: DEFAULT_OVERLAP_TOKENS,
    preserveHeadings: true,
    ...options,
  };

  // Handle empty content
  if (!content || content.trim().length === 0) {
    return { chunks: [], totalTokens: 0 };
  }

  // Find code fences to avoid splitting inside them
  const codeFences = findCodeFences(content);

  // Find all break points
  const breakPoints = findBreakPoints(content, codeFences);

  // Build chunks
  const chunks: Chunk[] = [];
  let position = 0;
  let seq = 0;
  let totalTokens = 0;

  while (position < content.length) {
    // Find optimal end position for this chunk
    const chunkEnd = findChunkEnd(
      content,
      position,
      opts.maxTokens,
      breakPoints,
      codeFences
    );

    // Safety check: ensure we make progress
    if (chunkEnd <= position) {
      // Force progress by moving forward min(100 chars or to end)
      const forceEnd = Math.min(position + 100, content.length);
      
      // If we're already at the end, break
      if (forceEnd >= content.length) {
        break;
      }
      
      // Extract remaining content as final chunk
      const remainingText = content.slice(position).trim();
      if (remainingText.length > 0) {
        const tokens = encode(remainingText);
        chunks.push({
          seq,
          pos: position,
          tokenCount: tokens.length,
          text: remainingText,
        });
        totalTokens += tokens.length;
      }
      break;
    }

    // Extract chunk text
    const chunkText = content.slice(position, chunkEnd).trim();

    if (chunkText.length > 0) {
      const tokens = encode(chunkText);

      chunks.push({
        seq,
        pos: position,
        tokenCount: tokens.length,
        text: chunkText,
      });

      totalTokens += tokens.length;
      seq++;
    }

    // Move position forward with overlap
    const overlapChars = estimateCharsForTokens(opts.overlapTokens);
    const newPosition = Math.max(
      chunkEnd - overlapChars,
      position + Math.floor((chunkEnd - position) * 0.5) // At least 50% new content
    );

    // Safety: ensure we make at least 1 character of progress
    position = Math.max(newPosition, position + 1);

    // Break if we've reached the end
    if (position >= content.length) {
      break;
    }
  }

  return { chunks, totalTokens };
}

/**
 * Find code fence boundaries (```) to avoid splitting inside code blocks
 */
function findCodeFences(content: string): Array<{ start: number; end: number }> {
  const fences: Array<{ start: number; end: number }> = [];
  const fencePattern = /```[\s\S]*?```/g;

  let match = fencePattern.exec(content);
  while (match !== null) {
    fences.push({
      start: match.index,
      end: match.index + match[0].length,
    });
    match = fencePattern.exec(content);
  }

  return fences;
}

/**
 * Find all potential break points with scores
 */
function findBreakPoints(
  content: string,
  codeFences: Array<{ start: number; end: number }>
): Array<{ position: number; score: number; type: string }> {
  const breakPoints: Array<{ position: number; score: number; type: string }> = [];

  for (const [pattern, score, type] of BREAK_PATTERNS) {
    let match = pattern.exec(content);
    while (match !== null) {
      const position = match.index + match[0].length;

      // Skip if inside a code fence
      if (!isInsideCodeFence(position, codeFences)) {
        breakPoints.push({ position, score, type });
      }

      match = pattern.exec(content);
    }
    pattern.lastIndex = 0; // Reset regex
  }

  // Sort by position
  breakPoints.sort((a, b) => a.position - b.position);

  return breakPoints;
}

/**
 * Check if a position is inside a code fence
 */
function isInsideCodeFence(
  position: number,
  fences: Array<{ start: number; end: number }>
): boolean {
  return fences.some((fence) => position > fence.start && position < fence.end);
}

/**
 * Find optimal end position for a chunk
 */
function findChunkEnd(
  content: string,
  startPos: number,
  maxTokens: number,
  breakPoints: Array<{ position: number; score: number; type: string }>,
  codeFences: Array<{ start: number; end: number }>
): number {
  const maxChars = estimateCharsForTokens(maxTokens);
  const targetEnd = Math.min(startPos + maxChars, content.length);

  // If we're at the end, just return
  if (targetEnd >= content.length) {
    return content.length;
  }

  // Find break points within range
  const candidates = breakPoints.filter(
    (bp) => bp.position > startPos && bp.position <= targetEnd
  );

  if (candidates.length === 0) {
    // No good break point found, use target end
    return targetEnd;
  }

  // Find best break point using distance-weighted scoring
  let bestPoint = candidates[0];
  let bestScore = -Infinity;

  for (const point of candidates) {
    const distance = Math.abs(point.position - targetEnd);
    const distanceFactor = 1 - Math.pow(distance / maxChars, 2); // Quadratic decay
    const score = point.score * distanceFactor;

    if (score > bestScore) {
      bestScore = score;
      bestPoint = point;
    }
  }

  return bestPoint.position;
}

/**
 * Rough estimate: tokens ≈ chars / 4
 */
function estimateCharsForTokens(tokens: number): number {
  return tokens * 4;
}
