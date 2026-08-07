/**
 * Expert feedback persistence.
 *
 * Behind an interface so local development runs with no database — the same reason the
 * analysis cache is (docs/TDD.md §2 "Local-first"). Postgres swaps in for deployment
 * without touching callers.
 *
 * Feedback is append-only. A reviewer changing their mind writes a new record rather than
 * mutating an old one, so the history of what was judged when survives — which is the
 * auditability the PRD's problem statement asks for.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writableCacheDir } from "../cache/dir.js";

export type Verdict = "agree" | "disagree" | "recategorize";

export interface FeedbackRecord {
  id: string;
  frDocNumber: string;
  cardId: string;
  verdict: Verdict;
  note?: string;
  createdAt: string;
}

export interface FeedbackStore {
  add(record: Omit<FeedbackRecord, "id" | "createdAt">): Promise<FeedbackRecord>;
  listFor(frDocNumber: string): Promise<FeedbackRecord[]>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DATA_DIR = resolve(HERE, "../../data");

/**
 * Resolved at first use, and writable by construction.
 *
 * On a read-only deployment this lands in a per-instance temp directory, which means
 * feedback survives the session and not the instance. That is a real limitation and it is
 * stated rather than hidden: `feedbackDurability()` reports it, and the deployment notes
 * say a `DATABASE_URL`-backed store is what makes it durable.
 */
function defaultPath(): string {
  return join(writableCacheDir(REPO_DATA_DIR), "feedback.jsonl");
}

/** Whether feedback written here outlives the process. */
export function feedbackDurability(): "durable" | "ephemeral" {
  return defaultPath().startsWith(REPO_DATA_DIR) ? "durable" : "ephemeral";
}

/** Append-only JSONL. Adequate for local review; Postgres for multi-user. */
export class FileFeedbackStore implements FeedbackStore {
  private readonly explicit: string | undefined;

  constructor(path?: string) {
    this.explicit = path;
  }

  private get path(): string {
    return this.explicit ?? defaultPath();
  }

  async add(input: Omit<FeedbackRecord, "id" | "createdAt">): Promise<FeedbackRecord> {
    const record: FeedbackRecord = {
      ...input,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(record)}\n`, { flag: "a" });
    return record;
  }

  async listFor(frDocNumber: string): Promise<FeedbackRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as FeedbackRecord)
      .filter((r) => r.frDocNumber === frDocNumber);
  }
}

let shared: FeedbackStore | null = null;
export function feedbackStore(): FeedbackStore {
  shared ??= new FileFeedbackStore();
  return shared;
}
