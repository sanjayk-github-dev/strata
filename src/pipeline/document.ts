/**
 * Builds the document model: sections, paragraphs, and capability tiers.
 */

import { findConvention } from "./registry.js";
import type {
  CapabilityNote,
  DocumentMeta,
  Paragraph,
  ParsedDocument,
  Section,
  Tier,
} from "./types.js";
import { normalizeHeading, parseFrXml, type ElementSpan } from "./xml.js";

/** Heading level from <HD SOURCE="HD1|HD2|HD3">; HED (preamble labels) is level 0. */
function headingLevel(el: ElementSpan): number | null {
  if (el.tag !== "HD") return null;
  const src = el.attrs["SOURCE"] ?? "";
  const m = src.match(/^HD(\d)$/);
  if (m?.[1]) return Number(m[1]);
  return null;
}

function isAppendixHeading(title: string): boolean {
  return /^Appendix\s+[A-Z0-9]/i.test(title);
}

/**
 * Build sections from heading elements.
 *
 * Section `id` is an ordinal path ("2/5/1") derived from position in the heading
 * hierarchy — never from heading text. Order No. 2023 contains both
 * "Appendix C: Pro forma LGIP" and "Appendix C to LGIA"; text-derived ids would
 * conflate them and produce a citation anchor pointing at the wrong text. The citation
 * verifier cannot catch that (identical wrong path on both sides), so it must be
 * prevented structurally. See docs/TDD.md §3.
 */
function buildSections(text: string, elements: ElementSpan[]): Section[] {
  const headings = elements
    .map((el) => ({ el, level: headingLevel(el) }))
    .filter((h): h is { el: ElementSpan; level: number } => h.level !== null);

  const sections: Section[] = [];
  // Stack of open sections by heading level.
  const open: Array<{ level: number; section: Section; childCount: number }> = [];
  // Sibling counters keyed by parent id.
  const counters = new Map<string, number>();

  const closeTo = (level: number, end: number) => {
    while (open.length > 0 && open[open.length - 1]!.level >= level) {
      open.pop()!.section.span[1] = end;
    }
  };

  let inAppendix = false;

  for (const { el, level } of headings) {
    const title = normalizeHeading(text.slice(el.span[0], el.span[1]));
    if (!title) continue;

    closeTo(level, el.span[0]);

    const parent = open[open.length - 1];
    const parentId = parent?.section.id ?? "";
    const n = (counters.get(parentId) ?? 0) + 1;
    counters.set(parentId, n);

    const id = parentId ? `${parentId}/${n}` : String(n);

    // Top-level appendix headings switch the region for everything that follows.
    if (level === 1 && isAppendixHeading(title)) inAppendix = true;

    const section: Section = {
      id,
      headingPath: [...(parent?.section.headingPath ?? []), title],
      depth: open.length + 1,
      region: inAppendix ? "appendix" : "preamble",
      span: [el.span[0], text.length],
    };
    sections.push(section);
    open.push({ level, section, childCount: 0 });
  }

  return sections;
}

/** Innermost section containing `offset`. Sections are emitted in document order. */
function sectionAt(sections: Section[], offset: number): string {
  let best = "";
  let bestDepth = -1;
  for (const s of sections) {
    if (s.span[0] <= offset && offset < s.span[1] && s.depth > bestDepth) {
      best = s.id;
      bestDepth = s.depth;
    }
  }
  return best;
}

/**
 * Extract agency-numbered paragraphs.
 *
 * Scope and monotonic-prefix behaviour are specified by the convention, not hardcoded
 * here — see registry.ts. Verified across the whole verification set: every document
 * yields a contiguous 1..N body sequence.
 */
function buildParagraphs(
  text: string,
  elements: ElementSpan[],
  sections: Section[],
  pattern: RegExp,
): Paragraph[] {
  // Scope: <P> whose immediate parent is <SUPLINF>. Excludes footnote paragraphs
  // (FTNT/P) and numbered lists nested in appendix EXTRACT blocks.
  const direct = elements.filter(
    (el) => el.tag === "P" && el.ancestors[el.ancestors.length - 1] === "SUPLINF",
  );

  const paragraphs: Paragraph[] = [];
  let last = 0;
  let reset = false;

  for (const el of direct) {
    const body = text.slice(el.span[0], el.span[1]);
    const m = body.match(pattern);
    if (!m?.[1]) continue;

    const num = Number(m[1]);
    // Numbering resets when separate opinions begin.
    if (!reset && num <= last) reset = true;
    if (!reset) last = num;

    paragraphs.push({
      number: num,
      sectionId: sectionAt(sections, el.span[0]),
      span: [el.span[0], el.span[1]],
      isSeparateOpinion: reset,
    });
  }

  return paragraphs;
}

function detectCapabilities(
  text: string,
  elements: ElementSpan[],
  sections: Section[],
  conventionId: string | null,
  determinationPattern: RegExp | undefined,
  legendPattern: RegExp | undefined,
): { capabilities: Tier[]; notes: CapabilityNote[] } {
  const notes: CapabilityNote[] = [];
  const capabilities: Tier[] = ["T1"];

  notes.push({
    tier: "T1",
    available: true,
    reason: "Federal Register metadata is available for every federal document.",
  });

  if (!conventionId) {
    notes.push({
      tier: "T2",
      available: false,
      reason: "No drafting convention registered for this agency.",
    });
    notes.push({
      tier: "T3",
      available: false,
      reason: "No drafting convention registered for this agency.",
    });
    return { capabilities, notes };
  }

  // T2 — determination blocks.
  if (determinationPattern) {
    const count = countDeterminations(text, elements, determinationPattern);
    if (count > 0) {
      capabilities.push("T2");
      notes.push({
        tier: "T2",
        available: true,
        reason: `${count} determination block${count === 1 ? "" : "s"} found.`,
      });
    } else {
      notes.push({
        tier: "T2",
        available: false,
        reason:
          "No determination headings in this document — expected for a proposed rule, " +
          "which proposes rather than decides.",
      });
    }
  }

  // T3 — redline. Precondition: the document declares the markup convention.
  if (legendPattern) {
    const declaring = sections.filter((s) =>
      legendPattern.test(text.slice(s.span[0], s.span[1])),
    );
    if (declaring.length > 0) {
      capabilities.push("T3");
      notes.push({
        tier: "T3",
        available: true,
        reason: `Redline legend declared in ${declaring.length} appendix section(s).`,
      });
    } else {
      notes.push({
        tier: "T3",
        available: false,
        reason:
          "No redline legend declared. Change markup is not parsed for this document; " +
          "italics and brackets are not treated as additions or deletions.",
      });
    }
  }

  return { capabilities, notes };
}

/** Determination headings, matched on trimmed text (see registry.ts for why). */
export function countDeterminations(
  text: string,
  elements: ElementSpan[],
  pattern: RegExp,
): number {
  let n = 0;
  for (const el of elements) {
    if (headingLevel(el) === null) continue;
    const title = normalizeHeading(text.slice(el.span[0], el.span[1]));
    if (pattern.test(title)) n++;
  }
  return n;
}

export function buildDocument(meta: DocumentMeta, xml: string): ParsedDocument {
  const { text, elements } = parseFrXml(xml);
  const convention = findConvention(meta);
  const sections = buildSections(text, elements);

  const paragraphs = convention
    ? buildParagraphs(text, elements, sections, convention.paragraphNumbering.pattern)
    : [];

  const { capabilities, notes } = detectCapabilities(
    text,
    elements,
    sections,
    convention?.id ?? null,
    convention?.determinations?.headingPattern,
    convention?.redline?.legendPattern,
  );

  return {
    meta,
    text,
    sections,
    paragraphs,
    capabilities,
    capabilityNotes: notes,
    conventionId: convention?.id ?? null,
  };
}

/** Main-body paragraphs only — excludes separate opinions. */
export function bodyParagraphs(doc: ParsedDocument): Paragraph[] {
  return doc.paragraphs.filter((p) => !p.isSeparateOpinion);
}
