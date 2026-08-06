/**
 * The document's substantive outline.
 *
 * Every federal rulemaking carries the same administrative scaffolding, because most of it
 * is statutorily required: a Paperwork Reduction Act statement, a NEPA analysis, a
 * Regulatory Flexibility Act certification, comment procedures, document availability.
 * That boilerplate is identical in shape across agencies and tells a reader nothing about
 * what is being proposed.
 *
 * Filtering it out — rather than matching on "Proposed Reforms" or any other title —
 * is what makes this generalise. FERC calls its substantive section "Proposed Reforms" in
 * one NOPR and "Regional Transmission Planning" in another; a title match would work on
 * the first and fail on the second. Excluding the parts that are the *same* everywhere
 * leaves the parts that differ, which are exactly the parts worth reading.
 */

import type { ParsedDocument, Section } from "./types.js";

/**
 * Administrative and statutory sections, common to federal rulemakings generally.
 *
 * Anchored to the heading after its numeral so "IV. Information Collection Statement" and
 * "XI. Information Collection Statement" both match regardless of position.
 */
const ADMINISTRATIVE = [
  /^table of contents/i,
  /information collection/i,
  /paperwork reduction/i,
  /environmental analysis/i,
  /environmental assessment/i,
  /regulatory flexibility/i,
  /comment procedures?/i,
  /filing comments/i,
  /document availability/i,
  /congressional review/i,
  /^effective dates?/i,
  /compliance procedures?/i,
  /executive order/i,
  /^signature/i,
  /^list of subjects/i,
];

/** Strip a leading enumerator: "IV. ", "A. ", "3. ". */
function withoutNumeral(title: string): string {
  return title.replace(/^\s*(?:[IVXLC]+|[A-Z]|\d+)[.)]\s*/i, "").trim();
}

/**
 * Signature blocks and stubs.
 *
 * An advance NOPR ends with repeated "Department of Energy" / "Federal Energy Regulatory
 * Commission" headings of a few dozen characters — signature blocks, not content. A size
 * floor removes them without needing to name them.
 */
const MIN_SUBSTANTIVE_CHARS = 2000;

export function isAdministrative(title: string): boolean {
  const bare = withoutNumeral(title);
  return ADMINISTRATIVE.some((re) => re.test(bare));
}

export interface OutlineEntry {
  id: string;
  title: string;
  /** Characters of document under this heading — a proxy for how much is proposed. */
  size: number;
  /** The section's own direct subsections, where it has them. */
  children: Array<{ id: string; title: string }>;
  /** The largest substantive section: usually where the proposals actually live. */
  primary: boolean;
}

/**
 * Substantive top-level sections, with their immediate children.
 *
 * Returns [] when nothing survives filtering, which is the honest answer for a document
 * that is entirely administrative.
 */
export function substantiveOutline(doc: ParsedDocument, limit = 12): OutlineEntry[] {
  /**
   * Where the agency's own text ends and separate opinions begin.
   *
   * Commissioner concurrences and dissents are appended after the body under agency-name
   * headings ("Federal Energy Regulatory Commission"), and they are substantial enough to
   * survive a size floor. They are not part of what the document proposes.
   *
   * Rather than matching those headings, this reuses the boundary the paragraph
   * numbering already establishes: separate opinions restart their numbering at 1, which
   * is how invariant I3 stays true. The same signal that keeps the paragraph sequence
   * honest also marks where the proposal stops.
   */
  const firstSeparateOpinion = doc.paragraphs.find((p) => p.isSeparateOpinion)?.span[0];

  const allTops = doc.sections.filter((s) => s.depth === 1 && s.region === "preamble");

  // The heading of a separate opinion precedes its first numbered paragraph, so the
  // boundary is the start of the section *containing* that paragraph, not the paragraph
  // itself — otherwise the opinion's own heading slips through just ahead of it.
  const bodyEnd =
    firstSeparateOpinion === undefined
      ? doc.text.length
      : (allTops.find(
          (s) => s.span[0] <= firstSeparateOpinion && firstSeparateOpinion < s.span[1],
        )?.span[0] ?? firstSeparateOpinion);

  const tops = allTops.filter((s) => s.span[0] < bodyEnd);

  const kept = tops.filter((s) => {
    const title = s.headingPath[s.headingPath.length - 1] ?? "";
    if (isAdministrative(title)) return false;
    return s.span[1] - s.span[0] >= MIN_SUBSTANTIVE_CHARS;
  });

  const childrenOf = (parent: Section) =>
    doc.sections
      .filter(
        (s) =>
          s.depth === 2 && s.span[0] >= parent.span[0] && s.span[0] < parent.span[1],
      )
      .map((s) => ({ id: s.id, title: s.headingPath[s.headingPath.length - 1] ?? "" }));

  const largest = kept.reduce(
    (best, s) => (s.span[1] - s.span[0] > (best ? best.span[1] - best.span[0] : 0) ? s : best),
    undefined as Section | undefined,
  );

  return kept.slice(0, limit).map((s) => ({
    id: s.id,
    title: s.headingPath[s.headingPath.length - 1] ?? "",
    size: s.span[1] - s.span[0],
    children: childrenOf(s),
    primary: s.id === largest?.id,
  }));
}
