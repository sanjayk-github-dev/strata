/**
 * Where cached bytes may be written.
 *
 * Local runs write into the repo's `data/cache`, which is gitignored and survives between
 * runs — that is what makes the test suite fast and offline after the first fetch. A
 * serverless deployment cannot: the bundle's filesystem is read-only, so the first
 * `mkdir` throws EROFS and takes the request with it.
 *
 * Resolution is therefore probe-then-fall-back rather than a build-time constant:
 *
 *   1. `STRATA_CACHE_DIR`, when set — an operator saying exactly where.
 *   2. The repo's `data/cache`, when it is writable — the local case.
 *   3. The system temp directory — the serverless case, per-instance and ephemeral.
 *
 * Ephemeral is the right trade for a cache whose contents are always re-fetchable from
 * the Federal Register API. Losing it costs a re-fetch, never correctness.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a writable cache directory, memoised.
 *
 * Memoised because the probe touches the filesystem and this is called on every cache
 * construction — and because a directory that was writable once does not stop being so
 * within a process.
 */
let resolved: string | null = null;

export function writableCacheDir(preferred: string): string {
  if (resolved !== null) return resolved;

  const fromEnv = process.env["STRATA_CACHE_DIR"];
  if (fromEnv && isWritable(fromEnv)) return (resolved = fromEnv);
  if (isWritable(preferred)) return (resolved = preferred);

  // Serverless: /tmp is the one writable path, and it lives only as long as the instance.
  return (resolved = join(tmpdir(), "strata-cache"));
}

/** Test seam — the memo would otherwise leak between cases. */
export function resetCacheDirForTests(): void {
  resolved = null;
}
