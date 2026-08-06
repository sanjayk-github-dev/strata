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
