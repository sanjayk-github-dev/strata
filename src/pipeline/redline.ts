/**
 * Redline extraction (capability tier T3).
 *
 * Where an agency publishes its own marked-up amendments, change *detection* is parsing
 * rather than inference — the agency did the diffing and declared the convention in the
 * document. This module reads that markup. It does not infer, and it refuses to run when
 * the convention is not declared.
 *
 * The named risk for this phase is **silent misparsing**: treating italics as additions
 * in a document with no legend would fabricate thousands of regulatory changes, each
 * carrying a citation, inside a product whose premise is verifiability. Every guard here
 * exists for that reason.
 */

import { sectionAtOffset } from "./citation.js";
import { findConvention } from "./registry.js";
import type { Edit, ParsedDocument } from "./types.js";

export interface RedlineRegion {
  /** Offset of the legend declaration that opens the region. */
  legendOffset: number;
  /** [start, end) over which redline markup carries meaning. */
  span: [number, number];
}

export interface RedlineDiagnostics {
  additions: number;
  deletions: number;
  /** Italics inside footnotes — typography (case names, URLs), never additions. */
  italicsInFootnotes: number;
  /** Bracket pairs inside footnotes — citations, not deletions. */
  bracketsInFootnotes: number;
  /**
   * Opening brackets with no matching close inside the region.
   *
   * Reported rather than hidden: invariant I1 says nothing is silently dropped, and a
   * rising count here would mean the parser is losing real deletions.
   */
  unmatchedBrackets: number;
}

export interface RedlineExtraction {
  edits: Edit[];
  /** null when the T3 precondition does not hold. */
  region: RedlineRegion | null;
  diagnostics: RedlineDiagnostics;
  /** Present when the tier is unavailable — the reason, for display. */
  unavailableReason?: string;
}

const EMPTY: RedlineDiagnostics = {
  additions: 0,
  deletions: 0,
  italicsInFootnotes: 0,
  bracketsInFootnotes: 0,
  unmatchedBrackets: 0,
};

/**
 * Locate the region over which redline markup carries meaning.
 *
 * The legend is a note declaring how to read what follows, so the region runs from the
 * first declaration to the end of the document body. Two details matter:
 *
 *   - The region ends at `<SUPLINF>`, not the end of the document. The Federal Register
 *     footer is literally `[FR Doc. 2024-06563 Filed 4-15-24; 8:45 am]` — a bracket pair
 *     that would otherwise be extracted as a deletion.
 *
 *   - The declaration need not be repeated. Order No. 2023-A declares once and applies
 *     the convention across four redlined appendices; Order No. 2023 declares in each of
 *     four. Scoping to the declaring *section* would capture neither, because the XML
 *     marks nested appendices ("Appendix 1 to LGIP") at the same heading level as
 *     document-level ones, closing the parent section immediately.
 */
export function findRedlineRegion(doc: ParsedDocument): RedlineRegion | null {
  const convention = findConvention(doc.meta);
  const legend = convention?.redline?.legendPattern;
  if (!legend) return null;

  const [bodyStart, bodyEnd] = doc.markup.bodySpan;
  const body = doc.text.slice(bodyStart, bodyEnd);
  const re = new RegExp(legend.source, legend.flags.replace(/g/g, ""));
  const found = body.search(re);
  if (found === -1) return null;

  const legendOffset = bodyStart + found;

  /**
   * Stop at the first Commissioner's separate statement.
   *
   * Same reasoning that ends the region at `</SUPLINF>` rather than the document: the
   * convention holds where the agency declared it, and text past that boundary uses
   * brackets and italics for ordinary purposes. Order No. 2023 prints three separate
   * statements *inside* `<SUPLINF>`, after the appendices — 132,000 characters in which
   * emphasis and Latin phrases were being read as regulatory additions.
   */
  const opener = convention?.redline?.separateStatementPattern;
  let end = bodyEnd;
  if (opener) {
    const re = new RegExp(opener.source, opener.flags.replace(/g/g, ""));
    const at = doc.text.slice(legendOffset, bodyEnd).search(re);
    if (at !== -1) end = legendOffset + at;
  }

  return { legendOffset, span: [legendOffset, end] };
}

function inAnyRange(ranges: ReadonlyArray<readonly [number, number]>, offset: number): boolean {
  for (const [a, b] of ranges) if (offset >= a && offset < b) return true;
  return false;
}

/**
 * Extract every discrete edit from redlined regulatory text.
 *
 * Returns an empty extraction, with a reason, when the document does not declare the
 * convention. That is the whole point: absence of a legend makes the capability
 * unavailable, never approximated.
 */
export function extractRedline(doc: ParsedDocument): RedlineExtraction {
  const convention = findConvention(doc.meta);
  const rule = convention?.redline;

  if (!rule) {
    return {
      edits: [],
      region: null,
      diagnostics: { ...EMPTY },
      unavailableReason: "No redline convention registered for this agency.",
    };
  }

  const region = findRedlineRegion(doc);
  if (!region) {
    return {
      edits: [],
      region: null,
      diagnostics: { ...EMPTY },
      unavailableReason:
        "This document does not declare a redline convention. Italics and brackets are " +
        "not interpreted as additions or deletions.",
    };
  }

  const [lo, hi] = region.span;
  const edits: Edit[] = [];
  const diagnostics: RedlineDiagnostics = { ...EMPTY };

  // ---- Additions: <E T="03"> inside the region, excluding footnotes ----
  for (const it of doc.markup.italics) {
    const [a, b] = it.span;
    if (a < lo || a >= hi) continue;
    if (it.inFootnote) {
      diagnostics.italicsInFootnotes++;
      continue;
    }
    const text = doc.text.slice(a, b);
    if (text.trim() === "") continue;
    const edit = makeEdit(doc, "addition", text, a, b);
    if (edit) {
      edits.push(edit);
      diagnostics.additions++;
    }
  }

  // ---- Deletions: [bracketed] text inside the region, excluding footnotes ----
  // No length cap: a 300-character cap was found to truncate real deletions (the longest
  // observed runs to ~2,800 characters).
  const body = doc.text.slice(lo, hi);
  const bracket = /\[([^[\]]*)\]/g;
  let consumedOpens = 0;
  for (const m of body.matchAll(bracket)) {
    const start = lo + m.index;
    const end = start + m[0].length;
    consumedOpens++;
    if (inAnyRange(doc.markup.footnotes, start)) {
      diagnostics.bracketsInFootnotes++;
      continue;
    }
    const inner = m[1] ?? "";
    if (inner.trim() === "") continue;
    const edit = makeEdit(doc, "deletion", inner, start, end);
    if (edit) {
      edits.push(edit);
      diagnostics.deletions++;
    }
  }

  const totalOpens = (body.match(/\[/g) ?? []).length;
  diagnostics.unmatchedBrackets = Math.max(0, totalOpens - consumedOpens);

  edits.sort((x, y) => x.citation.span[0] - y.citation.span[0]);
  return { edits, region, diagnostics };
}

function makeEdit(
  doc: ParsedDocument,
  kind: Edit["kind"],
  text: string,
  start: number,
  end: number,
): Edit | null {
  const section = sectionAtOffset(doc, start);
  if (!section) return null;
  return {
    id: `${kind === "addition" ? "a" : "d"}${start}`,
    sectionId: section.id,
    kind,
    text,
    citation: {
      frDocNumber: doc.meta.frDocNumber,
      sectionId: section.id,
      paragraphNumber: null,
      span: [start, end],
      // quote === text.slice(span) by construction, so this always verifies.
      quote: doc.text.slice(start, end),
    },
    materiality: "undecided",
    // No `decidedBy`: nothing has decided yet. Phase 5 rules run first, then Phase 6.
  };
}

// ---------------------------------------------------------------------------
// Adjacency grouping
// ---------------------------------------------------------------------------

export interface EditGroup {
  edits: Edit[];
  span: [number, number];
}

/**
 * Group edits that form one logical change.
 *
 * A deletion immediately followed by an addition is a *replacement*, and materiality can
 * only be judged on the pair: `[A]` + `a` is a capitalisation fix with no legal effect,
 * while `a[n]` + `non-refundable` changes what a fee is. Phase 5's rules operate on
 * groups for exactly this reason.
 *
 * Adjacency is measured in **non-whitespace** characters, not raw distance. The source
 * carries XML indentation, so `a[n] <E>non-refundable</E>` puts roughly 25 characters of
 * newline and padding between the deletion and the addition that replaces it. A raw
 * distance threshold splits that pair; a whitespace-insensitive one keeps it.
 */
export function groupAdjacentEdits(
  doc: ParsedDocument,
  edits: readonly Edit[],
  maxNonWhitespaceGap = 0,
): EditGroup[] {
  const sorted = [...edits].sort((a, b) => a.citation.span[0] - b.citation.span[0]);
  const groups: EditGroup[] = [];

  for (const edit of sorted) {
    const [a, b] = edit.citation.span;
    const last = groups[groups.length - 1];
    const gap = last ? doc.text.slice(last.span[1], a).trim().length : Infinity;

    if (last && a >= last.span[1] && gap <= maxNonWhitespaceGap) {
      last.edits.push(edit);
      last.span[1] = Math.max(last.span[1], b);
    } else {
      groups.push({ edits: [edit], span: [a, b] });
    }
  }

  return groups;
}

/** A run of source text, labelled by what the redline says happened to it. */
export interface SourceSegment {
  text: string;
  kind: "unchanged" | "addition" | "deletion";
}

/**
 * Split a window of source text into unchanged / added / deleted runs.
 *
 * The source panel existed to let a reviewer check a claim against the document, and it
 * was showing plain text — so additions, which the XML marks with italics and the text
 * projection flattens, were indistinguishable from text that never moved. A reviewer
 * looking at the passage could see *that* it was cited and not *what changed in it*,
 * which is most of what the panel is for.
 *
 * Segmenting from the same edits the briefing was built from is deliberate: if the two
 * ever disagree, the disagreement is visible in the panel rather than hidden behind a
 * second, independent markup pass.
 */
export function segmentSource(
  text: string,
  windowStart: number,
  edits: readonly Edit[],
): SourceSegment[] {
  const windowEnd = windowStart + text.length;
  const spans = edits
    .filter((e) => e.citation.span[0] < windowEnd && e.citation.span[1] > windowStart)
    .map((e) => ({
      start: Math.max(e.citation.span[0], windowStart),
      end: Math.min(e.citation.span[1], windowEnd),
      kind: e.kind,
    }))
    .sort((a, b) => a.start - b.start);

  const out: SourceSegment[] = [];
  let at = windowStart;
  for (const s of spans) {
    // Overlapping edits would otherwise emit a negative-length slice.
    if (s.end <= at) continue;
    if (s.start > at) out.push({ text: text.slice(at - windowStart, s.start - windowStart), kind: "unchanged" });
    out.push({
      text: text.slice(Math.max(s.start, at) - windowStart, s.end - windowStart),
      kind: s.kind,
    });
    at = s.end;
  }
  if (at < windowEnd) out.push({ text: text.slice(at - windowStart), kind: "unchanged" });
  return out.filter((s) => s.text.length > 0);
}
