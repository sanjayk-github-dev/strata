/**
 * Transparent caching for model calls.
 *
 * Re-analysing the same document should not re-pay for the same judgements. Cache hits
 * are keyed on a hash of the prompt and model, so an identical request replays and a
 * changed prompt misses — the same mechanism the test cassettes use, with recording on by
 * default rather than opt-in.
 *
 * Kept separate from the test cassette directory on purpose: those are committed fixtures
 * pinning known model behaviour, while this is a disposable local cache. Mixing them would
 * let an ordinary run silently rewrite a fixture a test depends on.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writableCacheDir } from "../cache/dir.js";
import { CassetteLlmClient } from "./cassette.js";
import { HttpLlmClient } from "./http.js";
import { resolveLlmConfig } from "./config.js";
import type { LlmClient } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_CACHE_DIR = resolve(HERE, "../../data/cache");

/**
 * Resolved at first use so a read-only deployment falls back to a temp directory rather
 * than failing every model call. Per-instance and ephemeral there, which costs repeat
 * spend on a cold instance but never a failed request.
 */
export function llmCacheDir(): string {
  return join(writableCacheDir(REPO_CACHE_DIR), "llm");
}

/**
 * A cached model client, or null when no provider is configured.
 *
 * Returning null rather than throwing keeps the caller's degradation path simple: no
 * provider means the deterministic tiers run and the app says so.
 */
export function cachedLlmFromEnv(): LlmClient | null {
  const cfg = resolveLlmConfig();
  if (!cfg) return null;
  const live = new HttpLlmClient(cfg);
  return new CassetteLlmClient(live.label, { live, record: true, dir: llmCacheDir() });
}
