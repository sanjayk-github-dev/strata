/**
 * Core types for the Strata pipeline.
 *
 * This module — and everything under src/pipeline — must stay free of framework
 * imports (no Next.js, no Vercel). The web app and CLI are thin callers over it.
 * See docs/TDD.md §2 "Local-first".
 */

/** Document-level status, derived deterministically from the Federal Register `action` field. */
export type Status = "proposed" | "final" | "amended";

/**
 * Capability tiers (docs/TDD.md §4). A tier is available only when its structural
 * precondition holds in the document. An unavailable tier is never approximated.
 */
export type Tier = "T1" | "T2" | "T3";

export interface DocumentMeta {
  frDocNumber: string;
  docketIds: string[];
  /** Primary agency, uppercased short name where available (e.g. "FERC"). */
  agency: string;
  agencies: string[];
  title: string;
  publicationDate: string;
  /** Federal Register document type: "Rule" | "Proposed Rule" | "Notice" | … */
  type: string;
  /** e.g. "Order on rehearing and clarification." — the basis for `status`. */
  action: string;
  status: Status;
  pageLength: number | null;
  htmlUrl: string;
  xmlUrl: string;
}

/**
 * A structural section of the document.
 *
 * `id` is an ordinal path through the heading hierarchy ("2/5/1"), NOT derived from
 * heading text. This is deliberate: Order No. 2023 contains both
 * "Appendix C: Pro forma LGIP" and "Appendix C to LGIA", and anchoring a citation on
 * heading text alone would conflate them — the most damaging bug available to this
 * product, and one the citation verifier cannot catch (docs/TDD.md §3).
 */
export interface Section {
  id: string;
  headingPath: string[];
  /** Heading nesting depth, 1-based. */
  depth: number;
  region: "preamble" | "appendix";
  span: [number, number];
}

export interface Paragraph {
  /** Agency paragraph number, or null when unnumbered. */
  number: number | null;
  sectionId: string;
  span: [number, number];
  /**
   * True for paragraphs after the numbering resets — separate opinions
   * (concurrences/dissents) restart at 1 and are not part of the main body sequence.
   */
  isSeparateOpinion: boolean;
}

/** Why a capability is or isn't available — surfaced to the user, never silently dropped. */
export interface CapabilityNote {
  tier: Tier;
  available: boolean;
  reason: string;
}

export interface ParsedDocument {
  meta: DocumentMeta;
  /** Plain text of the document. Every span in this object indexes into this string. */
  text: string;
  sections: Section[];
  paragraphs: Paragraph[];
  capabilities: Tier[];
  capabilityNotes: CapabilityNote[];
  /** Registry entry that matched, or null when the agency is unrecognised (T1 only). */
  conventionId: string | null;
}

/** A resolved user input: either a whole docket or a single document. */
export type ResolvedInput =
  | { kind: "docket"; docketId: string }
  | { kind: "document"; frDocNumber: string };

export class UnsupportedSourceError extends Error {
  constructor(input: string) {
    super(
      `Unsupported source: "${input}". Strata accepts a Federal Register document URL ` +
        `(federalregister.gov/documents/…), a Federal Register document number ` +
        `(e.g. 2024-06563), or an agency docket identifier (e.g. RM22-14).`,
    );
    this.name = "UnsupportedSourceError";
  }
}
