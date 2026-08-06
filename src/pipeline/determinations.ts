/**
 * Determination block extraction (capability tier T2).
 *
 * This is the *general* branch: it applies to every document that decides something,
 * which is 5 of 5 applicable documents in the verification set, versus 2 of 7 for
 * redline. It is also where most of the product's value lives — the dominant
 * dispositions (clarify, sustain, decline) change no regulatory text at all while being
 * exactly what the reader needs to know.
 *
 * Phase 3 is the deterministic structural layer only: it locates blocks and extracts
 * cross-references. Classifying each block's disposition is a model task and belongs to
 * Phase 6 — blocks emitted here carry `disposition: "unclassified"`.
 */

import { sectionAtOffset } from "./citation.js";
import { findConvention } from "./registry.js";
import type { Determination, ParsedDocument, Section } from "./types.js";

/**
 * Extract section cross-references from block text.
 *
 * The pattern comes from the convention, never hardcoded here. A fresh RegExp is built
 * per call: the convention's pattern carries the `g` flag, and sharing a stateful
 * regex across calls would silently skip matches via a carried-over `lastIndex`.
 */
export function extractCrossRefs(text: string, pattern: RegExp): string[] {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const ref = m[1];
    if (ref) seen.add(ref);
  }
  return [...seen];
}

/**
 * The agency is directing a change to this provision, right here.
 *
 * FERC writes "Accordingly, we modify section 3.1.1.1 of the pro forma LGIP as follows"
 * when it is actually amending text.
 */
const DIRECTIVE = /\b(?:we|commission)\b[^.;]{0,80}?\b(?:modif|revis|amend|add|adopt|delet|remov|replac)/i;

/**
 * The agency is declining, or merely describing what already exists.
 *
 * This is the guard that matters. A determination reading "we decline to adopt the
 * proposal to add new section 3.1.2" mentions section 3.1.2 and changes nothing — joining
 * it to every edit in that section attaches nine unrelated changes to a decision that
 * explicitly rejected them. Likewise "the existing requirements in section 2.3" is
 * context, not an amendment. Both were producing wrong cards on real output.
 */
const DECLINING =
  /\b(?:declin\w*|do(?:es)? not adopt|did not adopt|not persuaded|reject\w*|no(?:t)? (?:necessary|required)|rather than|instead of|existing requirements?|would read|proposed to)\b/i;

/** Split into sentences, crudely but adequately: provision numbers contain periods. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.;:])\s+(?=[A-Z(])/);
}

/**
 * Cross-references the agency is *directing a change to*, as opposed to merely mentioning.
 *
 * A bare "section N" mention is not evidence that this determination changed N. Measured
 * on Order No. 2023: the first assembled card cited §2.3 and §3.1.2, and both mentions
 * were non-directive — one describing existing requirements, one explicitly declining to
 * create the section. Nine unrelated edits were attached to a decision that changed
 * nothing, which is precisely the "attaches a decision to the wrong provision" failure the
 * TDD flags as least visible and most damaging.
 */
export function extractDirectiveRefs(text: string, pattern: RegExp): string[] {
  const out = new Set<string>();
  for (const sentence of sentences(text)) {
    if (!DIRECTIVE.test(sentence)) continue;
    if (DECLINING.test(sentence)) continue;
    for (const ref of extractCrossRefs(sentence, pattern)) out.add(ref);
  }
  return [...out];
}

/**
 * Statutory references are not provision references.
 *
 * FERC cites "section 205" and "section 206" of the Federal Power Act constantly. Those
 * are statutory authority, not pro forma tariff provisions, and joining a determination
 * to LGIP "section 206" would be wrong. Provision references in these procedures are
 * dotted (3.1.1.1) or appear in the operative text; bare two- and three-digit integers
 * in the 200s are overwhelmingly FPA citations.
 *
 * This is a heuristic and is reported as such — see `crossRefStats`.
 */
export function isLikelyProvisionRef(ref: string): boolean {
  if (ref.includes(".")) return true;
  const n = Number(ref);
  // Bare integers: FPA sections 201-206, 219, 309 etc. are statutory, not provisions.
  return Number.isFinite(n) && n < 100;
}

function firstParagraphNumberIn(doc: ParsedDocument, section: Section): number | null {
  for (const p of doc.paragraphs) {
    if (p.span[0] >= section.span[0] && p.span[0] < section.span[1]) return p.number;
  }
  return null;
}

/**
 * Locate every determination block in a document.
 *
 * Returns [] when the T2 precondition does not hold — a proposed rule proposes rather
 * than determines, and that is correct behaviour, not a gap.
 */
export function extractDeterminations(doc: ParsedDocument): Determination[] {
  if (!doc.capabilities.includes("T2")) return [];

  const convention = findConvention(doc.meta);
  const rule = convention?.determinations;
  if (!rule) return [];

  const xref = convention?.crossReference?.pattern;
  const out: Determination[] = [];

  for (const section of doc.sections) {
    const heading = section.headingPath[section.headingPath.length - 1] ?? "";
    // headingPath entries are already normalized (trimmed, whitespace collapsed) —
    // the trim is what makes anchoring correct. See registry.ts.
    if (!rule.headingPattern.test(heading)) continue;

    const body = doc.text.slice(section.span[0], section.span[1]);
    const refs = xref ? extractCrossRefs(body, xref) : [];

    out.push({
      id: section.id,
      headingPath: section.headingPath,
      // Phase 6 replaces this. Never guessed here.
      disposition: "unclassified",
      crossRefs: refs.filter(isLikelyProvisionRef),
      amendedRefs: (xref ? extractDirectiveRefs(body, xref) : []).filter(isLikelyProvisionRef),
      citation: {
        frDocNumber: doc.meta.frDocNumber,
        sectionId: section.id,
        paragraphNumber: firstParagraphNumberIn(doc, section),
        span: [section.span[0], section.span[1]],
        // quote === text.slice(span) by construction, so this always verifies.
        // Phase 8 may strip quotes on the wire and rehydrate from spans; that identity
        // is exactly what verification asserts.
        quote: body,
      },
    });
  }

  return out;
}

export interface CrossRefStats {
  blocks: number;
  withRefs: number;
  /** Share of blocks carrying at least one provision reference. */
  coverage: number;
  totalRefs: number;
  /** References dropped by the statutory-reference heuristic. */
  filteredStatutory: number;
}

/** Measured cross-reference coverage — reported, not assumed (TDD Phase 3 gate). */
export function crossRefStats(doc: ParsedDocument): CrossRefStats {
  const convention = findConvention(doc.meta);
  const xref = convention?.crossReference?.pattern;
  const dets = extractDeterminations(doc);

  let totalRefs = 0;
  let filtered = 0;
  let withRefs = 0;

  for (const d of dets) {
    if (d.crossRefs.length > 0) withRefs++;
    totalRefs += d.crossRefs.length;
    if (xref) {
      const raw = extractCrossRefs(
        doc.text.slice(d.citation.span[0], d.citation.span[1]),
        xref,
      );
      filtered += raw.length - raw.filter(isLikelyProvisionRef).length;
    }
  }

  return {
    blocks: dets.length,
    withRefs,
    coverage: dets.length === 0 ? 0 : withRefs / dets.length,
    totalRefs,
    filteredStatutory: filtered,
  };
}

/** The section a determination block sits in, for display context. */
export function determinationContext(
  doc: ParsedDocument,
  d: Determination,
): Section | undefined {
  return sectionAtOffset(doc, d.citation.span[0]);
}
