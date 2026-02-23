interface LoggerConfig {
  verbose: boolean;
  quiet: boolean;
}

let config: LoggerConfig = {
  verbose: false,
  quiet: false,
};

const isDev = process.env.ZMEM_ENV === "development" || process.env.NODE_ENV === "development";

export function initLogger(options?: { verbose?: boolean; quiet?: boolean }): void {
  if (options?.verbose !== undefined) {
    config.verbose = options.verbose;
  } else if (config.verbose === false) {
    config.verbose = isDev;
  }

  if (options?.quiet !== undefined) {
    config.quiet = options.quiet;
  }
}

export function setVerbose(enabled: boolean): void {
  config.verbose = enabled;
}

export function isVerbose(): boolean {
  return config.verbose;
}

export function debug(message: string | (() => string)): void {
  if (!config.verbose) return;
  const msg = typeof message === "function" ? message() : message;
  console.log(`[DEBUG] ${msg}`);
}

export function info(message: string | (() => string)): void {
  if (config.quiet) return;
  if (!config.verbose) return; // info is verbose-only in prod
  const msg = typeof message === "function" ? message() : message;
  console.log(`[INFO] ${msg}`);
}

export function warn(message: string | (() => string)): void {
  if (config.quiet) return;
  const msg = typeof message === "function" ? message() : message;
  console.warn(`[WARN] ${msg}`);
}

export function error(message: string | (() => string)): void {
  const msg = typeof message === "function" ? message() : message;
  console.error(`[ERROR] ${msg}`);
}

export function timing<T>(label: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const elapsed = performance.now() - start;
    if (config.verbose) {
      console.log(`[TIMING] ${label}: ${elapsed.toFixed(2)}ms`);
    }
  }
}

export async function timingAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const elapsed = performance.now() - start;
    if (config.verbose) {
      console.log(`[TIMING] ${label}: ${elapsed.toFixed(2)}ms`);
    }
  }
}
