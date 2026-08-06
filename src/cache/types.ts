/**
 * Cache abstraction.
 *
 * Deployed, this is backed by Postgres; locally it is file-backed, so the pipeline and
 * its tests run with no database at all (docs/TDD.md §2 "Local-first").
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class MemoryCache implements CacheStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}
