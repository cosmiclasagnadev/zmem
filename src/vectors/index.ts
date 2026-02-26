import { mkdirSync, existsSync, rmSync } from "node:fs";
import { info, debug } from "../utils/logger.js";

export interface VectorHit {
  id: string;
  distance: number;
  score: number;
  fields: Record<string, unknown>;
}

export interface VectorCollection {
  insert(id: string, embedding: number[], metadata?: Record<string, unknown>): void;
  query(embedding: number[], topK: number, filter?: string): VectorHit[];
  delete(id: string): void;
  close(): void;
}

export interface VectorStore {
  createCollection(name: string, dimensions: number): VectorCollection;
  openCollection(name: string): VectorCollection | null;
  close(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let zvec: any = null;

async function ensureZvec(): Promise<any> {
  if (!zvec) {
    const mod = await import("@zvec/zvec");
    zvec = mod.default || mod;
    const isDev = process.env.ZMEM_ENV === "development" || process.env.NODE_ENV === "development";
    const verbose = isDev || process.argv.includes("--logs=true");
    zvec.ZVecInitialize({
      logType: "console",
      logLevel: verbose ? 1 : 3, // 1=INFO, 2=WARN, 3=ERROR only
    });
  }
  return zvec;
}

export async function initializeVectorStore(config: {
  zvecPath: string;
}): Promise<VectorStore> {
  const z = await ensureZvec();

  const basePath = config.zvecPath;
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true });
  }

  info(() => `[VectorStore] Initialized at: ${basePath}`);

  return {
    createCollection(name: string, dimensions: number): VectorCollection {
      const collectionPath = `${basePath}/${name}`;
      debug(
        () => `[VectorStore] Creating collection "${name}" with ${dimensions} dimensions`
      );

      const vectorField = {
        name: "embedding",
        dataType: z.ZVecDataType.VECTOR_FP32,
        dimension: dimensions,
        indexParams: {
          indexType: z.ZVecIndexType.HNSW,
          metricType: z.ZVecMetricType.COSINE,
          m: 16,
          efConstruction: 128,
        },
      };

      const fields = [
        {
          name: "memory_id",
          dataType: z.ZVecDataType.STRING,
        },
        {
          name: "workspace",
          dataType: z.ZVecDataType.STRING,
          indexParams: {
            indexType: z.ZVecIndexType.INVERT,
          },
        },
        {
          name: "scope",
          dataType: z.ZVecDataType.STRING,
          indexParams: {
            indexType: z.ZVecIndexType.INVERT,
          },
        },
        {
          name: "type",
          dataType: z.ZVecDataType.STRING,
          indexParams: {
            indexType: z.ZVecIndexType.INVERT,
          },
        },
        {
          name: "status",
          dataType: z.ZVecDataType.STRING,
          indexParams: {
            indexType: z.ZVecIndexType.INVERT,
          },
        },
      ];

      const schema = new z.ZVecCollectionSchema({
        name,
        vectors: vectorField,
        fields,
      });

      let collection: ReturnType<typeof z.ZVecOpen>;
      try {
        collection = z.ZVecOpen(collectionPath);
        debug(() => `[VectorStore] Opened existing collection "${name}"`);
      } catch {
        try {
          collection = z.ZVecCreateAndOpen(collectionPath, schema);
          debug(() => `[VectorStore] Created new collection "${name}"`);
        } catch (createError) {
          const message = createError instanceof Error ? createError.message : String(createError);
          if (message.includes("is existed")) {
            rmSync(collectionPath, { recursive: true, force: true });
            collection = z.ZVecCreateAndOpen(collectionPath, schema);
            debug(() => `[VectorStore] Recreated invalid collection path "${name}"`);
          } else {
            throw createError;
          }
        }
      }

      return createVectorCollectionWrapper(z, collection);
    },

    openCollection(name: string): VectorCollection | null {
      const collectionPath = `${basePath}/${name}`;
      try {
        const collection = z.ZVecOpen(collectionPath);
        return createVectorCollectionWrapper(z, collection);
      } catch {
        return null;
      }
    },

    close(): void {
      debug(() => "[VectorStore] Closed");
    },
  };
}

function createVectorCollectionWrapper(
  z: typeof import("@zvec/zvec"),
  collection: ReturnType<typeof import("@zvec/zvec")["ZVecOpen"]>
): VectorCollection {
  return {
    insert(
      id: string,
      embedding: number[],
      metadata?: Record<string, unknown>
    ): void {
      const doc = {
        id,
        vectors: {
          embedding: embedding,
        },
        fields: {
          memory_id: id,
          scope: metadata?.scope || "workspace",
          type: metadata?.type || "fact",
          status: metadata?.status || "active",
          ...metadata,
        },
      };

      collection.upsertSync(doc);
    },

    query(
      embedding: number[],
      topK: number,
      filter?: string
    ): VectorHit[] {
      const queryParams = {
        fieldName: "embedding",
        vector: embedding,
        topk: topK,
        filter: filter,
        outputFields: ["memory_id", "workspace", "scope", "type", "status"],
        params: {
          indexType: z.ZVecIndexType.HNSW,
          ef: 128,
        },
      };

      const results = collection.querySync(queryParams);

      return results.map((doc: any) => ({
        id: doc.fields.memory_id as string,
        distance: 1 - doc.score,
        score: doc.score,
        fields: doc.fields,
      }));
    },

    delete(id: string): void {
      collection.deleteSync(id);
    },

    close(): void {
      collection.closeSync();
    },
  };
}
