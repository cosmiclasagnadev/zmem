import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAppConfig } from "../src/config/loadConfig.js";
import { resolveStoragePaths } from "../src/storage/paths.js";

test("resolveStoragePaths uses XDG-style workspace defaults", () => {
  const originalXdg = process.env.XDG_DATA_HOME;
  const originalBase = process.env.ZMEM_STORAGE_BASE_DIR;
  const originalDb = process.env.ZMEM_DB_PATH;
  const originalZvec = process.env.ZMEM_ZVEC_PATH;

  try {
    process.env.XDG_DATA_HOME = "/tmp/zmem-xdg-home";
    delete process.env.ZMEM_STORAGE_BASE_DIR;
    delete process.env.ZMEM_DB_PATH;
    delete process.env.ZMEM_ZVEC_PATH;

    const config = loadAppConfig("./missing-config.json", { silent: true });
    const paths = resolveStoragePaths(config, "My Workspace/Main");

    assert.equal(paths.baseDir, "/tmp/zmem-xdg-home/zmem");
    assert.equal(paths.workspaceSlug, "my-workspace-main");
    assert.equal(paths.dbPath, "/tmp/zmem-xdg-home/zmem/workspaces/my-workspace-main/memory.db");
    assert.equal(paths.zvecPath, "/tmp/zmem-xdg-home/zmem/workspaces/my-workspace-main/vectors");
  } finally {
    restoreEnv("XDG_DATA_HOME", originalXdg);
    restoreEnv("ZMEM_STORAGE_BASE_DIR", originalBase);
    restoreEnv("ZMEM_DB_PATH", originalDb);
    restoreEnv("ZMEM_ZVEC_PATH", originalZvec);
  }
});

test("resolveStoragePaths prefers explicit env and config overrides", () => {
  const originalBase = process.env.ZMEM_STORAGE_BASE_DIR;
  const originalDb = process.env.ZMEM_DB_PATH;
  const originalZvec = process.env.ZMEM_ZVEC_PATH;

  try {
    process.env.ZMEM_STORAGE_BASE_DIR = "/tmp/env-base";

    const config = loadAppConfig("./missing-config.json", { silent: true });
    config.storage.baseDir = "/tmp/config-base";
    config.storage.dbPath = "/tmp/config-db.sqlite";
    config.storage.zvecPath = "/tmp/config-vectors";

    let paths = resolveStoragePaths(config, "default");
    assert.equal(paths.baseDir, "/tmp/env-base");
    assert.equal(paths.dbPath, "/tmp/config-db.sqlite");
    assert.equal(paths.zvecPath, "/tmp/config-vectors");

    process.env.ZMEM_DB_PATH = "/tmp/env-db.sqlite";
    process.env.ZMEM_ZVEC_PATH = "/tmp/env-vectors";
    paths = resolveStoragePaths(config, "default");
    assert.equal(paths.dbPath, "/tmp/env-db.sqlite");
    assert.equal(paths.zvecPath, "/tmp/env-vectors");
  } finally {
    restoreEnv("ZMEM_STORAGE_BASE_DIR", originalBase);
    restoreEnv("ZMEM_DB_PATH", originalDb);
    restoreEnv("ZMEM_ZVEC_PATH", originalZvec);
  }
});

test("loadAppConfig applies env overrides after config file values", () => {
  const originalProvider = process.env.ZMD_EMBED_PROVIDER;
  const originalBaseDir = process.env.ZMEM_STORAGE_BASE_DIR;
  const dir = mkdtempSync(join(tmpdir(), "zmem-config-merge-"));
  const configPath = join(dir, "config.json");

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        defaults: { retrieval: {} },
        ai: {
          embedding: {
            provider: "mock",
            model: "config-model",
            dimensions: 3,
            batchSize: 2,
            maxTokens: 512,
          },
          rerank: {},
        },
        storage: {
          baseDir: "/tmp/config-storage-base",
        },
      })
    );

    process.env.ZMD_EMBED_PROVIDER = "gemini";
    process.env.ZMEM_STORAGE_BASE_DIR = "/tmp/env-storage-base";

    const config = loadAppConfig(configPath, { silent: true });
    assert.equal(config.ai.embedding.provider, "gemini");
    assert.equal(config.storage.baseDir, "/tmp/env-storage-base");
  } finally {
    restoreEnv("ZMD_EMBED_PROVIDER", originalProvider);
    restoreEnv("ZMEM_STORAGE_BASE_DIR", originalBaseDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
