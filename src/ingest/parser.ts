import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import matter from "gray-matter";
import type { ParsedDocument } from "./types.js";
import type { MemoryType } from "../types/memory.js";

/**
 * Parse a markdown file, extracting frontmatter and content
 */
export function parseMarkdown(
  absolutePath: string,
  relativePath: string,
  workspace: string
): ParsedDocument {
  // Read file
  const rawContent = readFileSync(absolutePath, "utf-8");

  // Parse frontmatter
  const parsed = matter(rawContent);
  const frontmatter = parsed.data as ParsedDocument["frontmatter"];

  // Normalize content (strip BOM, normalize line endings)
  const content = parsed.content
    .replace(/^\uFEFF/, "") // Remove BOM
    .replace(/\r\n/g, "\n"); // Normalize to LF

  // Extract title
  const title = extractTitle(content, frontmatter, relativePath);

  // Compute content hash (hash entire raw content including frontmatter)
  const contentHash = hashContent(rawContent);

  // Validate type
  const type = validateType(frontmatter.type);

  // Word count (rough estimate)
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;

  return {
    id: generateId(), // Generate short hex ID for unique identity
    title,
    content,
    contentHash,
    frontmatter: {
      ...frontmatter,
      type,
    },
    source: relativePath,
    workspace,
    wordCount,
  };
}

/**
 * Extract title from document
 * Priority: frontmatter.title > first H1 > first H2 > filename
 */
function extractTitle(
  content: string,
  frontmatter: ParsedDocument["frontmatter"],
  fallbackPath: string
): string {
  // Priority 1: Frontmatter title
  if (frontmatter.title && typeof frontmatter.title === "string") {
    return frontmatter.title.trim();
  }

  // Priority 2: First H1 heading
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    const title = h1Match[1].trim();
    // Skip generic titles like "Notes"
    if (title !== "Notes" && title !== "📝 Notes") {
      return title;
    }
  }

  // Priority 3: First H2 heading
  const h2Match = content.match(/^##\s+(.+)$/m);
  if (h2Match) {
    return h2Match[1].trim();
  }

  // Priority 4: Filename (without extension)
  const filename = fallbackPath.split("/").pop() || fallbackPath;
  return filename.replace(/\.[^/.]+$/, "");
}

/**
 * Validate and normalize memory type
 */
function validateType(type: unknown): MemoryType | undefined {
  const validTypes: MemoryType[] = [
    "fact",
    "decision",
    "preference",
    "event",
    "goal",
    "todo",
  ];

  if (typeof type === "string" && validTypes.includes(type as MemoryType)) {
    return type as MemoryType;
  }

  return undefined;
}

/**
 * Compute SHA-256 hash of content
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function generateId(): string {
  return randomBytes(6).toString("hex");
}
