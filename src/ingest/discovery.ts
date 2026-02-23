import FastGlob from "fast-glob";
import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { FileDiscoveryOptions, DiscoveredFile } from "./types.js";

const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.cache/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/.env/**",
  "**/coverage/**",
];

/**
 * Discover files matching patterns in a workspace
 */
export async function discoverFiles(
  options: FileDiscoveryOptions
): Promise<DiscoveredFile[]> {
  const { workspacePath, patterns, exclude = DEFAULT_EXCLUDE } = options;

  const absolutePath = resolve(workspacePath);

  // Use fast-glob to find files
  const files = await FastGlob(patterns, {
    cwd: absolutePath,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: exclude,
    absolute: true,
  });

  // Filter out hidden files (dotfiles) at any depth
  const visibleFiles = files.filter((file) => {
    const parts = file.split("/");
    return !parts.some((part) => part.startsWith("."));
  });

  // Get file stats
  const discovered: DiscoveredFile[] = visibleFiles.map((absolutePath) => {
    const stats = statSync(absolutePath);
    return {
      absolutePath,
      relativePath: relative(workspacePath, absolutePath),
      size: stats.size,
      mtime: stats.mtime,
    };
  });

  // Sort by path for deterministic ordering
  discovered.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return discovered;
}
