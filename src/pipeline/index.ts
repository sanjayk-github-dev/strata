/**
 * Public pipeline API.
 *
 * Zero framework dependencies by design — the web app and CLI are thin callers.
 */

import { FileCache } from "../cache/file.js";
import type { CacheStore } from "../cache/types.js";
import { buildDocument } from "./document.js";
import { enumerateDocket, fetchDocumentMeta, fetchXml, resolveInput } from "./fr-api.js";
import type { DocumentMeta, ParsedDocument } from "./types.js";

export * from "./types.js";
export { bodyParagraphs, buildDocument } from "./document.js";
export { deriveStatus, enumerateDocket, fetchDocumentMeta, resolveInput } from "./fr-api.js";
export { findConvention, FERC_RULEMAKING } from "./registry.js";
export {
  citeParagraph,
  citeSpan,
  collapseWhitespace,
  gateClaims,
  locateQuote,
  sectionAtOffset,
  sectionById,
  verifyCitation,
  type Claim,
  type GateOutcome,
  type LocateOptions,
} from "./citation.js";
export {
  crossRefStats,
  determinationContext,
  extractCrossRefs,
  extractDeterminations,
  isLikelyProvisionRef,
  type CrossRefStats,
} from "./determinations.js";
export {
  extractRedline,
  findRedlineRegion,
  groupAdjacentEdits,
  type EditGroup,
  type RedlineDiagnostics,
  type RedlineExtraction,
  type RedlineRegion,
} from "./redline.js";
export {
  deriveConfidence,
  deriveProvisionStatus,
  requiresEscalation,
  type ConfidenceInputs,
} from "./card.js";

export interface PipelineOptions {
  cache?: CacheStore;
}

/** Fetch a document's XML, using the cache when available. */
export async function loadXml(
  meta: DocumentMeta,
  opts: PipelineOptions = {},
): Promise<string> {
  const cache = opts.cache ?? new FileCache();
  const key = `xml/${meta.frDocNumber}`;
  const hit = await cache.get(key);
  if (hit !== null) return hit;
  const xml = await fetchXml(meta);
  await cache.set(key, xml);
  return xml;
}

/** Fetch and parse a single document into the full document model. */
export async function analyzeDocument(
  frDocNumber: string,
  opts: PipelineOptions = {},
): Promise<ParsedDocument> {
  const meta = await fetchDocumentMeta(frDocNumber);
  const xml = await loadXml(meta, opts);
  return buildDocument(meta, xml);
}

/**
 * Resolve any supported input to the list of documents it refers to.
 * A docket resolves to every published version; a document resolves to itself.
 */
export async function resolveVersions(input: string): Promise<DocumentMeta[]> {
  const resolved = resolveInput(input);
  if (resolved.kind === "docket") return enumerateDocket(resolved.docketId);
  return [await fetchDocumentMeta(resolved.frDocNumber)];
}
