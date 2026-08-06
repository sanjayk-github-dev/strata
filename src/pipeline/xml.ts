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

/** Tags whose textual content should not be emitted into the plain text at all. */
const SKIP_CONTENT = new Set(["PRTPAGE"]);

/**
 * Block-level tags. A newline is emitted when they close so that paragraph and heading
 * boundaries survive into the plain text — line structure is load-bearing for the
 * paragraph-numbering regex, which is anchored at start-of-content.
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

    if (skipDepth > 0 || SKIP_CONTENT.has(tag)) skipDepth++;

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
