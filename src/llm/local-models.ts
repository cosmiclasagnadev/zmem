import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "../config/schema.js";
import { resolveModelStorageDir } from "../storage/paths.js";

export interface LocalModelResolution {
  modelUri: string;
  modelsDir: string;
}

export function getQueryExpansionModelResolutions(config: AppConfig): {
  primary: LocalModelResolution;
  fallback: LocalModelResolution;
} {
  const modelsDir = resolveModelStorageDir(config);
  mkdirSync(modelsDir, { recursive: true });

  return {
    primary: {
      modelUri: normalizeModelUri(config.ai.queryExpansion.model),
      modelsDir,
    },
    fallback: {
      modelUri: normalizeModelUri(config.ai.queryExpansion.fallbackModel),
      modelsDir,
    },
  };
}

export function normalizeModelUri(model: string): string {
  if (model.startsWith("hf:")) {
    return model;
  }

  return isAbsolute(model) ? model : resolve(model);
}

export function buildManualPullCommand(modelUri: string, modelsDir: string): string {
  const quotedDir = JSON.stringify(modelsDir);
  const quotedModel = JSON.stringify(modelUri);
  return `npx --no node-llama-cpp pull --dir ${quotedDir} ${quotedModel}`;
}

export function describeModelLocality(modelUri: string, modelsDir: string): {
  kind: "remote_hf" | "local_path";
  displayPath: string;
} {
  if (modelUri.startsWith("hf:")) {
    return {
      kind: "remote_hf",
      displayPath: join(modelsDir, "<downloaded-by-node-llama-cpp>"),
    };
  }

  return {
    kind: "local_path",
    displayPath: modelUri,
  };
}
