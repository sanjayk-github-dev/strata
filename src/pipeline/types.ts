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
  /** The agency's own summary of the document. Authoritative, and free of our inference. */
  abstract: string | null;
  /**
   * Comment deadline, for a document still open for comment.
   *
   * The PRD names a missed comment deadline as the costliest failure: the record closes
   * and there is no second opportunity to shape the rule. It belongs above the fold.
   */
  commentsCloseOn: string | null;
  effectiveOn: string | null;
  /** The agency's own prose about deadlines, which often names more than one. */
  datesNote: string | null;
  /** Parts of the Code of Federal Regulations this document affects. */
  cfrReferences: string[];
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

/**
 * Structural markup needed by the redline branch, captured during parsing.
 *
 * Compact and purpose-built rather than the whole element tree: redline extraction needs
 * italic spans, footnote spans, and the body bounds, and nothing else.
 */
export interface Markup {
  /** `<E T="03">` spans. Italics inside footnotes are typography, never additions. */
  italics: Array<{ span: [number, number]; inFootnote: boolean }>;
  /** Footnote spans — brackets inside them are citations, not deletions. */
  footnotes: Array<[number, number]>;
  /**
   * Bounds of `<SUPLINF>`, the document body.
   *
   * Excludes the Federal Register footer, which is literally `[FR Doc. 2024-06563 Filed
   * 4-15-24; 8:45 am]` — a bracket pair that would otherwise parse as a deletion.
   */
  bodySpan: [number, number];
}

export interface ParsedDocument {
  meta: DocumentMeta;
  /** Plain text of the document. Every span in this object indexes into this string. */
  text: string;
  sections: Section[];
  paragraphs: Paragraph[];
  markup: Markup;
  capabilities: Tier[];
  capabilityNotes: CapabilityNote[];
  /** Registry entry that matched, or null when the agency is unrecognised (T1 only). */
  conventionId: string | null;
}

// ---------------------------------------------------------------------------
// Citation and claim model (docs/TDD.md §6). Schema frozen in Phase 2 so later
// phases fill fields rather than reshape them.
// ---------------------------------------------------------------------------

/**
 * A verifiable pointer into a source document.
 *
 * `span` and `quote` are deliberately redundant: verification checks they agree.
 * A fabricated quote will not match the text at the span; a fabricated span will not
 * contain the quote. Either inconsistency is a rejection.
 */
export interface Citation {
  frDocNumber: string;
  sectionId: string;
  paragraphNumber: number | null;
  span: [number, number];
  quote: string;
}

/**
 * How closely a quote matched its source.
 *
 * `exact` is byte-identical. `normalized` differs only in whitespace runs — the source
 * text carries newlines and indentation from the XML, so requiring byte-identical
 * quotes from a model would reject faithful quotations. Whitespace collapse cannot
 * change words, so it is safe; nothing beyond it is permitted. There is deliberately
 * no fuzzy tier.
 */
export type MatchKind = "exact" | "normalized";

export type VerificationFailure =
  | "not-found"
  | "ambiguous"
  | "section-mismatch"
  | "span-mismatch"
  | "out-of-bounds"
  | "empty-quote";

export type VerificationResult =
  | { ok: true; match: MatchKind; citation: Citation }
  | { ok: false; reason: VerificationFailure; detail: string; occurrences?: number };

export type Materiality = "material" | "clarifying" | "editorial" | "undecided";

export type Disposition =
  | "affirmed"
  | "clarified"
  | "modified"
  | "set-aside"
  | "sustained"
  | "unclassified";

/**
 * Provision-level draft/final status.
 *
 * Document metadata settles the *document's* status; it says nothing about whether a
 * given provision inside it is settled. A rehearing order is typed `Rule`, yet
 * provisions within it may be affirmed, newly modified, or reopened.
 */
export type ProvisionStatus =
  | "proposed"
  | "adopted"
  | "settled"
  | "reopened"
  | "unknown";

export type Effect =
  | "new"
  | "strengthened"
  | "relaxed"
  | "clarified-no-change"
  | "removed"
  | "unknown";

export type Confidence = "high" | "medium" | "low";

/** A discrete edit extracted from redlined regulatory text (T3 only). */
export interface Edit {
  id: string;
  sectionId: string;
  kind: "addition" | "deletion";
  /** The changed text itself — for a deletion, the bracket contents without brackets. */
  text: string;
  citation: Citation;
  materiality: Materiality;
  /** Absent until something has decided. Phase 4 emits edits as `undecided`. */
  decidedBy?: "rule" | "model";
  ruleId?: string;
}

/** A decision block from the reasoning section (T2 only). */
export interface Determination {
  id: string;
  headingPath: string[];
  disposition: Disposition;
  /** Every provision this block mentions — context for the reader. */
  crossRefs: string[];
  /**
   * Provisions this block directs a change to.
   *
   * Distinct from `crossRefs` on purpose: a mention is not an amendment. "We decline to
   * adopt the proposal to add new section 3.1.2" mentions 3.1.2 and changes nothing.
   * Only these are used to join a determination to redline edits.
   */
  amendedRefs: string[];
  citation: Citation;
}

/** The atomic unit of review. Schema frozen in Phase 2. */
export interface ChangeCard {
  id: string;
  frDocNumber: string;
  title: string;
  /** Empty for a determination-only card. */
  edits: Edit[];
  /** Absent for a redline-only card. */
  determination?: Determination;
  effect: Effect;
  provisionStatus: ProvisionStatus;
  /** Model prose. Present only when its citation verifies. */
  rationale?: string;
  citations: Citation[];
  confidence: Confidence;
  escalated: boolean;
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
