/**
 * Convention registry.
 *
 * Format dependence splits into two layers (docs/TDD.md §3):
 *   - The Federal Register XML schema is a published standard → handled in xml.ts.
 *   - Agency drafting conventions are agency-specific → declared here as DATA.
 *
 * Three rules make this structural rather than cosmetic:
 *   1. A convention declares its own preconditions, and the parser refuses to run
 *      without them. Absent legend ⇒ redline unavailable, never approximated.
 *   2. Absence of a convention is a first-class result, not an error (T1 only).
 *   3. Each entry ships with its verification set — see tests/registry.test.ts.
 */

import type { DocumentMeta } from "./types.js";

export interface ParagraphNumberingRule {
  pattern: RegExp;
  /**
   * `<P>` elements that are DIRECT children of `<SUPLINF>`.
   *
   * Verified empirically: this scope excludes footnote paragraphs (`FTNT/P`) and
   * numbered lists inside appendix EXTRACT blocks, both of which otherwise inflate
   * the count. Combined with `monotonicPrefix` it reproduces exact contiguous
   * sequences on all six rule/proposed-rule documents in the verification set.
   */
  scope: "suplinf-direct-P";
  /**
   * Numbering resets when separate opinions (concurrences/dissents) begin. The main
   * body is the monotonic prefix; everything after the first non-increasing number is
   * a separate opinion.
   */
  monotonicPrefix: true;
  completeness: "contiguous-from-1";
}

export interface DeterminationRule {
  /**
   * Applied to TRIMMED heading text.
   *
   * Both relaxations of this fail on real data, and the design-time audit found one of
   * each: *contains*-matching over-counts (Order No. 1920-A has an argument heading
   * "…Adequately Supported Its Determination on Step One of Section 206" that is not a
   * determination block), and anchoring without trimming under-counts (two of Order
   * No. 2023's genuine "Commission Determination " headings carry trailing whitespace).
   */
  headingPattern: RegExp;
}

export interface RedlineRule {
  /** Precondition. No legend in the document ⇒ the tier is unavailable. */
  legendPattern: RegExp;
  /** Additions are italics: <E T="03">…</E>. */
  additionTag: { tag: string; attr: string; value: string };
  /** Deletions are square brackets in the text. */
  deletionMarkup: "square-brackets";
  /**
   * Markup only carries redline meaning inside an appendix that declares the legend.
   * Brackets and italics mean ordinary things elsewhere — Order No. 1920 has 3,158
   * italic tags and no legend; treating them as additions would fabricate 3,158
   * regulatory changes.
   */
  scope: "declaring-appendix-only";
}

export interface AgencyConvention {
  id: string;
  /**
   * Matches by AGENCY, never by document type.
   *
   * An earlier draft narrowed this to `type === "Rule"`. That was wrong: the RM22-14
   * NOPR carries 370 numbered paragraphs that citations must anchor into. Each
   * capability below already declines gracefully via its own precondition, so
   * narrowing the convention would only strip structure from proposed rules.
   */
  matches(meta: DocumentMeta): boolean;
  paragraphNumbering: ParagraphNumberingRule;
  determinations?: DeterminationRule;
  redline?: RedlineRule;
  crossReference?: { pattern: RegExp };
}

export const FERC_RULEMAKING: AgencyConvention = {
  id: "ferc-rulemaking",
  matches: (meta) =>
    /FEDERAL ENERGY REGULATORY COMMISSION/i.test(meta.agency) ||
    meta.agencies.some((a) => /Federal Energy Regulatory Commission/i.test(a)),

  paragraphNumbering: {
    pattern: /^\s*(\d{1,4})\.\s/,
    scope: "suplinf-direct-P",
    monotonicPrefix: true,
    completeness: "contiguous-from-1",
  },

  determinations: {
    headingPattern: /Determination$/,
  },

  redline: {
    legendPattern: /Deletions are in brackets and additions are in italics/i,
    additionTag: { tag: "E", attr: "T", value: "03" },
    deletionMarkup: "square-brackets",
    scope: "declaring-appendix-only",
  },

  crossReference: {
    pattern: /\bsection\s+(\d+(?:\.\d+)*)/gi,
  },
};

const REGISTRY: AgencyConvention[] = [FERC_RULEMAKING];

/** Returns the matching convention, or null when the agency is unrecognised. */
export function findConvention(meta: DocumentMeta): AgencyConvention | null {
  return REGISTRY.find((c) => c.matches(meta)) ?? null;
}

export function allConventions(): readonly AgencyConvention[] {
  return REGISTRY;
}
