/**
 * Record/replay for model calls.
 *
 * The test suite must be deterministic and offline. A model call is neither, so
 * responses are recorded once against real providers and replayed thereafter, keyed by a
 * hash of the request. This keeps the classification tests honest — they exercise real
 * model output, including its quirks — while remaining reproducible and free to run.
 *
 * Recording requires LLM_RECORD=1 and a configured provider. Replay is the default, and
 * a cassette miss during replay is an error rather than a silent live call: a test that
 * quietly hits the network is a test that fails differently on someone else's machine.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CASSETTE_DIR = resolve(HERE, "../../tests/cassettes");

/** Stable key: identical requests replay identically, changed prompts miss loudly. */
export function cassetteKey(label: string, req: LlmRequest): string {
  const canonical = JSON.stringify({
    label,
    system: req.system,
    user: req.user,
    json: req.json ?? false,
    temperature: req.temperature ?? 0,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export interface CassetteOptions {
  dir?: string;
  /** Live client used only when recording. */
  live?: LlmClient;
  record?: boolean;
}

export class CassetteLlmClient implements LlmClient {
  private readonly dir: string;
  readonly label: string;

  constructor(
    label: string,
    private readonly opts: CassetteOptions = {},
  ) {
    this.label = label;
    this.dir = opts.dir ?? DEFAULT_CASSETTE_DIR;
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = cassetteKey(this.label, req);
    const file = this.path(key);

    if (existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, "utf8")) as { response: LlmResponse };
      return stored.response;
    }

    if (!this.opts.record || !this.opts.live) {
      throw new LlmError(
        `Cassette miss for ${this.label} (${key}).\n` +
          `Replay found no recording, and recording is off. Re-record with:\n` +
          `  LLM_RECORD=1 LLM_API_KEY=… npm run record-cassettes\n` +
          `A prompt change invalidates existing cassettes by design — the key hashes the prompt.`,
      );
    }

    const response = await this.opts.live.complete(req);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ label: this.label, request: req, response }, null, 2)}\n`,
      "utf8",
    );
    return response;
  }
}

/**
 * A client returning canned responses, for testing validation and escalation paths.
 *
 * Needed because some behaviour cannot be recorded from a real provider on demand —
 * notably malformed output, out-of-vocabulary labels, and fabricated quotes, all of which
 * the pipeline must handle without throwing.
 */
export class StubLlmClient implements LlmClient {
  readonly label = "stub";
  private calls = 0;

  constructor(private readonly responses: string[]) {}

  get callCount(): number {
    return this.calls;
  }

  async complete(): Promise<LlmResponse> {
    const text = this.responses[Math.min(this.calls, this.responses.length - 1)] ?? "";
    this.calls++;
    return { text };
  }
}
