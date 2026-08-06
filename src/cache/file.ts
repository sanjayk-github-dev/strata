import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CacheStore } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_DIR = resolve(HERE, "../../data/cache");

/** File-backed cache. Gitignored; contents are always re-fetchable from the FR API. */
export class FileCache implements CacheStore {
  constructor(private readonly dir: string = DEFAULT_CACHE_DIR) {}

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

  async set(key: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(key), value, "utf8");
  }
}
