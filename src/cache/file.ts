import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writableCacheDir } from "./dir.js";
import type { CacheStore } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_CACHE_DIR = resolve(HERE, "../../data/cache");

/** Resolved at first use, not at import — see `writableCacheDir`. */
export function defaultCacheDir(): string {
  return writableCacheDir(REPO_CACHE_DIR);
}

/** File-backed cache. Gitignored; contents are always re-fetchable from the FR API. */
export class FileCache implements CacheStore {
  private readonly explicit: string | undefined;

  constructor(dir?: string) {
    this.explicit = dir;
  }

  private get dir(): string {
    return this.explicit ?? defaultCacheDir();
  }

  private path(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
    return join(this.dir, `${safe}.${hash}`);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.path(key), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Write, or carry on without one.
   *
   * A cache that cannot be written is slower, not broken — every value here is
   * re-fetchable. Letting the write throw would turn a read-only filesystem into a failed
   * analysis, which is a much worse answer than a cold cache.
   */
  async set(key: string, value: string): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.path(key), value, "utf8");
    } catch (err) {
      warnOnce(err);
    }
  }
}

let warned = false;
function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[strata] cache is not writable, continuing without it — ${detail}`);
}
