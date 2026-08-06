/**
 * Shared test fixtures.
 *
 * Documents are fetched once and cached to data/cache (gitignored). The first run
 * fetches from the Federal Register API; subsequent runs are offline and instant.
 *
 * `data/manifest.yaml` is used here and only here — its role is the verification set,
 * not runtime input (docs/TDD.md §5).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { analyzeDocument, type ParsedDocument } from "../src/pipeline/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(HERE, "../data/manifest.yaml");

export interface ManifestVersion {
  doc_number: string;
  label: string;
  status: "proposed" | "final" | "amended";
  fr_type: string;
  action: string;
  publication_date: string | Date;
  page_length: number;
}

interface Manifest {
  proceedings: Array<{ id: string; role: string; versions: ManifestVersion[] }>;
  status_map: Record<string, string>;
}

export const manifest = yaml.load(readFileSync(MANIFEST, "utf8")) as Manifest;

/** Every document in the verification set, primary proceeding first. */
export const verificationSet: ManifestVersion[] = manifest.proceedings.flatMap(
  (p) => p.versions,
);

const cache = new Map<string, Promise<ParsedDocument>>();

/** Parse a verification-set document, memoised across tests in a run. */
export function doc(frDocNumber: string): Promise<ParsedDocument> {
  let p = cache.get(frDocNumber);
  if (!p) {
    p = analyzeDocument(frDocNumber);
    cache.set(frDocNumber, p);
  }
  return p;
}

/** Shorthands for documents referenced by name in assertions. */
export const DOCS = {
  nopr2214: "2022-13470",
  order2023: "2023-16628",
  order2023A: "2024-06563",
  nopr2117: "2022-08973",
  order1920: "2024-10872",
  order1920A: "2024-27982",
  order1920B: "2025-06941",
} as const;
