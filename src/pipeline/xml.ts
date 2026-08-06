/**
 * Federal Register XML → plain text with element spans.
 *
 * The Federal Register XML schema is a published GPO standard covering every federal
 * agency, so depending on it directly is safe. Agency-specific drafting conventions are
 * NOT handled here — they live in the convention registry (docs/TDD.md §3).
 *
 * Design note: spans index into the plain text this module *generates*, not into the
 * raw XML. That keeps citation verification a pure string comparison against
 * `ParsedDocument.text`, with no XML re-parsing at verify time.
 *
 * Why `sax` rather than an object-mapping or DOM parser: the requirement is character
 * offsets into a text projection *we* define — `<PRTPAGE>` vanishes, block elements emit
 * newlines — over content that is heavily mixed (`a<E>b</E>c` must yield "abc" with the
 * element spanning "b"). No library provides that, so the choice is really about which
 * substrate makes it cheapest to build; streaming events win. Object mappers lose mixed
 * content and offsets both, and native libxml bindings are ruled out by the serverless
 * deploy target. Measured at ~400ms per 1.2MB.
 */

import sax from "sax";

export interface ElementSpan {
  tag: string;
  attrs: Record<string, string>;
  /** Tag names of ancestors, outermost first. */
  ancestors: string[];
  span: [number, number];
}

export interface XmlParseResult {
  text: string;
  elements: ElementSpan[];
}

/**
 * Tags whose textual content should not be emitted into the plain text at all.
 *
 * <PRTPAGE P="27123"/> carries a page number that is not part of the prose; emitting it
 * would inject digits mid-sentence and corrupt quotes.
 */
const SKIP_CONTENT = new Set(["PRTPAGE"]);

/**
 * Footnote reference markers, suppressed from body prose only.
 *
 * `<SU>` holds a superscript. In body text it is a footnote *reference* — the small
 * raised number — and emitting it splices a digit into the middle of a sentence:
 *
 *   "...our finding in Order No. 2023 54 that the existing pro forma..."
 *                                    ^^ footnote marker, not prose
 *
 * That is the same problem as PRTPAGE, and it has a direct product cost. A model asked to
 * quote a supporting passage reads through the marker, as a human would, and returns
 * clean prose — which then fails byte-for-byte verification against our own text. Correct
 * answers were being rejected, depressing the grounding rate, which is the most robust
 * trust signal we have. Measured at 1,246 occurrences in body prose in a single document.
 *
 * Inside `<FTNT>` the same tag holds the footnote's own number, which *is* legitimate
 * content there — so the suppression is scoped to body prose.
 */
const FOOTNOTE_MARKER = "SU";

/**
 * Block-level tags. A newline is emitted when they close so that paragraph and heading
 * boundaries survive into the plain text — line structure is load-bearing for the
 * paragraph-numbering regex, which is anchored at start-of-content.
 *
 * This list is hand-curated and is the most plausible source of a future regression: a
 * missing block tag would merge adjacent text and could stop paragraph numbers matching.
 * Guarded at two levels — unit tests in tests/xml.test.ts, and invariant I3 at runtime,
 * since merged paragraphs would break the contiguous 1..N sequence loudly.
 */
const BLOCK = new Set([
  "P",
  "HD",
  "FP",
  "FTNT",
  "NOTE",
  "EXTRACT",
  "GPOTABLE",
  "ROW",
  "SECTNO",
  "SUBJECT",
  "AUTH",
  "STARS",
]);

export function parseFrXml(xml: string): XmlParseResult {
  const parser = sax.parser(true, { trim: false, normalize: false, position: false });

  let text = "";
  const elements: ElementSpan[] = [];
  // Open elements, in document order. Index into `elements` plus its start offset.
  const stack: Array<{ tag: string; index: number }> = [];
  const ancestry: string[] = [];
  let skipDepth = 0;

  parser.onopentag = (node) => {
    const tag = node.name;
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.attributes)) attrs[k] = String(v);

    // Suppress a footnote reference marker only when it interrupts body prose; inside a
    // footnote the same tag carries that footnote's own number, which belongs there.
    const isBodyFootnoteMarker = tag === FOOTNOTE_MARKER && !ancestry.includes("FTNT");
    if (skipDepth > 0 || SKIP_CONTENT.has(tag) || isBodyFootnoteMarker) skipDepth++;

    const index = elements.length;
    elements.push({
      tag,
      attrs,
      ancestors: [...ancestry],
      span: [text.length, text.length],
    });
    stack.push({ tag, index });
    ancestry.push(tag);
  };

  parser.ontext = (chunk) => {
    if (skipDepth > 0) return;
    text += chunk;
  };

  parser.oncdata = (chunk) => {
    if (skipDepth > 0) return;
    text += chunk;
  };

  parser.onclosetag = () => {
    const open = stack.pop();
    ancestry.pop();
    if (!open) return;

    if (skipDepth > 0) skipDepth--;

    if (BLOCK.has(open.tag) && !text.endsWith("\n")) text += "\n";

    const el = elements[open.index];
    if (el) el.span[1] = text.length;
  };

  parser.write(xml).close();
  return { text, elements };
}

/** Collapse internal whitespace for heading comparison. Headings carry stray spacing. */
export function normalizeHeading(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
