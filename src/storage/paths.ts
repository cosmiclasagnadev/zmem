import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config/schema.js";

export interface ResolvedStoragePaths {
  baseDir: string;
  workspaceDir: string;
  dbPath: string;
  zvecPath: string;
  workspaceSlug: string;
}

export function resolveModelStorageDir(config: AppConfig): string {
  const configuredBaseDir = process.env.ZMEM_STORAGE_BASE_DIR || config.storage.baseDir;
  const baseDir = configuredBaseDir ? resolve(configuredBaseDir) : defaultStorageBaseDir();
  return join(baseDir, "models");
}

function slugifyWorkspace(workspace: string): string {
  const normalized = workspace
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "default";
}

function defaultStorageBaseDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA
      ? join(process.env.APPDATA, "zmem")
      : join(homedir(), "AppData", "Roaming", "zmem");
  }

  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome && xdgDataHome.trim().length > 0) {
    return join(resolve(xdgDataHome), "zmem");
  }

  return join(homedir(), ".local", "share", "zmem");
}

export function resolveStoragePaths(config: AppConfig, workspace: string): ResolvedStoragePaths {
  const workspaceSlug = slugifyWorkspace(workspace);
  const configuredBaseDir = process.env.ZMEM_STORAGE_BASE_DIR || config.storage.baseDir;
  const baseDir = configuredBaseDir ? resolve(configuredBaseDir) : defaultStorageBaseDir();
  const workspaceDir = join(baseDir, "workspaces", workspaceSlug);

  const dbPath = process.env.ZMEM_DB_PATH
    ? resolve(process.env.ZMEM_DB_PATH)
    : config.storage.dbPath
      ? resolve(config.storage.dbPath)
      : join(workspaceDir, "memory.db");

  const zvecPath = process.env.ZMEM_ZVEC_PATH
    ? resolve(process.env.ZMEM_ZVEC_PATH)
    : config.storage.zvecPath
      ? resolve(config.storage.zvecPath)
      : join(workspaceDir, "vectors");

  return {
    baseDir,
    workspaceDir,
    dbPath,
    zvecPath,
    workspaceSlug,
  };
}
